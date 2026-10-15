export type Language = "en" | "cn";
/** Which group messages the spam filter inspects. */
export type SpamMode = "off" | "new" | "all";
export interface Question {
  id: string;
  prompt: string;
  options: string[];
  answerIndex: number;
  explanation?: string;
  translations?: Partial<
    Record<Language, { prompt: string; options: string[]; explanation?: string }>
  >;
}
export interface Config {
  language: Language;
  enabled: boolean;
  contentId: string;
  timeoutSeconds: number;
  cooldownSeconds: number;
  /** Delete Telegram's "joined the group" service messages; absent inherits DELETE_JOIN_MESSAGES. */
  deleteJoinMessages?: boolean;
  /** Spam filter scope; absent means off. */
  spamMode?: SpamMode;
  /** In "new" mode, how many messages per member are inspected; absent means 3. */
  spamFirstMessages?: number;
  /** Ban senders on ban-tier matches and CAS hits; absent means on. Off only deletes. */
  spamBan?: boolean;
  /** Look up first-time senders in the CAS ban list; absent means on. */
  spamCas?: boolean;
}
export interface ContentPack {
  id: string;
  version: string;
  questions: Question[];
  rules: { version: string; cn: string; en: string };
}
/** A pack manifest document, mirroring `packs/<id>.json` in content checkouts. */
export interface PackDocument {
  id: string;
  version: string;
  rules: string;
  questionTypes: string[];
}
/** A spam blocklist, mirroring `blocklists/<id>.json` in content checkouts. */
export interface BlocklistDocument {
  version: string;
  /** Delete the message and ban the sender. */
  ban: string[];
  /** Delete the message only. */
  delete: string[];
}
/** A rules document, mirroring `rules/<id>.json` in content checkouts. */
export interface RulesDocument {
  version: string;
  cn: string;
  en: string;
}
export type Status =
  | "active"
  | "awaiting_rules"
  | "approve_pending"
  | "decline_pending"
  | "approved"
  | "declined";
