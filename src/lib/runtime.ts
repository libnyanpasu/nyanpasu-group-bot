import { drizzle } from "drizzle-orm/d1";
import type { Bindings } from "../types.js";
import { createAdmin } from "./admin.js";
import { createRepository } from "./repository.js";
import { createService } from "./service.js";
import { createTelegramApi } from "./telegram.js";

/** Construct isolated dependencies for one Worker request or scheduled run. */
export function createRuntime(env: Bindings) {
  const api = createTelegramApi(env.BOT_TOKEN);
  const repository = createRepository(drizzle(env.DB));
  return {
    service: createService({ api, repository }),
    admin: { handle: createAdmin({ api, repository }) },
  };
}
