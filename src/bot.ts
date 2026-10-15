import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { createRuntime } from "./lib/runtime.js";
import { API_CLIENT_OPTIONS, configureApi } from "./lib/telegram.js";
import type { Bindings } from "./types.js";

/**
 * `getMe` result per bot token. A Bot is built for every request, so remembering the first
 * answer in the isolate keeps `getMe` out of the webhook path; tests seed it to skip the call.
 */
export const botInfoCache = new Map<string, UserFromGetMe>();

/** Build the request-scoped bot: every update kind the service handles, in dispatch order. */
export function createBot(env: Bindings): Bot {
  const bot = new Bot(env.BOT_TOKEN, {
    botInfo: botInfoCache.get(env.BOT_TOKEN),
    client: API_CLIENT_OPTIONS,
  });
  configureApi(bot.api);
  const { service, admin } = createRuntime(env, bot.api);

  bot.use(async (ctx, next) => {
    botInfoCache.set(env.BOT_TOKEN, ctx.me);
    await next();
  });

  bot.on("chat_join_request", (ctx) =>
    service.join(ctx.chatJoinRequest, { update: { update_id: ctx.update.update_id } }),
  );
  bot.on("callback_query", (ctx) => service.callback(ctx.callbackQuery));
  bot.on("edited_message", (ctx) => service.moderate(ctx.editedMessage, { edited: true }));
  // Join service messages are cleaned up, never filtered or treated as commands.
  bot.on("message:new_chat_members", (ctx) => service.joinNotice(ctx.msg));
  // Filter first so spam cannot hide behind an admin command prefix.
  bot.on("message", async (ctx, next) => {
    if (!(await service.moderate(ctx.msg))) await next();
  });
  bot.on("message", async (ctx, next) => {
    if (!(await admin.handle(ctx.msg))) await next();
  });
  bot.command(["start", "help"], (ctx) => service.start(ctx.msg));

  return bot;
}