export interface Session {
  language: Language;
  key: string;
  groupId: number;
  userId: number;
  userChatId: number;
  requestDate: number;
  requestId: string;
  title: string;
  nonce: string;
  status: Status;
  questions: Question[];
  index: number;
  formatVersion: 3;
  contentVersion: string;
  refreshes: number;
  rules: { version: string; text: string };
  rulesAcceptedAt?: number;
  rulesAcceptedVersion?: string;
  expiresAt: number;
  cooldownSeconds: number;
  blockedUntil: number;
  revision: number;
  messageId: number | null;
  effectLeaseUntil?: number;
  lastApiErrorCode?: number | null;
  cleanupLeaseUntil?: number;
  cleanupRetryAt?: number;
  messageDeletedAt?: number;
}
export interface User {
  id: number;
  username?: string;
  language_code?: string;
  first_name?: string;
  last_name?: string;
}
export interface Chat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}
export interface MessageEntity {
  type: string;
  url?: string;
}
export interface InlineButton {
  text: string;
  url?: string;
}
export interface MessageOrigin {
  type: string;
  sender_user?: User;
  sender_user_name?: string;
  sender_chat?: Chat;
  chat?: Chat;
}
export interface Message {
  message_id: number;
  chat: Chat;
  from?: User;
  sender_chat?: Chat;
  text?: string;
  new_chat_members?: User[];
  caption?: string;
  entities?: MessageEntity[];
  caption_entities?: MessageEntity[];
  reply_markup?: { inline_keyboard: InlineButton[][] };
  quote?: { text: string };
  forward_origin?: MessageOrigin;
  is_automatic_forward?: boolean;
  /** Result of a `request_chat` keyboard button (private chats only). */
  chat_shared?: { request_id: number; chat_id: number; title?: string };
}
export interface JoinRequest {
  chat: Chat;
  from: User;
  user_chat_id: number;
  date: number;
  query_id?: string;
}
export interface CallbackQuery {
  id: string;
  from: User;
  data?: string;
  message?: Message;
}
export interface Context {
  update?: { update_id: number };
}
export interface Bindings {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  /** Per-session alarms; absent where Durable Objects are unavailable and cron alone runs maintenance. */
  SESSION_TIMER?: DurableObjectNamespace<import("./timer.js").SessionTimer>;
  /** Default for groups without their own deleteJoinMessages setting: "true" or "false". */
  DELETE_JOIN_MESSAGES?: string;
  /** Spam filter defaults for groups without their own setting; see README › Spam filter. */
  SPAM_MODE?: string;
  SPAM_FIRST_MESSAGES?: string;
  SPAM_BAN?: string;
  SPAM_CAS?: string;
}
export type InlineKeyboardButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };
/** A reply-keyboard button that opens Telegram's native picker for groups the user manages. */
export interface ChatPickerButton {
  text: string;
  request_chat: {
    request_id: number;
    chat_is_channel: false;
    bot_is_member: true;
    user_administrator_rights: { can_invite_users: true };
  };
}
export interface MessageBody {
  text: string;
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
}
/** `sendMessage` also accepts reply keyboards, which `editMessageText` does not. */
export interface SendBody {
  text: string;
  reply_markup?:
    | { inline_keyboard: InlineKeyboardButton[][] }
    | { keyboard: ChatPickerButton[][]; resize_keyboard: true; one_time_keyboard: true }
    | { remove_keyboard: true };
}
export interface Member {
  status: string;
  can_invite_users?: boolean;
  can_delete_messages?: boolean;
  can_restrict_members?: boolean;
}
export interface BotApi {
  deleteMessage(input: { chat_id: number; message_id: number }): Promise<boolean>;
  createChatInviteLink(input: {
    chat_id: number;
    name?: string;
    creates_join_request: true;
  }): Promise<{ invite_link: string; creates_join_request?: boolean }>;
  sendMessage(input: SendBody & { chat_id: number }): Promise<Message>;
  editMessageText(
    input: MessageBody & { chat_id: number; message_id: number },
  ): Promise<Message | boolean>;
  answerCallbackQuery(input: { callback_query_id: string; text?: string }): Promise<boolean>;
  setMyCommands(input: {
    commands: { command: string; description: string }[];
    scope: { type: "chat"; chat_id: number };
    language_code?: "zh";
  }): Promise<boolean>;
  approveChatJoinRequest(input: { chat_id: number; user_id: number }): Promise<boolean>;
  declineChatJoinRequest(input: { chat_id: number; user_id: number }): Promise<boolean>;
  answerChatJoinRequestQuery(input: {
    chat_join_request_query_id: string;
    result: "queue" | "approve" | "decline";
  }): Promise<boolean>;
  getMe(): Promise<User>;
  getChat(input: { chat_id: number }): Promise<Chat>;
  getChatMember(input: { chat_id: number; user_id: number }): Promise<Member>;
  banChatMember(input: { chat_id: number; user_id: number }): Promise<boolean>;
  banChatSenderChat(input: { chat_id: number; sender_chat_id: number }): Promise<boolean>;
}
export interface Repository {
  getConfig(groupId: number): Promise<Config | null>;
  saveConfig(groupId: number, config: Config): Promise<Config>;
  getContentPack(id: string): Promise<ContentPack | null>;
  getSession(key: string): Promise<Session | null>;
  createSession(session: Session): Promise<boolean>;
  casSession(previous: Session, next: Session): Promise<boolean>;
  listSessionsForUser(userId: number): Promise<Session[]>;
  listSessionsForGroup(groupId: number): Promise<Session[]>;
  listActionableSessions(now: number, limit?: number): Promise<Session[]>;
  getBlocklist(id: string): Promise<BlocklistDocument | null>;
  /** How many inspected messages a sender has posted in a group; 0 when unknown. */
  getMemberMessages(groupId: number, senderId: number): Promise<number>;
  /** The group a user chose to manage, or null when none was chosen since `notBefore`. */
  getAdminTarget(userId: number, notBefore: number): Promise<number | null>;
  setAdminTarget(userId: number, groupId: number, at: number): Promise<void>;
  clearAdminTarget(userId: number): Promise<void>;
  /** Delete selections last used before `before`. */
  pruneAdminTargets(before: number): Promise<void>;
  recordMemberMessage(groupId: number, senderId: number, at: number): Promise<void>;
  resetMembers(groupId: number, senderIds: number[]): Promise<void>;
}
