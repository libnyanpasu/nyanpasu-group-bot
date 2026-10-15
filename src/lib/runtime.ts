import { drizzle } from "drizzle-orm/d1";
import type { Api } from "grammy";
import type { Bindings } from "../types.js";
import { createAdmin } from "./admin.js";
import { createRepository } from "./repository.js";
import { type ScheduleTimer, withScheduling } from "./schedule.js";
import { createService } from "./service.js";
import { spamDefaultsFromEnv } from "./spam.js";
import { createApi, createTelegramApi } from "./telegram.js";

/** Parse a boolean Worker variable; anything other than "true" or "1" is off. */
export function envFlag(value: string | undefined): boolean {
  return /^(?:true|1)$/i.test(value?.trim() ?? "");
}

/** Arm a session's Durable Object timer, when the binding exists. */
export function timerFor(env: Bindings): ScheduleTimer | null {
  const namespace = env.SESSION_TIMER;
  if (!namespace) return null;
  return (key, at) => namespace.get(namespace.idFromName(key)).schedule(key, at);
}

/**
 * Construct isolated dependencies for one Worker request or scheduled run. Webhook requests
 * share the bot's grammY `Api`; scheduled runs have no bot and build their own. Writes arm
 * the session's timer unless `timer` is null (the timer itself re-arms from its own run).
 */
export function createRuntime(
  env: Bindings,
  grammyApi: Api = createApi(env.BOT_TOKEN),
  timer: ScheduleTimer | null = timerFor(env),
) {
  const api = createTelegramApi(env.BOT_TOKEN, grammyApi);
  const store = createRepository(drizzle(env.DB));
  const repository = timer ? withScheduling(store, timer) : store;
  const defaultDeleteJoinMessages = envFlag(env.DELETE_JOIN_MESSAGES);
  const spamDefaults = spamDefaultsFromEnv(env);
  return {
    service: createService({ api, repository, defaultDeleteJoinMessages, spamDefaults }),
    admin: createAdmin({ api, repository, defaultDeleteJoinMessages, spamDefaults }),
  };
}
