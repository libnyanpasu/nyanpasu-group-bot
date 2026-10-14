import { drizzle } from "drizzle-orm/d1";
import type { Bindings } from "../types.js";
import { createAdmin } from "./admin.js";
import { createRepository } from "./repository.js";
import { createService } from "./service.js";
import { spamDefaultsFromEnv } from "./spam.js";
import { createTelegramApi } from "./telegram.js";

/** Parse a boolean Worker variable; anything other than "true" or "1" is off. */
export function envFlag(value: string | undefined): boolean {
  return /^(?:true|1)$/i.test(value?.trim() ?? "");
}

/** Construct isolated dependencies for one Worker request or scheduled run. */
export function createRuntime(env: Bindings) {
  const api = createTelegramApi(env.BOT_TOKEN);
  const repository = createRepository(drizzle(env.DB));
  const defaultDeleteJoinMessages = envFlag(env.DELETE_JOIN_MESSAGES);
  const spamDefaults = spamDefaultsFromEnv(env);
  return {
    service: createService({ api, repository, defaultDeleteJoinMessages, spamDefaults }),
    admin: { handle: createAdmin({ api, repository, defaultDeleteJoinMessages, spamDefaults }) },
  };
}
