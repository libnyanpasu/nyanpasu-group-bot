import type {
  BotApi,
  CallbackQuery,
  Chat,
  Config,
  ContentPack,
  Language,
  Member,
  Message,
  MessageBody,
  Repository,
  SendBody,
  User,
} from "../types.js";
import { adminMessage, type AdminMessageKey } from "./admin-i18n.js";
import {
  ADMIN_TARGET_TTL_MS,
  GROUP_PICKER_REQUEST_ID,
  decodeGroupRef,
  encodeGroupRef,
} from "./admin-target.js";
import {
  type BotPermissions,
  hintsText,
  cycleSetting,
  nextSteps,
  panelKeyboard,
  parsePanelCallback,
} from "./admin-panel.js";
import { apiError } from "./api-error.js";
import { t } from "./i18n.js";
import { DEFAULT_CONFIG, validateConfig, validateContentPack } from "./quiz.js";
import {
  DEFAULT_BLOCKLIST_ID,
  DEFAULT_SPAM_SETTINGS,
  type SpamSettings,
  spamSettings,
  validateBlocklist,
} from "./spam.js";

/** Commands the admin module handles; grammY's `bot.command` routes them and parses arguments. */
export const ADMIN_COMMANDS = [
  "verify_help",
  "verify_groups",
  "verify_status",
  "verify_enable",
  "verify_disable",
  "verify_config",
  "verify_invite",
] as const;
const CONFIG_KEYS = new Set(["timeoutSeconds", "cooldownSeconds", "spamFirstMessages"]);
const SPAM_KEYS = ["spamMode", "spamFirstMessages", "spamBan", "spamCas"] as const;

/** A routed admin command: its name without the slash and the trimmed text after it. */
export interface AdminCommand {
  name: (typeof ADMIN_COMMANDS)[number];
  args: string;
}

type AdminApi = Pick<
  BotApi,
  | "sendMessage"
  | "editMessageText"
  | "answerCallbackQuery"
  | "getMe"
  | "getChat"
  | "getChatMember"
  | "createChatInviteLink"
>;

/** A reason an action cannot proceed, as the message key and values to tell the administrator. */
type Blocker = { key: AdminMessageKey; values?: Record<string, string | number> };
interface AdminOptions {
  api: AdminApi;
  repository: Pick<
    Repository,
    | "getConfig"
    | "saveConfig"
    | "getContentPack"
    | "getBlocklist"
    | "getAdminTarget"
    | "setAdminTarget"
    | "clearAdminTarget"
  >;
  now?: () => number;
  /** Used for groups that have not set deleteJoinMessages themselves. */
  defaultDeleteJoinMessages?: boolean;
  /** Spam filter settings for groups that have not set their own. */
  spamDefaults?: SpamSettings;
}

function userLanguage(user: User | undefined, fallback: Language): Language {
  const code = user?.language_code?.toLowerCase() ?? "";
  if (code.startsWith("en")) return "en";
  if (code.startsWith("zh")) return "cn";
  return fallback;
}

function groupLanguage(config: Config | null): Language {
  return config?.language === "en" ? "en" : "cn";
}

function isAdmin(status: string, canInviteUsers?: boolean): boolean {
  return status === "creator" || (status === "administrator" && canInviteUsers === true);
}

function canDeleteMessages(member: Member): boolean {
  return (
    member.status === "creator" ||
    (member.status === "administrator" && member.can_delete_messages === true)
  );
}

function canRestrictMembers(member: Member): boolean {
  return (
    member.status === "creator" ||
    (member.status === "administrator" && member.can_restrict_members === true)
  );
}

