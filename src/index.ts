import { Hono } from "hono";
import { BotError, GrammyError, webhookCallback } from "grammy";
import type { Bindings } from "./types.js";
import { createBot } from "./bot.js";
import { apiError } from "./lib/api-error.js";
import { createRuntime } from "./lib/runtime.js";

export { SessionTimer } from "./timer.js";

type HonoEnv = { Bindings: Bindings };

const app = new Hono<HonoEnv>();
const secretPattern = /^[A-Za-z0-9_-]{1,256}$/;
// Handlers make several D1 and Telegram calls; past this the update is answered 500 and
// redelivered, which revision CAS and leases make safe even while the first run continues.
const UPDATE_TIMEOUT_MS = 25_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSecret(value: string | undefined): value is string {
  return value !== undefined && secretPattern.test(value);
}

function secretMatches(received: string | undefined, expected: string): boolean {
  if (received === undefined) return false;
  let difference = received.length ^ expected.length;
  const count = Math.max(received.length, expected.length);
  for (let index = 0; index < count; index += 1) {
    difference |= (received.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

app.get("/", (context) => context.json({ status: "ok" }));

app.post("/webhook", async (context) => {
  const { BOT_TOKEN, WEBHOOK_SECRET } = context.env;
  if (!BOT_TOKEN?.trim() || !validSecret(WEBHOOK_SECRET)) {
    return context.json({ error: "Service is not configured." }, 500);
  }
  // grammY reads the body before it checks the secret, so authenticate first.
  if (!secretMatches(context.req.header("X-Telegram-Bot-Api-Secret-Token"), WEBHOOK_SECRET)) {
    return context.body(null, 401);
  }

  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "Invalid request body." }, 400);
  }
  if (!record(body) || !Number.isSafeInteger(body.update_id)) {
    return context.json({ error: "Invalid Telegram update." }, 400);
  }

  // Await the whole update before acknowledging it; a failure surfaces as a 500 below.
  try {
    return await webhookCallback(createBot(context.env), "hono", {
      secretToken: WEBHOOK_SECRET,
      timeoutMilliseconds: UPDATE_TIMEOUT_MS,
      onTimeout: "throw",
    })(context);
  } catch (error) {
    // Webhook updates never reach `bot.catch`, and a BotError message embeds the cause's
    // text. Log only the update ID and the API error code, then rethrow so Telegram retries.
    const cause = error instanceof BotError ? error.error : error;
    const code = cause instanceof GrammyError ? cause.error_code : apiError(cause).code;
    console.warn("Update processing failed", body.update_id, code);
    throw error;
  }
});

app.onError((_error, context) => context.json({ error: "Update processing failed." }, 500));

export default {
  fetch: (request: Request, env: Bindings, executionCtx: ExecutionContext) =>
    app.fetch(request, env, executionCtx),
  scheduled: (_controller: ScheduledController, env: Bindings, executionCtx: ExecutionContext) => {
    executionCtx.waitUntil(createRuntime(env).service.maintenance());
  },
};
