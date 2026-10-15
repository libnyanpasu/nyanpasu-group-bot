import type { BotApi } from "../../src/types.js";

/** A Bot API call the fake recorded, keyed by method name. */
export type FakeCall =
  | { method: "sendMessage"; args: Parameters<BotApi["sendMessage"]>[0] }
  | { method: "editMessageText"; args: Parameters<BotApi["editMessageText"]>[0] }
  | { method: "answerCallbackQuery"; args: Parameters<BotApi["answerCallbackQuery"]>[0] }
  | { method: "setMyCommands"; args: Parameters<BotApi["setMyCommands"]>[0] }
  | { method: "approveChatJoinRequest"; args: Parameters<BotApi["approveChatJoinRequest"]>[0] }
  | { method: "declineChatJoinRequest"; args: Parameters<BotApi["declineChatJoinRequest"]>[0] }
  | {
      method: "answerChatJoinRequestQuery";
      args: Parameters<BotApi["answerChatJoinRequestQuery"]>[0];
    }
  | { method: "deleteMessage"; args: Parameters<BotApi["deleteMessage"]>[0] }
  | { method: "banChatMember"; args: Parameters<BotApi["banChatMember"]>[0] }
  | { method: "banChatSenderChat"; args: Parameters<BotApi["banChatSenderChat"]>[0] }
  | { method: "getChatMember"; args: Parameters<BotApi["getChatMember"]>[0] };

export interface FakeBotApi {
  api: BotApi;
  calls: FakeCall[];
}

/**
 * Build a recording `BotApi` whose calls succeed. Pass `overrides` to inject failures or
 * custom results; overridden methods are not recorded unless the override records itself.
 */
export function createFakeBotApi(overrides: Partial<BotApi> = {}): FakeBotApi {
  const calls: FakeCall[] = [];
  let nextMessageId = 1000;
  const api: BotApi = {
    async sendMessage(args) {
      calls.push({ method: "sendMessage", args });
      return {
        message_id: nextMessageId++,
        chat: { id: args.chat_id, type: "private" },
      };
    },
    async editMessageText(args) {
      calls.push({ method: "editMessageText", args });
      return true;
    },
    async answerCallbackQuery(args) {
      calls.push({ method: "answerCallbackQuery", args });
      return true;
    },
    async setMyCommands(args) {
      calls.push({ method: "setMyCommands", args });
      return true;
    },
    async approveChatJoinRequest(args) {
      calls.push({ method: "approveChatJoinRequest", args });
      return true;
    },
    async declineChatJoinRequest(args) {
      calls.push({ method: "declineChatJoinRequest", args });
      return true;
    },
    async answerChatJoinRequestQuery(args) {
      calls.push({ method: "answerChatJoinRequestQuery", args });
      return true;
    },
    async deleteMessage(args) {
      calls.push({ method: "deleteMessage", args });
      return true;
    },
    async createChatInviteLink() {
      return { invite_link: "https://t.me/+test" };
    },
    async getMe() {
      return { id: 1 };
    },
    async getChat({ chat_id }) {
      return { id: chat_id, type: "private" };
    },
    async getChatMember(args) {
      calls.push({ method: "getChatMember", args });
      return { status: "member" };
    },
    async banChatMember(args) {
      calls.push({ method: "banChatMember", args });
      return true;
    },
    async banChatSenderChat(args) {
      calls.push({ method: "banChatSenderChat", args });
      return true;
    },
    ...overrides,
  };
  return { api, calls };
}
