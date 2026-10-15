import {
  DEFAULT_CONFIG,
  createSession,
  answerSession,
  refreshSession,
  parseCallbackData,
  renderQuestion,
  validateConfig,
  validateContentPack,
} from "./quiz.js";
import { apiError } from "./api-error.js";
import type {
  BotApi,
  Repository,
  Session,
  JoinRequest,
  Context,
  CallbackQuery,
  Message,
} from "../types.js";
import { t, detectLanguage } from "./i18n.js";
import { ADMIN_TARGET_TTL_MS } from "./admin-target.js";
import { nextDueAt } from "./schedule.js";
import {
  type BlocklistMatcher,
  type SpamSettings,
  casListed,
  detectSpam,
  loadBlocklist,
  spamSettings,
} from "./spam.js";

const pending = (s: Session) => ["approve_pending", "decline_pending"].includes(s.status);
/** How long after a request an approval still counts as "recent" for /start. */
const RECENT_APPROVAL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_LEASE_MS = 60_000;
const DEFAULT_RETRY_MS = 5_000;
// Keep each scheduled invocation small; at a one-minute cadence, the ideal drain is 3 items/minute.
const MAINTENANCE_BATCH_LIMIT = 3;

function cleanupDue(session: Session, at: number): boolean {
  return (
    (pending(session) || session.status === "approved" || session.status === "declined") &&
    (!pending(session) || (session.effectLeaseUntil ?? 0) <= at) &&
    session.expiresAt <= at &&
    session.messageId !== null &&
    session.messageDeletedAt === undefined &&
    (session.cleanupRetryAt ?? 0) <= at &&
    (session.cleanupLeaseUntil ?? 0) <= at
  );
}

/**
 * Run a moderation call whose permanent refusals (missing rights, vanished message,
 * removed bot) cannot succeed on retry; rate limits, server and network errors are
 * rethrown so the webhook fails and Telegram redelivers the update.
 */
async function moderationCall(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (caught) {
    const { code } = apiError(caught);
    if (code !== 400 && code !== 403) throw caught;
  }
}

function groupChat(message: Message): boolean {
  return message.chat.type === "group" || message.chat.type === "supergroup";
}

function alreadyDeleted(error: unknown): boolean {
  const details = apiError(error);
  return details.code === 400 && /message to delete not found/i.test(details.description ?? "");
}

