import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings, Message } from "../src/types.js";
import type { createRuntime } from "../src/lib/runtime.js";

const runtimeMock = vi.hoisted(() => ({ createRuntime: vi.fn() }));

vi.mock("../src/lib/runtime.js", () => runtimeMock);

import worker from "../src/index.js";

const secret = "worker_test-secret_123";
const env: Bindings = {
  DB: {} as D1Database,
  BOT_TOKEN: "private-bot-token",
  WEBHOOK_SECRET: secret,
};
const executionContext = { waitUntil: vi.fn() } as unknown as ExecutionContext;
type Runtime = ReturnType<typeof createRuntime>;

function webhook(body: string, token: string | undefined = secret): Request {
  return new Request("https://worker.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { "X-Telegram-Bot-Api-Secret-Token": token }),
    },
    body,
  });
}

function runtime({
  adminResult = false,
  overrides = {},
}: {
  adminResult?: boolean;
  overrides?: Partial<Runtime["service"]>;
} = {}): Runtime {
  return {
    admin: { handle: vi.fn(async (_message: Message) => adminResult) },
    service: {
      start: vi.fn(async (_message: Message) => {}),
      callback: vi.fn(async () => {}),
      join: vi.fn(async () => {}),
      joinNotice: vi.fn(async (_message: Message) => {}),
      maintenance: vi.fn(async () => {}),
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeMock.createRuntime.mockReturnValue(runtime());
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

  it.each([
    ["missing bot token", { ...env, BOT_TOKEN: "" }],
    ["invalid webhook secret", { ...env, WEBHOOK_SECRET: "invalid secret" }],
    ["missing webhook secret", { ...env, WEBHOOK_SECRET: undefined } as unknown as Bindings],
  ] as Array<[string, Bindings]>)("fails closed for %s", async (_name, invalidEnv) => {
    const response = await worker.fetch(webhook("{}"), invalidEnv, executionContext);
    expect(response.status).toBe(500);
    expect(runtimeMock.createRuntime).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and malformed supported updates", async () => {
    const malformedJson = await worker.fetch(webhook("{"), env, executionContext);
    const malformedUpdate = await worker.fetch(
      webhook(JSON.stringify({ update_id: 1, message: { message_id: 2, chat: { id: 3 } } })),
      env,
      executionContext,
    );
    const negativeMessageId = await worker.fetch(
      webhook(
        JSON.stringify({
          update_id: 2,
          message: { message_id: -1, chat: { id: 3, type: "private" } },
        }),
      ),
      env,
      executionContext,
    );

    expect(malformedJson.status).toBe(400);
    expect(malformedUpdate.status).toBe(400);
    expect(negativeMessageId.status).toBe(400);
    expect(runtimeMock.createRuntime).not.toHaveBeenCalled();
  });

  it("returns 200 for unsupported Telegram update types without dispatching", async () => {
    const response = await worker.fetch(
      webhook(JSON.stringify({ update_id: 0, poll: { id: "poll" } })),
      env,
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(runtimeMock.createRuntime).not.toHaveBeenCalled();
  });

  it("waits for full message dispatch before acknowledging the update", async () => {
    const gate: { finish?: () => void } = {};
    const pending = new Promise<void>((resolve) => {
      gate.finish = resolve;
    });
    const instance = runtime({ overrides: { start: vi.fn((_message: Message) => pending) } });
    runtimeMock.createRuntime.mockReturnValue(instance);
    const request = webhook(
      JSON.stringify({
        update_id: 11,
        message: {
          message_id: 0,
          chat: { id: 7, type: "private" },
          from: { id: 7 },
          text: "/start",
        },
      }),
    );

    let responseReady = false;
    const responsePromise = Promise.resolve(worker.fetch(request, env, executionContext)).then(
      (response) => {
        responseReady = true;
        return response;
      },
    );
    await Promise.resolve();
    expect(responseReady).toBe(false);
    gate.finish?.();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(instance.admin.handle).toHaveBeenCalledOnce();
    expect(instance.service.start).toHaveBeenCalledOnce();
  });

  it("accepts Telegram message_id zero", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);
    const response = await worker.fetch(
      webhook(
        JSON.stringify({
          update_id: 16,
          message: { message_id: 0, chat: { id: 7, type: "private" }, text: "hello" },
        }),
      ),
      env,
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(instance.admin.handle).toHaveBeenCalledOnce();
  });

  it("routes join service messages to join-notice cleanup instead of admin commands", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);
    const response = await worker.fetch(
      webhook(
        JSON.stringify({
          update_id: 17,
          message: {
            message_id: 5,
            chat: { id: -100, type: "supergroup", title: "Group" },
            from: { id: 42, is_bot: false, first_name: "A" },
            new_chat_members: [{ id: 42, is_bot: false, first_name: "A" }],
          },
        }),
      ),
      env,
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(instance.service.joinNotice).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: 5, new_chat_members: [{ id: 42 }] }),
    );
    expect(instance.admin.handle).not.toHaveBeenCalled();
  });

  it("rejects malformed new chat members", async () => {
    const response = await worker.fetch(
      webhook(
        JSON.stringify({
          update_id: 18,
          message: {
            message_id: 5,
            chat: { id: -100, type: "supergroup" },
            new_chat_members: [{}],
          },
        }),
      ),
      env,
      executionContext,
    );

    expect(response.status).toBe(400);
  });

  it("dispatches callback queries and join requests with their update ID", async () => {
    const instance = runtime();
    runtimeMock.createRuntime.mockReturnValue(instance);
    const callback = await worker.fetch(
      webhook(
        JSON.stringify({
          update_id: 12,
          callback_query: { id: "callback-id", from: { id: 7 }, data: "answer" },
        }),
      ),
      env,
      executionContext,
    );
    const join = await worker.fetch(
      webhook(
        JSON.stringify({
          update_id: 13,
          chat_join_request: {
            chat: { id: -1009, type: "supergroup", title: "Private group" },
            from: { id: 7 },
            user_chat_id: 7,
            date: 1_800_000_000,
          },
        }),
      ),
      env,
      executionContext,
    );

    expect(callback.status).toBe(200);
    expect(join.status).toBe(200);
    expect(instance.service.callback).toHaveBeenCalledWith({
      id: "callback-id",
      from: { id: 7 },
      data: "answer",
    });
    expect(instance.service.join).toHaveBeenCalledWith(
      {
        chat: { id: -1009, type: "supergroup", title: "Private group" },
        from: { id: 7 },
        user_chat_id: 7,
        date: 1_800_000_000,
      },
      { update: { update_id: 13 } },
    );
  });

  it("returns a retryable failure when dispatch or runtime construction fails", async () => {
    runtimeMock.createRuntime.mockReturnValue(
      runtime({ overrides: { callback: vi.fn(async () => Promise.reject(new Error("private"))) } }),
    );
    const response = await worker.fetch(
      webhook(JSON.stringify({ update_id: 14, callback_query: { id: "cb", from: { id: 2 } } })),
      env,
      executionContext,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Update processing failed." });

    runtimeMock.createRuntime.mockImplementation(() => {
      throw new Error(`failed for ${env.BOT_TOKEN}`);
    });
    const secondResponse = await worker.fetch(
      webhook(JSON.stringify({ update_id: 15, callback_query: { id: "cb", from: { id: 2 } } })),
      env,
      executionContext,
    );
    expect(secondResponse.status).toBe(500);
    expect(await secondResponse.text()).not.toContain(env.BOT_TOKEN);
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
