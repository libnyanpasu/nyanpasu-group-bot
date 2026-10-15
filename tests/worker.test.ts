import type { UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminCommand } from "../src/lib/admin.js";
import type { Bindings, CallbackQuery, Message } from "../src/types.js";
import type { createRuntime } from "../src/lib/runtime.js";

const runtimeMock = vi.hoisted(() => ({ createRuntime: vi.fn() }));

vi.mock("../src/lib/runtime.js", () => runtimeMock);

import { botInfoCache } from "../src/bot.js";
import worker from "../src/index.js";

const secret = "worker_test-secret_123";
const env: Bindings = {
  DB: {} as D1Database,
  BOT_TOKEN: "private-bot-token",
  WEBHOOK_SECRET: secret,
};
const botInfo = {
  id: 1,
  is_bot: true,
  first_name: "Verify",
  username: "verify_bot",
} as UserFromGetMe;
const executionContext = { waitUntil: vi.fn() } as unknown as ExecutionContext;
type Runtime = ReturnType<typeof createRuntime>;

function webhook(body: string, token: string | null = secret): Request {
  return new Request("https://worker.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { "X-Telegram-Bot-Api-Secret-Token": token }),
    },
    body,
  });
}

/** A text message from a private chat; commands carry the bot_command entity Telegram adds. */
function textMessage(text: string, extra: Record<string, unknown> = {}) {
  const command = /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?/.exec(text);
  return {
    message_id: 5,
    date: 1_800_000_000,
    chat: { id: 7, type: "private" },
    from: { id: 7, is_bot: false, first_name: "A" },
    text,
    ...(command
      ? { entities: [{ type: "bot_command", offset: 0, length: command[0].length }] }
      : {}),
    ...extra,
  };
}

function runtime({
  overrides = {},
}: {
  overrides?: Partial<Runtime["service"]>;
} = {}): Runtime {
  return {
    admin: {
      handle: vi.fn(async (_message: Message, _command: AdminCommand) => {}),
      chatShared: vi.fn(async (_message: Message) => {}),
      open: vi.fn(async (_message: Message, _payload: string) => false),
      callback: vi.fn(async (_query: CallbackQuery) => {}),
    },
    service: {
      start: vi.fn(async (_message: Message) => {}),
      callback: vi.fn(async () => {}),
      join: vi.fn(async () => {}),
      joinNotice: vi.fn(async (_message: Message) => {}),
      moderate: vi.fn(async (_message: Message, _options?: { edited?: boolean }) => false),
      maintenance: vi.fn(async () => {}),
      maintainSession: vi.fn(async (_key: string) => null),
      ...overrides,
    },
  };
}

