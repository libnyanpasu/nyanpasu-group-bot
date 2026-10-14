import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { blocklists, groups, members, packs, questions, rules, sessions } from "../schema.js";
import type { Config, ContentPack, Question, Repository, Session } from "../types.js";

const USER_SESSION_LIMIT = 20;
const GROUP_SESSION_LIMIT = 100;
const ACTIONABLE_SESSION_LIMIT = 100;

type ActionableRow = { payload: Session; dueAt: number; requestDate: number };

function compareActionable(left: ActionableRow, right: ActionableRow): number {
  return (
    left.dueAt - right.dueAt ||
    left.requestDate - right.requestDate ||
    left.payload.key.localeCompare(right.payload.key)
  );
}

// Never carry legacy embedded question banks forward into group configuration.
function configuration(config: Config): Config {
  return {
    language: config.language,
    enabled: config.enabled,
    contentId: config.contentId ?? "default",
    timeoutSeconds: config.timeoutSeconds,
    cooldownSeconds: config.cooldownSeconds,
    ...(typeof config.deleteJoinMessages === "boolean"
      ? { deleteJoinMessages: config.deleteJoinMessages }
      : {}),
    ...(config.spamMode !== undefined ? { spamMode: config.spamMode } : {}),
    ...(config.spamFirstMessages !== undefined
      ? { spamFirstMessages: config.spamFirstMessages }
      : {}),
    ...(typeof config.spamBan === "boolean" ? { spamBan: config.spamBan } : {}),
    ...(typeof config.spamCas === "boolean" ? { spamCas: config.spamCas } : {}),
  };
}

function sessionRow(session: Session) {
  return {
    key: session.key,
    groupId: session.groupId,
    userId: session.userId,
    revision: session.revision,
    status: session.status,
    expiresAt: session.expiresAt,
    effectLeaseUntil: session.effectLeaseUntil ?? null,
    cleanupLeaseUntil: session.cleanupLeaseUntil ?? null,
    cleanupRetryAt: session.cleanupRetryAt ?? null,
    messageId: session.messageId,
    messageDeletedAt: session.messageDeletedAt ?? null,
    requestDate: session.requestDate,
    payload: session,
  };
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return ACTIONABLE_SESSION_LIMIT;
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.min(ACTIONABLE_SESSION_LIMIT, Math.floor(limit)));
}

/**
 * Assemble a validated-shape content pack from its pack, rules and question
 * documents. Question order matches file checkout assembly: question types are
 * sorted, and questions keep the ordered type, id result order.
 */
async function assembleContentPack<
  TRunResult,
  TFullSchema extends Record<string, unknown> = Record<string, never>,
>(
  database: BaseSQLiteDatabase<"async", TRunResult, TFullSchema>,
  id: string,
): Promise<ContentPack | null> {
  const [manifest] = await database
    .select({ payload: packs.payload })
    .from(packs)
    .where(eq(packs.id, id))
    .limit(1)
    .all();
  if (!manifest || typeof manifest.payload.rules !== "string") return null;
  const questionTypes = manifest.payload.questionTypes;
  if (!Array.isArray(questionTypes)) return null;

  const [rulesRows, questionRows] = await Promise.all([
    database
      .select({ payload: rules.payload })
      .from(rules)
      .where(eq(rules.id, manifest.payload.rules))
      .limit(1)
      .all(),
    questionTypes.length === 0
      ? Promise.resolve([] as { type: string; payload: Question }[])
      : database
          .select({ type: questions.type, payload: questions.payload })
          .from(questions)
          .where(inArray(questions.type, questionTypes))
          .orderBy(asc(questions.type), asc(questions.id))
          .all(),
  ]);

  const [rulesRow] = rulesRows;
  if (!rulesRow) return null;
  const byType = new Map<string, Question[]>();
  for (const row of questionRows) {
    const list = byType.get(row.type) ?? [];
    list.push(row.payload);
    byType.set(row.type, list);
  }
  return {
    id,
    version: manifest.payload.version,
    questions: [...questionTypes].sort().flatMap((type) => byType.get(type) ?? []),
    rules: rulesRow.payload,
  };
}

/**
 * Create repository operations for a Drizzle D1 database. The complete app
 * objects remain in JSON payload columns; query and CAS metadata stays indexed.
 */
export function createRepository<
  TRunResult,
  TFullSchema extends Record<string, unknown> = Record<string, never>,