function configText(
  config: Config,
  language: Language,
  defaultDelete: boolean,
  spamDefaults: SpamSettings,
): string {
  // Values a group has not set itself are marked as following the Worker-wide default.
  const shown = (value: string, inherited: boolean) =>
    inherited ? adminMessage(language, "globalDefault", { value }) : value;
  const toggle = (on: boolean) => adminMessage(language, on ? "on" : "off");
  const spam = spamSettings(config, spamDefaults);
  return adminMessage(language, "config", {
    language: config.language,
    timeoutSeconds: config.timeoutSeconds,
    cooldownSeconds: config.cooldownSeconds,
    deleteJoinMessages: shown(
      toggle(config.deleteJoinMessages ?? defaultDelete),
      config.deleteJoinMessages === undefined,
    ),
    spamMode: shown(
      spam.mode === "new"
        ? adminMessage(language, "spamModeNew", { count: spam.firstMessages })
        : adminMessage(language, spam.mode === "all" ? "spamModeAll" : "off"),
      config.spamMode === undefined ||
        (spam.mode === "new" && config.spamFirstMessages === undefined),
    ),
    spamBan: shown(toggle(spam.ban), config.spamBan === undefined),
    spamCas: shown(toggle(spam.cas), config.spamCas === undefined),
  });
}

