export type Language = "en" | "cn";
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
}
export interface Chat {
  id: number;
  type: string;
  title?: string;
}
export interface Message {
  message_id: number;
  chat: Chat;
  from?: User;
  sender_chat?: Chat;
  text?: string;
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
export interface TelegramUpdate {
  update_id: number;
  message?: Message;
  chat_join_request?: JoinRequest;
  callback_query?: CallbackQuery;
}
export interface Bindings {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
}
export interface MessageBody {
  text: string;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}
export interface Member {
  status: string;
  can_invite_users?: boolean;
}
export interface BotApi {
  deleteMessage(input: { chat_id: number; message_id: number }): Promise<boolean>;
  createChatInviteLink(input: {
    chat_id: number;
    name?: string;
    creates_join_request: true;
  }): Promise<{ invite_link: string; creates_join_request?: boolean }>;
  sendMessage(input: MessageBody & { chat_id: number }): Promise<Message>;
  editMessageText(
    input: MessageBody & { chat_id: number; message_id: number },
  ): Promise<Message | boolean>;
  answerCallbackQuery(input: { callback_query_id: string; text?: string }): Promise<boolean>;
  approveChatJoinRequest(input: { chat_id: number; user_id: number }): Promise<boolean>;
  declineChatJoinRequest(input: { chat_id: number; user_id: number }): Promise<boolean>;
  answerChatJoinRequestQuery(input: {
    chat_join_request_query_id: string;
    result: "queue" | "approve" | "decline";
  }): Promise<boolean>;
  getMe(): Promise<User>;
  getChat(input: { chat_id: number }): Promise<Chat>;
  getChatMember(input: { chat_id: number; user_id: number }): Promise<Member>;
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
}