>(database: BaseSQLiteDatabase<"async", TRunResult, TFullSchema>): Repository {
  return {
    async getConfig(groupId) {
      const [row] = await database
        .select({ payload: groups.payload })
        .from(groups)
        .where(eq(groups.groupId, groupId))
        .limit(1)
        .all();
      return row ? configuration(row.payload) : null;
    },

    async saveConfig(groupId, config) {
      const stored = configuration(config);
      await database
        .insert(groups)
        .values({ groupId, payload: stored })
        .onConflictDoUpdate({ target: groups.groupId, set: { payload: stored } })
        .run();
      return stored;
    },

    async getContentPack(id) {
      return assembleContentPack(database, id);
    },

    async getBlocklist(id) {
      const [row] = await database
        .select({ payload: blocklists.payload })
        .from(blocklists)
        .where(eq(blocklists.id, id))
        .limit(1)
        .all();
      return row?.payload ?? null;
    },

    async getMemberMessages(groupId, senderId) {
      const [row] = await database
        .select({ messages: members.messages })
        .from(members)
        .where(and(eq(members.groupId, groupId), eq(members.userId, senderId)))
        .limit(1)
        .all();
      return row?.messages ?? 0;
    },

    async recordMemberMessage(groupId, senderId, at) {
      // A single upsert keeps concurrent webhook deliveries from losing increments.
      await database
        .insert(members)
        .values({ groupId, userId: senderId, messages: 1, updatedAt: at })
        .onConflictDoUpdate({
          target: [members.groupId, members.userId],
          set: { messages: sql`${members.messages} + 1`, updatedAt: at },
        })
        .run();
    },

    async resetMembers(groupId, senderIds) {
      if (senderIds.length === 0) return;
      await database
        .delete(members)
        .where(and(eq(members.groupId, groupId), inArray(members.userId, senderIds)))
        .run();
    },

    async getSession(key) {
      const [row] = await database
        .select({ payload: sessions.payload })
        .from(sessions)
        .where(eq(sessions.key, key))
        .limit(1)
        .all();
      return row?.payload ?? null;
    },

    async createSession(session) {
      const inserted = await database
        .insert(sessions)
        .values(sessionRow(session))
        .onConflictDoNothing({ target: sessions.key })
        .returning({ key: sessions.key })
        .all();
      return inserted.length > 0;
    },

    async casSession(previous, next) {
      const revision = previous.revision + 1;
      const updated = { ...next, revision };
      const { key: _key, ...values } = sessionRow(updated);
      const changed = await database
        .update(sessions)
        .set(values)
        .where(and(eq(sessions.key, previous.key), eq(sessions.revision, previous.revision)))
        .returning({ key: sessions.key })
        .all();
      if (changed.length === 0) return false;
      next.revision = revision;
      return true;
    },

    async listSessionsForUser(userId) {
      const rows = await database
        .select({ payload: sessions.payload })
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(desc(sessions.requestDate))
        .limit(USER_SESSION_LIMIT)
        .all();
      return rows.map((row) => row.payload);
    },

    async listSessionsForGroup(groupId) {
      const rows = await database
        .select({ payload: sessions.payload })
        .from(sessions)
        .where(eq(sessions.groupId, groupId))
        .orderBy(desc(sessions.requestDate))
        .limit(GROUP_SESSION_LIMIT)
        .all();
      return rows.map((row) => row.payload);
    },

    async listActionableSessions(now, limit) {
      const bounded = boundedLimit(limit);
      if (bounded === 0) return [];

      const decisionDueAt = sql<number>`coalesce(${sessions.effectLeaseUntil}, 0)`;
      const cleanupDueAt = sql<number>`max(
        ${sessions.expiresAt},
        coalesce(${sessions.cleanupRetryAt}, 0),
        coalesce(${sessions.cleanupLeaseUntil}, 0)
      )`;

      const [expired, decisions, cleanup] = await Promise.all([
        database
          .select({
            payload: sessions.payload,
            dueAt: sessions.expiresAt,
            requestDate: sessions.requestDate,
          })
          .from(sessions)
          .where(
            and(
              sql`${sessions.status} in ('active', 'awaiting_rules')`,
              lte(sessions.expiresAt, now),
            ),
          )
          .orderBy(asc(sessions.expiresAt), asc(sessions.requestDate))
          .limit(bounded)
          .all(),
        database
          .select({
            payload: sessions.payload,
            dueAt: decisionDueAt,
            requestDate: sessions.requestDate,
          })
          .from(sessions)
          .where(
            and(
              sql`${sessions.status} in ('approve_pending', 'decline_pending')`,
              lte(decisionDueAt, now),
            ),
          )
          .orderBy(asc(decisionDueAt), asc(sessions.requestDate))
          .limit(bounded)
          .all(),
        database
          .select({
            payload: sessions.payload,
            dueAt: cleanupDueAt,
            requestDate: sessions.requestDate,
          })
          .from(sessions)
          .where(
            and(
              sql`${sessions.status} in ('approved', 'declined')`,
              isNotNull(sessions.messageId),
              isNull(sessions.messageDeletedAt),
              lte(cleanupDueAt, now),
            ),
          )
          .orderBy(asc(cleanupDueAt), asc(sessions.requestDate))
          .limit(bounded)
          .all(),
      ]);

      const latestByKey = new Map<string, ActionableRow>();
      for (const row of [...expired, ...decisions, ...cleanup]) {
        const current = latestByKey.get(row.payload.key);
        if (!current || row.payload.revision > current.payload.revision) {
          latestByKey.set(row.payload.key, row);
        }
      }

      return [...latestByKey.values()]
        .sort(compareActionable)
        .slice(0, bounded)
        .map((row) => row.payload);
    },
  };
}