function send(
  api: AdminApi,
  chatId: number,
  language: Language,
  key: AdminMessageKey,
  values?: Record<string, string | number>,
  replyMarkup?: SendBody["reply_markup"],
) {
  return api.sendMessage({
    chat_id: chatId,
    text: adminMessage(language, key, values),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/** Telegram answers 400/403 when a chat is unknown to the bot or the bot was removed from it. */
function unreachable(error: unknown): boolean {
  const { code } = apiError(error);
  return code === 400 || code === 403;
}

function packIsUsable(pack: ContentPack | null | undefined): pack is ContentPack {
  return pack != null && validateContentPack(pack) === null;
}

export function createAdmin({
  api,
  repository,
  now = Date.now,
  defaultDeleteJoinMessages = false,
  spamDefaults = DEFAULT_SPAM_SETTINGS,
}: AdminOptions) {
  type Access = { status: "ok"; member: Member } | { status: "forbidden" | "unavailable" };

  /** Look up what `userId` may do in `chatId`; the answer is never cached or trusted from input. */
  async function access(chatId: number, userId: number): Promise<Access> {
    let member: Member;
    try {
      member = await api.getChatMember({ chat_id: chatId, user_id: userId });
    } catch (error) {
      if (unreachable(error)) return { status: "unavailable" };
      throw error;
    }
    return isAdmin(member.status, member.can_invite_users)
      ? { status: "ok", member }
      : { status: "forbidden" };
  }

  /** The chat when it is a group or supergroup the bot can reach; null otherwise. */
  async function groupInfo(chatId: number): Promise<Chat | null> {
    try {
      const chat = await api.getChat({ chat_id: chatId });
      return chat.type === "group" || chat.type === "supergroup" ? chat : null;
    } catch (error) {
      if (unreachable(error)) return null;
      throw error;
    }
  }

  /** A "Manage in private chat" deep-link button for replies posted in a group. */
  async function manageMarkup(
    chatId: number,
    language: Language,
  ): Promise<SendBody["reply_markup"] | undefined> {
    const ref = encodeGroupRef(chatId);
    const { username } = await api.getMe();
    if (!ref || !username) return undefined;
    return {
      inline_keyboard: [
        [
          {
            text: adminMessage(language, "manageButton"),
            url: `https://t.me/${username}?start=${ref}`,
          },
        ],
      ],
    };
  }

  /** Remember `chatId` as the user's group to manage, after proving they may manage it. */
  async function selectGroup(userId: number, chatId: number): Promise<Chat | null> {
    if ((await access(chatId, userId)).status !== "ok") return null;
    const chat = await groupInfo(chatId);
    if (!chat) return null;
    await repository.setAdminTarget(userId, chatId, now());
    return chat;
  }

  function title(chat: Chat): string {
    return chat.title?.trim() || String(chat.id);
  }

  /** List bot permissions the spam filter needs but lacks, in the reply language. */
  async function missingSpamPermissions(chatId: number, ban: boolean, language: Language) {
    const me = await api.getMe();
    const botMember = await api.getChatMember({ chat_id: chatId, user_id: me.id });
    const missing: AdminMessageKey[] = [];
    if (!canDeleteMessages(botMember)) missing.push("permissionDelete");
    if (ban && !canRestrictMembers(botMember)) missing.push("permissionRestrict");
    return missing.map((key) => adminMessage(language, key));
  }

  async function botPermissions(chatId: number): Promise<BotPermissions> {
    const me = await api.getMe();
    const member = await api.getChatMember({ chat_id: chatId, user_id: me.id });
    return {
      canApprove: isAdmin(member.status, member.can_invite_users),
      canDelete: canDeleteMessages(member),
      canRestrict: canRestrictMembers(member),
    };
  }

  /** Why join verification cannot be enabled for this group yet, or null when it can. */
  async function enableBlocker(chatId: number, config: Config): Promise<Blocker | null> {
    const pack = await repository.getContentPack(config.contentId);
    if (!packIsUsable(pack)) return { key: "contentRequired" };
    const configError = validateConfig(config);
    if (configError) return { key: "invalidConfig", values: { error: configError } };
    if (!(await botPermissions(chatId)).canApprove) return { key: "botNeedsAdmin" };
    return null;
  }

  /** Create the approval-only invite link, or say what is missing first. */
  async function createInvite(chatId: number, config: Config): Promise<{ link: string } | Blocker> {
    const pack = await repository.getContentPack(config.contentId);
    if (!config.enabled || !packIsUsable(pack)) return { key: "inviteNeedsEnabled" };
    if (!(await botPermissions(chatId)).canApprove) return { key: "botNeedsAdmin" };
    const invite = await api.createChatInviteLink({
      chat_id: chatId,
      name: "verification requests",
      creates_join_request: true,
    });
    return { link: invite.invite_link };
  }

  /** The "Next steps" block for a group, fetching what the caller does not already have. */
  async function hintsFor(
    chatId: number,
    config: Config,
    language: Language,
    privateChat: boolean,
    known: { pack?: ContentPack | null; bot?: BotPermissions } = {},
  ): Promise<string> {
    const pack =
      known.pack !== undefined ? known.pack : await repository.getContentPack(config.contentId);
    const bot = known.bot ?? (await botPermissions(chatId));
    return hintsText(
      language,
      nextSteps({
        config,
        bot,
        packUsable: packIsUsable(pack),
        privateChat,
        defaultDeleteJoinMessages,
        spamDefaults,
      }),
    );
  }

  /** The settings panel for a group: status text, next steps and the inline keyboard. */
  async function panelView(
    chat: Chat,
    config: Config,
    language: Language,
  ): Promise<Required<MessageBody>> {
    const groupRef = encodeGroupRef(chat.id) ?? "";
    return {
      text: adminMessage(language, "panel", {
        title: title(chat),
        groupId: chat.id,
        enabled: adminMessage(language, config.enabled ? "enabled" : "disabled"),
        config: configText(config, language, defaultDeleteJoinMessages, spamDefaults),
        hints: await hintsFor(chat.id, config, language, true),
      }),
      reply_markup: {
        inline_keyboard: groupRef
          ? panelKeyboard({
              language,
              config,
              groupRef,
              defaultDeleteJoinMessages,
              spamDefaults,
            })
          : [],
      },
    };
  }

  async function loadConfig(chatId: number): Promise<Config> {
    return { ...DEFAULT_CONFIG, ...(await repository.getConfig(chatId)) };
  }

  /** Post the settings panel for `chat` into the administrator's private chat, in the group's language. */
  async function sendPanel(privateChatId: number, chat: Chat): Promise<void> {
    const config = await loadConfig(chat.id);
    const view = await panelView(chat, config, groupLanguage(config));
    await api.sendMessage({ chat_id: privateChatId, ...view });
  }

  /** A settings-panel button tap. Everything in the callback is untrusted and re-verified. */
  async function callback(query: CallbackQuery): Promise<void> {
    const fallback = userLanguage(query.from, "cn");
    // Telegram limits a toast to 200 characters.
    const answer = (language: Language, blocker: Blocker) =>
      api.answerCallbackQuery({
        callback_query_id: query.id,
        text: adminMessage(language, blocker.key, blocker.values).slice(0, 200),
      });
    const parsed = parsePanelCallback(query.data);
    const groupId = parsed ? decodeGroupRef(parsed.groupRef) : null;
    const message = query.message;
    if (!parsed || groupId === null) {
      await answer(fallback, { key: "toastInvalid" });
      return;
    }
    if (!message) {
      await answer(fallback, { key: "toastStale" });
      return;
    }
    if (message.chat.type !== "private" || message.chat.id !== query.from.id) {
      await answer(fallback, { key: "toastInvalid" });
      return;
    }

    const requester = await access(groupId, query.from.id);
    const chat = requester.status === "ok" ? await groupInfo(groupId) : null;
    if (requester.status === "forbidden") {
      await answer(fallback, { key: "toastDenied" });
      return;
    }
    if (!chat) {
      await answer(fallback, { key: "targetUnavailable" });
      return;
    }

    const config = await loadConfig(groupId);
    // The panel speaks the group's language, like every other settings reply.
    const language = groupLanguage(config);
    let updated = config;
    let toast: Blocker = { key: "toastUpdated" };
    const fail = (blocker: Blocker) => {
      toast = blocker.key.startsWith("toast")
        ? blocker
        : {
            key: "toastFailed",
            values: { error: adminMessage(language, blocker.key, blocker.values) },
          };
    };
    if (parsed.action === "en") {
      if (config.enabled) updated = { ...config, enabled: false };
      else {
        const blocker = await enableBlocker(groupId, config);
        if (blocker) fail(blocker);
        else updated = { ...config, enabled: true };
      }
    } else if (parsed.action === "iv") {
      const result = await createInvite(groupId, config);
      if ("link" in result) {
        await send(api, message.chat.id, language, "inviteCreated", { inviteLink: result.link });
        toast = { key: "toastInviteSent" };
      } else fail(result);
    } else if (parsed.action !== "rf") {
      const candidate = cycleSetting(config, parsed.action);
      const error = validateConfig(candidate);
      if (error) fail({ key: "invalidConfigUpdate", values: { error } });
      else updated = candidate;
    }
    if (updated !== config) await repository.saveConfig(groupId, updated);
    await repository.setAdminTarget(query.from.id, groupId, now());
    await answer(groupLanguage(updated), toast);

    try {
      await api.editMessageText({
        chat_id: message.chat.id,
        message_id: message.message_id,
        ...(await panelView(chat, updated, groupLanguage(updated))),
      });
    } catch (error) {
      const { code, description } = apiError(error);
      if (!(code === 400 && /message is not modified/i.test(description ?? ""))) throw error;
    }
  }

  /** Offer Telegram's group picker, or drop the saved selection with `clear`. */
  async function groups(message: Message, args: string): Promise<void> {
    const sourceChatId = message.chat.id;
    if (message.chat.type !== "private") {
      const language = groupLanguage(await repository.getConfig(sourceChatId));
      await send(
        api,
        sourceChatId,
        language,
        "groupsPrivateOnly",
        undefined,
        await manageMarkup(sourceChatId, language),
      );
      return;
    }
    const language = userLanguage(message.from, "cn");
    const userId = message.from?.id;
    if (userId == null) {
      await send(api, sourceChatId, language, "senderUnknown");
      return;
    }
    if (args.toLowerCase() === "clear") {
      await repository.clearAdminTarget(userId);
      await send(api, sourceChatId, language, "groupsCleared", undefined, {
        remove_keyboard: true,
      });
      return;
    }
    let text = adminMessage(language, "groupsPrompt");
    const savedId = await repository.getAdminTarget(userId, now() - ADMIN_TARGET_TTL_MS);
    if (savedId !== null) {
      const saved = await groupInfo(savedId);
      text += `\n${adminMessage(language, "groupsCurrent", {
        title: saved ? title(saved) : String(savedId),
        groupId: savedId,
      })}`;
    }
    await api.sendMessage({
      chat_id: sourceChatId,
      text,
      reply_markup: {
        keyboard: [
          [
            {
              text: adminMessage(language, "groupsButton"),
              request_chat: {
                request_id: GROUP_PICKER_REQUEST_ID,
                chat_is_channel: false,
                bot_is_member: true,
                user_administrator_rights: { can_invite_users: true },
              },
            },
          ],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }

  /** The user picked a group in Telegram's chooser; the shared ID is untrusted until verified. */
  async function chatShared(message: Message): Promise<void> {
    const shared = message.chat_shared;
    const userId = message.from?.id;
    if (message.chat.type !== "private" || userId == null) return;
    if (shared?.request_id !== GROUP_PICKER_REQUEST_ID) return;
    const language = userLanguage(message.from, "cn");
    const chat = await selectGroup(userId, shared.chat_id);
    if (!chat) {
      await send(api, message.chat.id, language, "groupSelectFailed", undefined, {
        remove_keyboard: true,
      });
      return;
    }
    await send(
      api,
      message.chat.id,
      language,
      "groupSelected",
      { title: title(chat), groupId: chat.id },
      { remove_keyboard: true },
    );
    await sendPanel(message.chat.id, chat);
  }

  /** `/start s<n>` or `g<n>`: a deep link from a group's "Manage in private chat" button. */
  async function open(message: Message, ref: string): Promise<boolean> {
    const groupId = decodeGroupRef(ref);
    const userId = message.from?.id;
    if (groupId === null || message.chat.type !== "private" || userId == null) return false;
    const language = userLanguage(message.from, "cn");
    const chat = await selectGroup(userId, groupId);
    if (!chat) {
      await api.sendMessage({ chat_id: message.chat.id, text: t(language, "startNotAdmin") });
      return true;
    }
    await send(api, message.chat.id, language, "groupSelected", {
      title: title(chat),
      groupId: chat.id,
    });
    await sendPanel(message.chat.id, chat);
    return true;
  }

  async function handle(message: Message, command: AdminCommand): Promise<void> {
    const sourceChatId = message.chat.id;
    const privateChat = message.chat.type === "private";
    const groupChat = message.chat.type === "group" || message.chat.type === "supergroup";
    if (!privateChat && !groupChat) {
      await send(api, sourceChatId, userLanguage(message.from, "cn"), "unsupportedChat");
      return;
    }

    if (privateChat && command.name === "verify_help" && !command.args) {
      await send(api, sourceChatId, userLanguage(message.from, "cn"), "privateHelp");
      return;
    }

    if (command.name === "verify_groups") {
      await groups(message, command.args);
      return;
    }

    if (groupChat && command.name === "verify_invite") {
      if (message.sender_chat) {
        await send(
          api,
          sourceChatId,
          "cn",
          "anonymousAdmin",
          undefined,
          await manageMarkup(sourceChatId, "cn"),
        );
        return;
      }
      const senderId = message.from?.id;
      if (senderId == null) {
        await send(api, sourceChatId, "cn", "senderUnknown");
        return;
      }
      const groupAccess = await access(sourceChatId, senderId);
      const language = groupLanguage(await repository.getConfig(sourceChatId));
      if (groupAccess.status !== "ok") {
        await send(api, sourceChatId, language, "adminRequired");
        return;
      }
      await send(
        api,
        sourceChatId,
        language,
        "invitePrivateOnly",
        undefined,
        await manageMarkup(sourceChatId, language),
      );
      return;
    }

    const senderId = message.from?.id;
    let chatId = sourceChatId;
    let args = command.args;
    let selected = false;
    let targetChat: Chat | null = null;
    if (privateChat) {
      if (senderId == null) {
        await send(api, sourceChatId, userLanguage(message.from, "cn"), "senderUnknown");
        return;
      }
      const target = /^(-?\d+)(?:\s+([\s\S]*))?$/.exec(args);
      if (target) {
        chatId = Number(target[1]);
        args = target[2]?.trim() ?? "";
      } else {
        const saved = await repository.getAdminTarget(senderId, now() - ADMIN_TARGET_TTL_MS);
        if (saved === null) {
          await send(api, sourceChatId, userLanguage(message.from, "cn"), "targetRequired");
          return;
        }
        chatId = saved;
        selected = true;
      }
      if (!Number.isSafeInteger(chatId)) {
        await send(api, sourceChatId, userLanguage(message.from, "cn"), "targetRequired");
        return;
      }
    }

    const storedConfig = await repository.getConfig(chatId);
    const config: Config = { ...DEFAULT_CONFIG, ...storedConfig };
    const configuredLanguage = groupLanguage(storedConfig);
    const setupCommand = command.name === "verify_invite";
    const responseLanguage =
      privateChat && setupCommand
        ? userLanguage(message.from, configuredLanguage)
        : configuredLanguage;

    if (message.sender_chat) {
      await send(
        api,
        sourceChatId,
        responseLanguage,
        "anonymousAdmin",
        undefined,
        await manageMarkup(sourceChatId, responseLanguage),
      );
      return;
    }

    if (senderId == null) {
      await send(api, sourceChatId, responseLanguage, "senderUnknown");
      return;
    }

    const requester = await access(chatId, senderId);
    if (requester.status === "unavailable") {
      // A stale selection (bot removed, group deleted) is dropped instead of failing forever.
      if (selected) await repository.clearAdminTarget(senderId);
      await send(api, sourceChatId, userLanguage(message.from, "cn"), "targetUnavailable");
      return;
    }
    if (requester.status !== "ok") {
      await send(api, sourceChatId, responseLanguage, "adminRequired");
      return;
    }
    if (privateChat) {
      targetChat = await groupInfo(chatId);
      if (!targetChat) {
        await send(api, sourceChatId, userLanguage(message.from, "cn"), "targetNotGroup");
        return;
      }
      // Using a group keeps the selection alive; the 24 hours count from the last command.
      await repository.setAdminTarget(senderId, chatId, now());
    }

    if (command.name === "verify_help") {
      await send(
        api,
        sourceChatId,
        responseLanguage,
        privateChat ? "privateHelp" : "help",
        undefined,
        privateChat ? undefined : await manageMarkup(chatId, responseLanguage),
      );
      return;
    }

    if (command.name === "verify_status") {
      const bot = await botPermissions(chatId);
      const botCanApprove = bot.canApprove;
      const pack = await repository.getContentPack(config.contentId);
      const blocklist = await repository.getBlocklist(DEFAULT_BLOCKLIST_ID);
      const text = adminMessage(responseLanguage, "status", {
        blocklistVersion:
          blocklist && !validateBlocklist(blocklist)
            ? blocklist.version
            : adminMessage(responseLanguage, "noContent"),
        enabled: adminMessage(responseLanguage, config.enabled ? "enabled" : "disabled"),
        botPermission: adminMessage(
          responseLanguage,
          botCanApprove ? "botCanApprove" : "botCannotApprove",
        ),
        chatId,
        packVersion:
          pack && packIsUsable(pack) ? pack.version : adminMessage(responseLanguage, "noContent"),
        rulesVersion:
          pack && packIsUsable(pack)
            ? pack.rules.version
            : adminMessage(responseLanguage, "noContent"),
        config: configText(config, responseLanguage, defaultDeleteJoinMessages, spamDefaults),
      });
      await api.sendMessage({
        chat_id: sourceChatId,
        text: privateChat
          ? text + (await hintsFor(chatId, config, responseLanguage, true, { pack, bot }))
          : text,
        ...(privateChat ? {} : { reply_markup: await manageMarkup(chatId, responseLanguage) }),
      });
      return;
    }

    if (command.name === "verify_enable") {
      const blocker = await enableBlocker(chatId, config);
      if (blocker) {
        await send(api, sourceChatId, responseLanguage, blocker.key, blocker.values);
        return;
      }
      config.enabled = true;
      await repository.saveConfig(chatId, config);
      const text = adminMessage(responseLanguage, "enableSuccess");
      await api.sendMessage({
        chat_id: sourceChatId,
        text: privateChat ? text + (await hintsFor(chatId, config, responseLanguage, true)) : text,
      });
      return;
    }

    if (command.name === "verify_disable") {
      config.enabled = false;
      await repository.saveConfig(chatId, config);
      await send(api, sourceChatId, responseLanguage, "disableSuccess");
      return;
    }

    if (command.name === "verify_config") {
      if (!args) {
        if (privateChat && targetChat) {
          await api.sendMessage({
            chat_id: sourceChatId,
            ...(await panelView(targetChat, config, configuredLanguage)),
          });
          return;
        }
        await api.sendMessage({
          chat_id: sourceChatId,
          text: configText(config, responseLanguage, defaultDeleteJoinMessages, spamDefaults),
          ...(privateChat ? {} : { reply_markup: await manageMarkup(chatId, responseLanguage) }),
        });
        return;
      }
      const updates: Partial<Config> = {};
      for (const token of args.split(/\s+/)) {
        const [key, rawValue, ...extra] = token.split("=");
        if (key === "language") {
          if ((rawValue !== "en" && rawValue !== "cn") || extra.length) {
            await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
            return;
          }
          updates.language = rawValue;
          continue;
        }
        if (key === "deleteJoinMessages") {
          if ((rawValue !== "on" && rawValue !== "off" && rawValue !== "default") || extra.length) {
            await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
            return;
          }
          updates.deleteJoinMessages = rawValue === "default" ? undefined : rawValue === "on";
          continue;
        }
        if (SPAM_KEYS.includes(key as (typeof SPAM_KEYS)[number]) && rawValue === "default") {
          if (extra.length) {
            await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
            return;
          }
          updates[key as (typeof SPAM_KEYS)[number]] = undefined;
          continue;
        }
        if (key === "spamMode") {
          if ((rawValue !== "off" && rawValue !== "new" && rawValue !== "all") || extra.length) {
            await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
            return;
          }
          updates.spamMode = rawValue;
          continue;
        }
        if (key === "spamBan" || key === "spamCas") {
          if ((rawValue !== "on" && rawValue !== "off") || extra.length) {
            await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
            return;
          }
          updates[key] = rawValue === "on";
          continue;
        }
        if (!CONFIG_KEYS.has(key) || rawValue == null || rawValue === "" || extra.length) {
          await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
          return;
        }
        if (!/^[0-9]+$/.test(rawValue)) {
          await send(api, sourceChatId, responseLanguage, "integerRequired", { key });
          return;
        }
        (updates as Record<string, unknown>)[key] = Number(rawValue);
      }
      const next: Config = { ...config, ...updates };
      // "=default" clears a group override so the Worker-wide default applies again.
      for (const key of ["deleteJoinMessages", ...SPAM_KEYS] as const)
        if (next[key] === undefined) delete next[key];
      const error = validateConfig(next);
      if (error) {
        await send(api, sourceChatId, responseLanguage, "invalidConfigUpdate", { error });
        return;
      }
      await repository.saveConfig(chatId, next);
      const newLanguage = groupLanguage(next);
      let text = adminMessage(newLanguage, "configUpdated", {
        config: configText(next, newLanguage, defaultDeleteJoinMessages, spamDefaults),
      });
      if (
        Object.hasOwn(updates, "deleteJoinMessages") &&
        (next.deleteJoinMessages ?? defaultDeleteJoinMessages)
      ) {
        const me = await api.getMe();
        const botMember = await api.getChatMember({ chat_id: chatId, user_id: me.id });
        if (!canDeleteMessages(botMember))
          text += `\n${adminMessage(newLanguage, "botNeedsDeletePermission")}`;
      }
      const spam = spamSettings(next, spamDefaults);
      if (SPAM_KEYS.some((key) => Object.hasOwn(updates, key)) && spam.mode !== "off") {
        const missing = await missingSpamPermissions(chatId, spam.ban, newLanguage);
        if (missing.length)
          text += `\n${adminMessage(newLanguage, "botNeedsSpamPermissions", { permissions: missing.join(", ") })}`;
      }
      if (privateChat) text += await hintsFor(chatId, next, newLanguage, true);
      await api.sendMessage({ chat_id: sourceChatId, text });
      return;
    }

    if (command.name === "verify_invite") {
      const result = await createInvite(chatId, config);
      if ("link" in result)
        await send(api, sourceChatId, responseLanguage, "inviteCreated", {
          inviteLink: result.link,
        });
      else await send(api, sourceChatId, responseLanguage, result.key, result.values);
      return;
    }
  }

  return { handle, chatShared, open, callback };
}