function send(update: unknown) {
  return worker.fetch(webhook(JSON.stringify(update)), env, executionContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  botInfoCache.clear();
  botInfoCache.set(env.BOT_TOKEN, botInfo);
  runtimeMock.createRuntime.mockReturnValue(runtime());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cloudflare Worker webhook", () => {
  it("serves a minimal health response without runtime bindings", async () => {
    const response = await worker.fetch(
      new Request("https://worker.test/"),
      {} as Bindings,
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(runtimeMock.createRuntime).not.toHaveBeenCalled();
  });

  it("checks the secret before parsing JSON or constructing a runtime", async () => {
    const response = await worker.fetch(webhook("not-json", "wrong-secret"), env, executionContext);

    expect(response.status).toBe(401);
    expect(runtimeMock.createRuntime).not.toHaveBeenCalled();
  });

  it("rejects a request without the secret header", async () => {
    const response = await worker.fetch(webhook("{}", null), env, executionContext);

    expect(response.status).toBe(401);
    expect(runtimeMock.createRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ["missing bot token", { ...env, BOT_TOKEN: "" }],
    ["invalid webhook secret", { ...env, WEBHOOK_SECRET: "invalid secret" }],
    ["missing webhook secret", { ...env, WEBHOOK_SECRET: undefined } as unknown as Bindings],
  ] as Array<[string, Bindings]>)("fails closed for %s", async (_name, invalidEnv) => {
    const response = await worker.fetch(webhook("{}"), invalidEnv, executionContext);
    expect(response.status).toBe(500);
    expect(runtimeMock.createRuntime).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and bodies that are not updates", async () => {
    for (const body of ["{", "null", "[]", "{}", JSON.stringify({ update_id: "1" })]) {
      const response = await worker.fetch(webhook(body), env, executionContext);
      expect(response.status, body).toBe(400);
    }
    expect(runtimeMock.createRuntime).not.toHaveBeenCalled();
  });

  it("acknowledges unsupported update types without dispatching", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);

    const response = await send({ update_id: 0, poll: { id: "poll" } });

    expect(response.status).toBe(200);
    for (const handler of [
      ...Object.values(instance.service).filter(
        (fn) => fn !== instance.service.maintenance && fn !== instance.service.maintainSession,
      ),
      instance.admin.handle,
      instance.admin.chatShared,
      instance.admin.open,
      instance.admin.callback,
    ]) {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("waits for full message dispatch before acknowledging the update", async () => {
    const gate: { finish?: () => void } = {};
    const pending = new Promise<void>((resolve) => {
      gate.finish = resolve;
    });
    const instance = runtime({ overrides: { start: vi.fn((_message: Message) => pending) } });
    runtimeMock.createRuntime.mockReturnValue(instance);

    let responseReady = false;
    const responsePromise = (async () => {
      const response = await send({ update_id: 11, message: textMessage("/start") });
      responseReady = true;
      return response;
    })();
    await vi.waitFor(() => expect(instance.service.start).toHaveBeenCalledOnce());
    expect(responseReady).toBe(false);
    gate.finish?.();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(instance.service.moderate).toHaveBeenCalledOnce();
    expect(instance.admin.handle).not.toHaveBeenCalled();
  });

  it("routes /start and /help to the start flow only when addressed to this bot", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);

    await send({ update_id: 1, message: textMessage("/help") });
    await send({ update_id: 2, message: textMessage("/start@verify_bot payload") });
    await send({ update_id: 3, message: textMessage("/start@someone_else_bot") });
    await send({ update_id: 4, message: textMessage("hello /start") });

    expect(instance.service.start).toHaveBeenCalledTimes(2);
  });

  it("opens a group from a /start deep link and skips the start flow when it handled it", async () => {
    const instance = runtime();
    instance.admin.open = vi.fn(async () => true);
    runtimeMock.createRuntime.mockReturnValue(instance);

    await send({ update_id: 30, message: textMessage("/start s1234567890") });

    expect(instance.admin.open).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: 5 }),
      "s1234567890",
    );
    expect(instance.service.start).not.toHaveBeenCalled();
  });

  it("falls back to the start flow for payloads that are not group links", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);

    await send({ update_id: 31, message: textMessage("/start hello") });
    await send({ update_id: 32, message: textMessage("/start") });

    expect(instance.admin.open).toHaveBeenCalledOnce();
    expect(instance.admin.open).toHaveBeenCalledWith(expect.anything(), "hello");
    expect(instance.service.start).toHaveBeenCalledTimes(2);
  });

  it("routes a picked group to the admin handler instead of the spam filter or commands", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);

    const response = await send({
      update_id: 33,
      message: textMessage("", {
        text: undefined,
        chat_shared: { request_id: 1, chat_id: -1001234567890 },
      }),
    });

    expect(response.status).toBe(200);
    expect(instance.admin.chatShared).toHaveBeenCalledWith(
      expect.objectContaining({ chat_shared: { request_id: 1, chat_id: -1001234567890 } }),
    );
    expect(instance.admin.handle).not.toHaveBeenCalled();
    expect(instance.service.start).not.toHaveBeenCalled();
  });

  it("routes admin commands with their arguments and does not start", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);

    const response = await send({
      update_id: 5,
      message: textMessage("/verify_config@verify_bot language=en  timeoutSeconds=60 "),
    });
    await send({ update_id: 6, message: textMessage("/verify_help@someone_else_bot") });
    await send({ update_id: 7, message: textMessage("/verify_unknown") });

    expect(response.status).toBe(200);
    expect(instance.admin.handle).toHaveBeenCalledOnce();
    expect(instance.admin.handle).toHaveBeenCalledWith(expect.objectContaining({ message_id: 5 }), {
      name: "verify_config",
      args: "language=en  timeoutSeconds=60",
    } satisfies AdminCommand);
    expect(instance.service.start).not.toHaveBeenCalled();
  });

  it("routes join service messages to join-notice cleanup instead of filters or commands", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);

    const response = await send({
      update_id: 17,
      message: {
        message_id: 5,
        date: 1_800_000_000,
        chat: { id: -100, type: "supergroup", title: "Group" },
        from: { id: 42, is_bot: false, first_name: "A" },
        new_chat_members: [{ id: 42, is_bot: false, first_name: "A" }],
      },
    });

    expect(response.status).toBe(200);
    expect(instance.service.joinNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        message_id: 5,
        new_chat_members: [{ id: 42, is_bot: false, first_name: "A" }],
      }),
    );
    expect(instance.service.moderate).not.toHaveBeenCalled();
    expect(instance.admin.handle).not.toHaveBeenCalled();
  });

  it("filters group messages before admin commands and stops when one is removed", async () => {
    const instance = runtime({ overrides: { moderate: vi.fn(async () => true) } });
    runtimeMock.createRuntime.mockReturnValue(instance);

    const response = await send({
      update_id: 19,
      message: textMessage("/verify_help buy now", {
        chat: { id: -100, type: "supergroup" },
        from: { id: 42, is_bot: false, first_name: "Spam" },
        reply_markup: { inline_keyboard: [[{ text: "Join", url: "https://t.me/x" }]] },
        forward_origin: {
          type: "channel",
          date: 1_800_000_000,
          chat: { id: -1009, type: "channel", title: "Ads" },
          message_id: 3,
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(instance.service.moderate).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { id: 42, is_bot: false, first_name: "Spam" },
        reply_markup: { inline_keyboard: [[{ text: "Join", url: "https://t.me/x" }]] },
        forward_origin: expect.objectContaining({ type: "channel" }),
      }),
    );
    expect(instance.admin.handle).not.toHaveBeenCalled();
    expect(instance.service.start).not.toHaveBeenCalled();
  });

  it("only filters edited messages", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);

    const response = await send({
      update_id: 20,
      edited_message: textMessage("/verify_help", { chat: { id: -100, type: "supergroup" } }),
    });

    expect(response.status).toBe(200);
    expect(instance.service.moderate).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: 5 }),
      { edited: true },
    );
    expect(instance.admin.handle).not.toHaveBeenCalled();
  });

  it("sends settings-panel buttons to the admin handler and quiz buttons to the service", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);
    const from = { id: 7, is_bot: false, first_name: "A" };

    await send({
      update_id: 40,
      callback_query: { id: "panel", from, data: "c:s1234567890:to" },
    });
    await send({ update_id: 41, callback_query: { id: "quiz", from, data: "q:nonce:0:1" } });

    expect(instance.admin.callback).toHaveBeenCalledOnce();
    expect(instance.admin.callback).toHaveBeenCalledWith(
      expect.objectContaining({ id: "panel", data: "c:s1234567890:to" }),
    );
    expect(instance.service.callback).toHaveBeenCalledOnce();
    expect(instance.service.callback).toHaveBeenCalledWith(expect.objectContaining({ id: "quiz" }));
  });

  it("dispatches callback queries and join requests with their update ID", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);
    const query = { id: "callback-id", from: { id: 7, is_bot: false, first_name: "A" }, data: "x" };
    const request = {
      chat: { id: -1009, type: "supergroup", title: "Private group" },
      from: { id: 7, is_bot: false, first_name: "A" },
      user_chat_id: 7,
      date: 1_800_000_000,
    };

    const callback = await send({ update_id: 12, callback_query: query });
    const join = await send({ update_id: 13, chat_join_request: request });

    expect(callback.status).toBe(200);
    expect(join.status).toBe(200);
    expect(instance.service.callback).toHaveBeenCalledWith(expect.objectContaining(query));
    expect(instance.service.join).toHaveBeenCalledWith(expect.objectContaining(request), {
      update: { update_id: 13 },
    });
  });

  it("returns a retryable failure without leaking the update or the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runtimeMock.createRuntime.mockReturnValue(
      runtime({
        overrides: {
          callback: vi.fn(async () =>
            Promise.reject(new Error("private-bot-token private-callback-data")),
          ),
        },
      }),
    );

    const response = await send({
      update_id: 14,
      callback_query: {
        id: "cb",
        from: { id: 2, is_bot: false, first_name: "A" },
        data: "secret-answer",
      },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Update processing failed." });
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).toContain("14");
    expect(logged).not.toContain("private-bot-token");
    expect(logged).not.toContain("secret-answer");
    expect(logged).not.toContain("private-callback-data");
  });

  it("returns a retryable failure when runtime construction fails", async () => {
    runtimeMock.createRuntime.mockImplementation(() => {
      throw new Error(`failed for ${env.BOT_TOKEN}`);
    });

    const response = await send({ update_id: 15, callback_query: { id: "cb", from: { id: 2 } } });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(env.BOT_TOKEN);
  });
});

describe("Cloudflare Worker scheduled maintenance", () => {
  it("hands the maintenance promise to waitUntil", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);
    const waitUntil = vi.fn();

    worker.scheduled({} as ScheduledController, env, { waitUntil } as unknown as ExecutionContext);

    expect(runtimeMock.createRuntime).toHaveBeenCalledWith(env);
    expect(instance.service.maintenance).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
});
