import { drizzle } from "drizzle-orm/d1";
import type { Api } from "grammy";
import type { Bindings } from "../types.js";
import { createAdmin } from "./admin.js";
import { createRepository } from "./repository.js";
import { createService } from "./service.js";
import { spamDefaultsFromEnv } from "./spam.js";
import { createApi, createTelegramApi } from "./telegram.js";

/** Parse a boolean Worker variable; anything other than "true" or "1" is off. */
export function envFlag(value: string | undefined): boolean {
  return /^(?:true|1)$/i.test(value?.trim() ?? "");
}

/**
 * Construct isolated dependencies for one Worker request or scheduled run. Webhook requests
 * share the bot's grammY `Api`; scheduled runs have no bot and build their own.
 */
export function createRuntime(env: Bindings, grammyApi: Api = createApi(env.BOT_TOKEN)) {
  const api = createTelegramApi(env.BOT_TOKEN, grammyApi);
  const repository = createRepository(drizzle(env.DB));
  const defaultDeleteJoinMessages = envFlag(env.DELETE_JOIN_MESSAGES);
  const spamDefaults = spamDefaultsFromEnv(env);
  return {
    service: createService({ api, repository, defaultDeleteJoinMessages, spamDefaults }),
    admin: { handle: createAdmin({ api, repository, defaultDeleteJoinMessages, spamDefaults }) },
  };
}