/** Inject cloud dependencies for local verification. All timestamps are milliseconds. */
export function createService({
  api,
  repository,
  now = Date.now,
  random = Math.random,
  defaultDeleteJoinMessages = false,
  spamDefaults,
  blocklist = () => loadBlocklist((id) => repository.getBlocklist(id)),
  casCheck = (userId) => casListed(userId),
}: {
  api: BotApi;
  repository: Repository;
  now?: () => number;
  random?: () => number;
  /** Used for groups that have not set deleteJoinMessages themselves. */
  defaultDeleteJoinMessages?: boolean;
  /** Spam filter settings for groups that have not set their own. */
  spamDefaults?: SpamSettings;
  blocklist?: () => Promise<BlocklistMatcher | null>;
  casCheck?: (userId: number) => Promise<boolean>;
}) {
  async function display(session: Session, privateChatId?: number) {
    const latest = await repository.getSession(session.key);
    if (!latest || latest.nonce !== session.nonce) return;
    session = latest;
    // A replacement message must not race the completion CAS of a leased API action.
    if (pending(session) && (session.effectLeaseUntil ?? 0) > now()) {
      if (privateChatId !== undefined) {
        await api.sendMessage({
          chat_id: privateChatId,
          text: t(session.language, "pending", { title: session.title }),
        });
      }
      return;
    }
    const expired = session.expiresAt <= now();
    const canShowQuiz =
      session.status === "active" && !expired && session.messageDeletedAt === undefined;
    const body = canShowQuiz
      ? renderQuestion(session)
      : {
          text:
            t(
              session.language,
              session.status === "approved"
                ? "approved"
                : session.status === "declined"
                  ? "declined"
                  : "pending",
              { title: session.title },
            ) +
            (session.blockedUntil > now()
              ? "\n" +
                t(session.language, "cooldown", {
                  seconds: Math.ceil((session.blockedUntil - now()) / 1000),
                })
              : ""),
          reply_markup: { inline_keyboard: [] },
        };
    const chatId = privateChatId ?? session.userChatId;
    // A deleted or expired validation message must never be recreated as a quiz.
    if (session.messageDeletedAt !== undefined) {
      if (privateChatId !== undefined) await api.sendMessage({ chat_id: chatId, ...body });
      return;
    }
    if (session.messageId && chatId === session.userChatId) {
      try {
        await api.editMessageText({ chat_id: chatId, message_id: session.messageId, ...body });
        return;
      } catch (caught) {
        const error = apiError(caught);
        if (error.code === 400 && /message is not modified/i.test(error.description ?? "")) return;
        if (
          error.code !== 400 ||
          !/message to edit not found|message can't be edited/i.test(error.description ?? "")
        )
          throw caught;
      }
    }
    if (expired) {
      if (privateChatId !== undefined) await api.sendMessage({ chat_id: chatId, ...body });
      return;
    }
    const sent = await api.sendMessage({ chat_id: chatId, ...body });
    await repository.casSession(session, {
      ...session,
      userChatId: chatId,
      messageId: sent.message_id,
    });
  }

  async function requiredSession(key: string): Promise<Session> {
    const session = await repository.getSession(key);
    if (!session) throw new Error("Session disappeared");
    return session;
  }

  async function settle(session: Session): Promise<Session> {
    // Legacy or corrupt intents must never approve without this flow's consent.
    if (
      session.status === "approve_pending" &&
      (session.formatVersion !== 3 ||
        !session.rules ||
        session.rulesAcceptedVersion !== session.rules.version ||
        typeof session.rulesAcceptedAt !== "number" ||
        !Number.isFinite(session.rulesAcceptedAt) ||
        session.rulesAcceptedAt < session.requestDate * 1000 ||
        session.rulesAcceptedAt >= session.expiresAt)
    ) {
      const rejected: Session = {
        ...session,
        status: "decline_pending",
        effectLeaseUntil: 0,
        blockedUntil: now() + session.cooldownSeconds * 1000,
      };
      if (await repository.casSession(session, rejected)) session = rejected;
      else return requiredSession(session.key);
    }
    if (!pending(session) || (session.effectLeaseUntil ?? 0) > now()) return session;
    const leased = { ...session, effectLeaseUntil: now() + 60_000 };
    if (!(await repository.casSession(session, leased))) return requiredSession(session.key);
    const approve = leased.status === "approve_pending";
    try {
      await api[approve ? "approveChatJoinRequest" : "declineChatJoinRequest"]({
        chat_id: leased.groupId,
        user_id: leased.userId,
      });
    } catch (caught) {
      const error = apiError(caught);
      const retrySeconds = Number(error.parameters?.retry_after);
      await repository.casSession(leased, {
        ...leased,
        effectLeaseUntil:
          now() + (Number.isFinite(retrySeconds) ? Math.max(1, retrySeconds) * 1000 : 5000),
        lastApiErrorCode: error.code ?? null,
      });
      throw caught;
    }
    const completed: Session = {
      ...leased,
      status: approve ? "approved" : "declined",
      effectLeaseUntil: 0,
    };
    if (await repository.casSession(leased, completed)) return completed;
    return requiredSession(session.key);
  }

  async function expire(session: Session): Promise<Session> {
    const unconsumed = session.status === "active" || session.status === "awaiting_rules";
    if (!unconsumed || (session.formatVersion === 3 && session.rules && session.expiresAt > now()))
      return session;
    const next: Session = {
      ...session,
      status: "decline_pending",
      blockedUntil: now() + session.cooldownSeconds * 1000,
    };
    if (await repository.casSession(session, next)) return next;
    return requiredSession(session.key);
  }

  /** True while a freshly read row is still the validation message `candidate` selected. */
  function sameMessage(row: Session, candidate: Session, messageId: number): boolean {
    return (
      row.nonce === candidate.nonce &&
      row.messageId === messageId &&
      row.userChatId === candidate.userChatId
    );
  }

  async function cleanupMessage(session: Session, candidate: Session): Promise<void> {
    const messageId = candidate.messageId;
    if (
      messageId === null ||
      candidate.nonce !== session.nonce ||
      candidate.messageId !== session.messageId ||
      candidate.userChatId !== session.userChatId
    )
      return;

    let current = await repository.getSession(session.key);
    if (
      !current ||
      !sameMessage(current, candidate, messageId) ||
      current.revision !== session.revision ||
      !cleanupDue(current, now())
    )
      return;

    const leaseUntil = now() + CLEANUP_LEASE_MS;
    const previousEffectLease = current.effectLeaseUntil;
    const leased: Session = {
      ...current,
      cleanupLeaseUntil: leaseUntil,
      // Keep decision calls out of the deletion window so their completion CAS
      // cannot be invalidated by unrelated cleanup metadata writes.
      effectLeaseUntil: pending(current) ? leaseUntil : previousEffectLease,
    };
    if (!(await repository.casSession(current, leased))) return;

    const leaseRevision = leased.revision;
    current = await repository.getSession(session.key);
    if (
      !current ||
      !sameMessage(current, candidate, messageId) ||
      current.revision !== leaseRevision ||
      current.cleanupLeaseUntil !== leaseUntil ||
      current.messageDeletedAt !== undefined ||
      now() >= leaseUntil
    )
      return;

    const recordRetry = async (caught: unknown) => {
      const details = apiError(caught);
      const retrySeconds = Number(details.parameters?.retry_after);
      const retryAt =
        now() +
        (Number.isFinite(retrySeconds) ? Math.max(1, retrySeconds) * 1000 : DEFAULT_RETRY_MS);
      const latest = await repository.getSession(session.key);
      if (
        !latest ||
        !sameMessage(latest, candidate, messageId) ||
        latest.revision !== leaseRevision ||
        latest.cleanupLeaseUntil !== leaseUntil
      )
        return;
      await repository.casSession(latest, {
        ...latest,
        cleanupLeaseUntil: 0,
        cleanupRetryAt: retryAt,
        effectLeaseUntil: previousEffectLease,
      });
    };

    try {
      const deleted = await api.deleteMessage({
        chat_id: candidate.userChatId,
        message_id: messageId,
      });
      if (!deleted) throw new Error("Message deletion was not confirmed");
    } catch (caught) {
      if (!alreadyDeleted(caught)) {
        await recordRetry(caught);
        console.warn("Cannot delete expired validation message", apiError(caught).code);
        return;
      }
    }

    const latest = await repository.getSession(session.key);
    if (
      !latest ||
      !sameMessage(latest, candidate, messageId) ||
      latest.revision !== leaseRevision ||
      latest.cleanupLeaseUntil !== leaseUntil
    )
      return;
    await repository.casSession(latest, {
      ...latest,
      messageDeletedAt: now(),
      cleanupLeaseUntil: 0,
      effectLeaseUntil: previousEffectLease,
    });
  }

  /** Advance one session whose work is due: expire, delete the prompt, settle a decision. */
  async function processSession(candidate: Session): Promise<void> {
    let session = await repository.getSession(candidate.key);
    if (!session || session.nonce !== candidate.nonce || session.revision !== candidate.revision)
      return;

    session = await expire(session);
    if (session.nonce !== candidate.nonce) return;
    // Deleting the expired prompt must not depend on a decision API call
    // succeeding. The cleanup lease also fences concurrent decision work.
    await cleanupMessage(session, candidate);
    session = await requiredSession(candidate.key);
    if (session.nonce !== candidate.nonce) return;
    if (pending(session)) await settle(session);
  }

  async function maintenance(): Promise<void> {
    const at = now();
    const candidates = await repository.listActionableSessions(at, MAINTENANCE_BATCH_LIMIT);
    for (const candidate of candidates) {
      try {
        await processSession(candidate);
      } catch (caught) {
        console.warn("Maintenance item failed", apiError(caught).code);
      }
    }
    // Expired group selections are already ignored on read; this only keeps the table small.
    try {
      await repository.pruneAdminTargets(at - ADMIN_TARGET_TTL_MS);
    } catch {
      console.warn("Admin target cleanup failed");
    }
  }

  /**
   * Run one session's due work for its timer and return when it is next due (null when done).
   * Does nothing early, so a stale alarm is harmless. A failing call is logged and left to its
   * persisted retry time; only a failure to read D1 propagates so the alarm is retried.
   */
  async function maintainSession(key: string): Promise<number | null> {
    const found = await repository.getSession(key);
    if (!found) return null;
    const due = nextDueAt(found);
    if (due === null || due > now()) return due;
    try {
      await processSession(found);
    } catch (caught) {
      console.warn("Session timer item failed", apiError(caught).code);
    }
    const latest = await repository.getSession(key);
    return latest ? nextDueAt(latest) : null;
  }

  async function join(request: JoinRequest, ctx: Context = {}) {
    if (request.query_id) {
      await api.answerChatJoinRequestQuery({
        chat_join_request_query_id: request.query_id,
        result: "queue",
      });
      console.warn("Join request query queued; configure ordinary join approval mode.");
      return;
    }
    const config = (await repository.getConfig(request.chat.id)) ?? DEFAULT_CONFIG;
    if (!config.enabled || validateConfig(config)) return;
    const content = await repository.getContentPack(config.contentId);
    if (!content || validateContentPack(content)) return;
    const key = `${request.chat.id}:${request.from.id}`;
    const requestId = String(ctx.update?.update_id ?? request.date);
    let existing = await repository.getSession(key);
    if (existing && request.date < existing.requestDate) return;
    if (
      existing &&
      request.date === existing.requestDate &&
      Number(requestId) < Number(existing.requestId)
    )
      return;
    if (existing && existing.requestId === requestId) {
      existing = await settle(await expire(existing));
      await display(existing);
      return;
    }
    // Do not replace a durable external decision with another request.
    if (existing && pending(existing)) {
      await settle(existing);
      return;
    }
    const session = createSession({
      key,
      groupId: request.chat.id,
      userId: request.from.id,
      userChatId: request.user_chat_id,
      requestDate: request.date,
      requestId,
      title: request.chat.title ?? "群组",
      config,
      content,
      now: now(),
      random,
      nonce: `${Math.abs(request.chat.id).toString(36).padStart(11, "0")}${request.date.toString(36)}${Math.floor(random() * 0x1000000).toString(36)}`,
    });
    session.expiresAt = request.date * 1000 + config.timeoutSeconds * 1000;
    if (session.expiresAt <= now()) {
      session.status = "decline_pending";
      session.blockedUntil = now() + config.cooldownSeconds * 1000;
    }
    if (existing && existing.blockedUntil > request.date * 1000) {
      session.status = "decline_pending";
      session.blockedUntil = existing.blockedUntil;
    }
    const saved = existing
      ? await repository.casSession(existing, session)
      : await repository.createSession(session);
    if (!saved) return;
    if (pending(session)) {
      // The request chat authorization ends after rejection. Notification is best effort.
      try {
        await display(session);
      } catch (error) {
        console.warn("Cannot notify applicant", apiError(error).code);
      }
      await settle(await requiredSession(key));
    } else await display(session);
  }

  async function callback(query: CallbackQuery) {
    const data = parseCallbackData(query.data);
    if (!data || !query.from || query.message?.chat?.type !== "private") {
      await api.answerCallbackQuery({
        callback_query_id: query.id,
        text: t(detectLanguage(query.from?.language_code), "invalidButton"),
      });
      return;
    }
    const sessions = await repository.listSessionsForUser(query.from.id);
    let session = sessions.find((s) => s.nonce === data.nonce);
    if (
      !session ||
      query.message!.message_id !== session.messageId ||
      query.message!.chat.id !== session.userChatId
    ) {
      await api.answerCallbackQuery({
        callback_query_id: query.id,
        text: t(detectLanguage(query.from.language_code), "updatedButton"),
      });
      return;
    }
    session = await expire(session);
    const identity = { userId: query.from.id, nonce: data.nonce, index: data.index, now: now() };
    const result =
      data.kind === "answer"
        ? answerSession(session, { ...identity, option: data.option })
        : refreshSession(session, identity);
    if (result.kind !== "ignored") {
      if (await repository.casSession(session, result.session)) session = result.session;
      else session = await requiredSession(session.key);
    }
    await api.answerCallbackQuery({
      callback_query_id: query.id,
      text: t(session.language, result.kind === "ignored" ? "staleButton" : "recorded"),
    });
    session = await settle(session);
    await display(session);
  }

  /**
   * Handle a "joined the group" service message: rejoining members become new again for
   * the spam filter, and the notice is deleted when the group or Worker default opts in.
   */
  async function joinNotice(message: Message) {
    if (!groupChat(message)) return;
    await repository.resetMembers(
      message.chat.id,
      (message.new_chat_members ?? []).map((member) => member.id),
    );
    const config = await repository.getConfig(message.chat.id);
    if (!(config?.deleteJoinMessages ?? defaultDeleteJoinMessages)) return;
    await moderationCall(() =>
      api.deleteMessage({ chat_id: message.chat.id, message_id: message.message_id }),
    );
  }

  /**
   * Apply the group's spam filter. Returns true when the message was removed.
   * Edits are inspected but neither count as new messages nor trigger CAS lookups.
   */
  async function moderate(message: Message, { edited = false } = {}): Promise<boolean> {
    if (!groupChat(message) || message.is_automatic_forward) return false;
    // Anonymous administrators post as the group itself.
    if (message.sender_chat?.id === message.chat.id) return false;
    const senderId = message.sender_chat?.id ?? message.from?.id;
    if (senderId === undefined) return false;
    const settings = spamSettings(await repository.getConfig(message.chat.id), spamDefaults);
    if (settings.mode === "off") return false;

    const chatId = message.chat.id;
    const seen = await repository.getMemberMessages(chatId, senderId);
    if (settings.mode === "new" && seen >= settings.firstMessages) return false;
    let verdict = detectSpam(message, await blocklist());
    if (!verdict && settings.cas && !edited && seen === 0 && !message.sender_chat) {
      if (await casCheck(senderId)) verdict = { action: "ban", reason: "cas" };
    }
    if (!verdict) {
      // "all" mode only needs to remember that the first-message CAS lookup happened.
      const trackUntil = settings.mode === "new" ? settings.firstMessages : 1;
      if (!edited && seen < trackUntil)
        await repository.recordMemberMessage(chatId, senderId, now());
      return false;
    }

    // Admin status is only looked up after a match to keep clean traffic API-free.
    if (!message.sender_chat) {
      const member = await api.getChatMember({ chat_id: chatId, user_id: senderId });
      if (member.status === "creator" || member.status === "administrator") return false;
    }
    await moderationCall(() =>
      api.deleteMessage({ chat_id: chatId, message_id: message.message_id }),
    );
    if (verdict.action === "ban" && settings.ban) {
      await moderationCall(() =>
        message.sender_chat
          ? api.banChatSenderChat({ chat_id: chatId, sender_chat_id: senderId })
          : api.banChatMember({ chat_id: chatId, user_id: senderId }),
      );
    }
    return true;
  }

  /** Show the applicant's current verification step; false when there is nothing to show. */
  async function start(message: Message): Promise<boolean> {
    if (message.chat?.type !== "private" || !message.from) return false;
    const sessions = await repository.listSessionsForUser(message.from.id);
    const relevant = sessions.filter(
      (s) =>
        s.status === "active" ||
        s.status === "awaiting_rules" ||
        pending(s) ||
        s.blockedUntil > now(),
    );
    if (!relevant.length) {
      // Sessions are newest first, so this is the most recent approval.
      const approved = sessions.find(
        (s) => s.status === "approved" && now() - s.requestDate * 1000 <= RECENT_APPROVAL_MS,
      );
      if (!approved) return false;
      await api.sendMessage({
        chat_id: message.chat.id,
        text: t(detectLanguage(message.from.language_code), "startRecentlyApproved", {
          title: approved.title,
        }),
      });
      return true;
    }
    for (const item of relevant) {
      const session = await settle(await expire(item));
      await display(session, message.chat.id);
    }
    return true;
  }
  return { join, callback, start, joinNotice, moderate, maintenance, maintainSession };
}
