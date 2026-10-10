import { Hono } from "hono";
import type {
  Bindings,
  CallbackQuery,
  Chat,
  JoinRequest,
  Message,
  TelegramUpdate,
  User,
} from "./types.js";
import { createRuntime } from "./lib/runtime.js";

type HonoEnv = { Bindings: Bindings };
type SupportedUpdate =
  | { kind: "message"; updateId: number; value: Message }
  | { kind: "callback_query"; updateId: number; value: CallbackQuery }
  | { kind: "chat_join_request"; updateId: number; value: JoinRequest }
  | { kind: "unsupported"; updateId: number };

const app = new Hono<HonoEnv>();
const secretPattern = /^[A-Za-z0-9_-]{1,256}$/;
const supportedKeys = ["message", "callback_query", "chat_join_request"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeId(value: unknown, positive = false): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value !== 0 &&
    (!positive || value > 0)
  );
}

function parseUser(value: unknown): User | null {
  if (!record(value) || !safeId(value.id, true)) return null;
  if (value.username !== undefined && typeof value.username !== "string") return null;
  if (value.language_code !== undefined && typeof value.language_code !== "string") return null;
  return {
    id: value.id,
    ...(typeof value.username === "string" ? { username: value.username } : {}),
    ...(typeof value.language_code === "string" ? { language_code: value.language_code } : {}),
  };
}

function parseChat(value: unknown): Chat | null {
  if (!record(value) || !safeId(value.id)) return null;
  if (
    value.type !== "private" &&
    value.type !== "group" &&
    value.type !== "supergroup" &&
    value.type !== "channel"
  )
    return null;
  if (value.title !== undefined && typeof value.title !== "string") return null;
  return {
    id: value.id,
    type: value.type,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
  };
}

function parseMessage(value: unknown): Message | null {
  if (
    !record(value) ||
    typeof value.message_id !== "number" ||
    !Number.isSafeInteger(value.message_id) ||
    value.message_id < 0
  )
    return null;
  const chat = parseChat(value.chat);
  if (!chat) return null;
  const from = value.from === undefined ? undefined : parseUser(value.from);
  const senderChat = value.sender_chat === undefined ? undefined : parseChat(value.sender_chat);
  if ((value.from !== undefined && !from) || (value.sender_chat !== undefined && !senderChat))
    return null;
  if (value.text !== undefined && typeof value.text !== "string") return null;
  return {
    message_id: value.message_id,
    chat,
    ...(from ? { from } : {}),
    ...(senderChat ? { sender_chat: senderChat } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
  };
}

function parseJoinRequest(value: unknown): JoinRequest | null {
  if (!record(value)) return null;
  const chat = parseChat(value.chat);
  const from = parseUser(value.from);
  if (!chat || !from || !safeId(value.user_chat_id, true)) return null;
  if (typeof value.date !== "number" || !Number.isSafeInteger(value.date) || value.date < 0)
    return null;
  if (value.query_id !== undefined && (typeof value.query_id !== "string" || !value.query_id))
    return null;
  return {
    chat,
    from,
    user_chat_id: value.user_chat_id,
    date: value.date,
    ...(typeof value.query_id === "string" ? { query_id: value.query_id } : {}),
  };
}

function parseCallbackQuery(value: unknown): CallbackQuery | null {
  if (!record(value) || typeof value.id !== "string" || !value.id) return null;
  const from = parseUser(value.from);
  const message = value.message === undefined ? undefined : parseMessage(value.message);
  if (!from || (value.message !== undefined && !message)) return null;
  if (value.data !== undefined && typeof value.data !== "string") return null;
  return {
    id: value.id,
    from,
    ...(message ? { message } : {}),
    ...(typeof value.data === "string" ? { data: value.data } : {}),
  };
}

function parseUpdate(value: unknown): SupportedUpdate | null {
  if (
    !record(value) ||
    typeof value.update_id !== "number" ||
    !Number.isSafeInteger(value.update_id) ||
    value.update_id < 0
  )
    return null;
  const present = supportedKeys.filter((key) => Object.hasOwn(value, key));
  if (present.length === 0) return { kind: "unsupported", updateId: value.update_id };
  if (present.length !== 1) return null;

  const kind = present[0];
  if (kind === "message") {
    const message = parseMessage(value.message);
    return message ? { kind, updateId: value.update_id, value: message } : null;
  }
  if (kind === "callback_query") {
    const query = parseCallbackQuery(value.callback_query);
    return query ? { kind, updateId: value.update_id, value: query } : null;
  }
  const request = parseJoinRequest(value.chat_join_request);
  return request ? { kind, updateId: value.update_id, value: request } : null;
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
  if (!secretMatches(context.req.header("X-Telegram-Bot-Api-Secret-Token"), WEBHOOK_SECRET)) {
    return context.body(null, 401);
  }

  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "Invalid request body." }, 400);
  }
  const update = parseUpdate(body);
  if (!update) return context.json({ error: "Invalid Telegram update." }, 400);
  if (update.kind === "unsupported") return context.body(null, 200);

  try {
    const runtime = createRuntime(context.env);
    if (update.kind === "message") {
      const handled = await runtime.admin.handle(update.value);
      if (!handled && /^\/(?:start|help)(?:\s|$)/.test(update.value.text ?? "")) {
        await runtime.service.start(update.value);
      }
    } else if (update.kind === "callback_query") {
      await runtime.service.callback(update.value);
    } else {
      const telegramUpdate: TelegramUpdate = { update_id: update.updateId };
      await runtime.service.join(update.value, { update: telegramUpdate });
    }
  } catch {
    return context.json({ error: "Update processing failed." }, 500);
  }
  return context.body(null, 200);
});

export default {
  fetch: (request: Request, env: Bindings, executionCtx: ExecutionContext) =>
    app.fetch(request, env, executionCtx),
  scheduled: (_controller: ScheduledController, env: Bindings, executionCtx: ExecutionContext) => {
    executionCtx.waitUntil(createRuntime(env).service.maintenance());
  },
};
