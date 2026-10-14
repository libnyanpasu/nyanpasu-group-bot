import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
  BlocklistDocument,
  Config,
  PackDocument,
  Question,
  RulesDocument,
  Session,
  Status,
} from "./types.js";

export const packs = sqliteTable("packs", {
  id: text("id").primaryKey(),
  updatedAt: integer("updated_at").notNull(),
  payload: text("payload", { mode: "json" }).$type<PackDocument>().notNull(),
});

export const rules = sqliteTable("rules", {
  id: text("id").primaryKey(),
  updatedAt: integer("updated_at").notNull(),
  payload: text("payload", { mode: "json" }).$type<RulesDocument>().notNull(),
});

export const questions = sqliteTable(
  "questions",
  {
    type: text("type").notNull(),
    id: text("id").notNull(),
    updatedAt: integer("updated_at").notNull(),
    payload: text("payload", { mode: "json" }).$type<Question>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.type, table.id] })],
);

export const blocklists = sqliteTable("blocklists", {
  id: text("id").primaryKey(),
  updatedAt: integer("updated_at").notNull(),
  payload: text("payload", { mode: "json" }).$type<BlocklistDocument>().notNull(),
});

/** Per-group message counts that let the advertising filter stop inspecting trusted members. */
export const members = sqliteTable(
  "members",
  {
    groupId: integer("group_id").notNull(),
    userId: integer("user_id").notNull(),
    messages: integer("messages").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.userId] })],
);

export const groups = sqliteTable("groups", {
  groupId: integer("group_id").primaryKey(),
  payload: text("payload", { mode: "json" }).$type<Config>().notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    key: text("key").primaryKey(),
    groupId: integer("group_id").notNull(),
    userId: integer("user_id").notNull(),
    revision: integer("revision").notNull(),
    status: text("status").$type<Status>().notNull(),
    expiresAt: integer("expires_at").notNull(),
    effectLeaseUntil: integer("effect_lease_until"),
    cleanupLeaseUntil: integer("cleanup_lease_until"),
    cleanupRetryAt: integer("cleanup_retry_at"),
    messageId: integer("message_id"),
    messageDeletedAt: integer("message_deleted_at"),
    requestDate: integer("request_date").notNull(),
    payload: text("payload", { mode: "json" }).$type<Session>().notNull(),
  },
  (table) => [
    index("idx_sessions_group_request_date").on(table.groupId, table.requestDate),
    index("idx_sessions_user_request_date").on(table.userId, table.requestDate),
    index("idx_sessions_active_expiry")
      .on(table.expiresAt, table.requestDate)
      .where(sql`${table.status} in ('active', 'awaiting_rules')`),
    index("idx_sessions_pending_effect_due")
      .on(sql.raw("coalesce(effect_lease_until, 0)"), table.requestDate)
      .where(sql`${table.status} in ('approve_pending', 'decline_pending')`),
    index("idx_sessions_cleanup_due")
      .on(
        sql.raw("max(expires_at, coalesce(cleanup_retry_at, 0), coalesce(cleanup_lease_until, 0))"),
        table.requestDate,
      )
      .where(
        sql`${table.messageId} is not null and ${table.messageDeletedAt} is null and ${table.status} in ('approved', 'declined')`,
      ),
  ],
);

export const schema = { groups, sessions, packs, rules, questions, blocklists, members };
