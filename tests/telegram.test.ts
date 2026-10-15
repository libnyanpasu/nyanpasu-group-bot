import { Api, HttpError } from "grammy";
import { describe, expect, it } from "vitest";

import {
  API_CLIENT_OPTIONS,
  configureApi,
  createApi,
  createTelegramApi,
  TelegramApiError,
} from "../src/lib/telegram.js";

type Reply = { ok: true; result: unknown } | { ok: false; error_code: number; description: string };
type Recorded = { method: string; payload: unknown };

/** Stand in for the network: every call the Api makes lands here instead of in fetch. */
function fakeTransport(replies: Array<Reply | Error>) {
  const calls: Recorded[] = [];
  const transformer = (async (_prev: unknown, method: string, payload: unknown) => {
    calls.push({ method, payload });
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (reply instanceof Error) throw reply;
    return reply;
  }) as Parameters<Api["config"]["use"]>[0];
  return { calls, transformer };
}

function apiWith(replies: Array<Reply | Error>, token = "123:secret") {
  const transport = fakeTransport(replies);
  // The last transformer installed is the outermost: fake the network first, then add retry.
  const api = new Api(token, API_CLIENT_OPTIONS);
  api.config.use(transport.transformer);
  configureApi(api);
  return { ...transport, port: createTelegramApi(token, api) };
}

describe("grammY-backed Telegram Bot API", () => {
  it("sends each port method as the matching Bot API call", async () => {
    const { calls, port } = apiWith([
      { ok: true, result: { message_id: 5, chat: { id: 9, type: "private" } } },
    ]);

    await expect(port.sendMessage({ chat_id: 9, text: "hello" })).resolves.toMatchObject({
      message_id: 5,
    });
    expect(calls).toEqual([{ method: "sendMessage", payload: { chat_id: 9, text: "hello" } }]);
  });

  it("accepts boolean results and covers deleteMessage", async () => {
    const { calls, port } = apiWith([{ ok: true, result: true }]);

    await expect(port.answerCallbackQuery({ callback_query_id: "cb" })).resolves.toBe(true);
    await expect(port.deleteMessage({ chat_id: -1001, message_id: 5 })).resolves.toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery", "deleteMessage"]);
  });

  it("preserves Telegram error code, retry_after, and a redacted description", async () => {
    const { port } = apiWith([
      {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry at https://example.test/123:secret",
        parameters: { retry_after: 12 },
      } as Reply,
    ]);

    await expect(
      port.approveChatJoinRequest({ chat_id: -1001, user_id: 42 }),
    ).rejects.toMatchObject({
      code: 429,
      parameters: { retry_after: 12 },
      description: "Too Many Requests: retry at [redacted URL]",
    });
  });

  it("redacts the token even when it appears outside a URL", async () => {
    const { port } = apiWith([
      { ok: false, error_code: 400, description: "Bad Request: token 123:secret rejected" },
    ]);

    await expect(port.getMe()).rejects.toMatchObject({
      code: 400,
      description: "Bad Request: token [redacted] rejected",
    });
  });

  it("retries a short 429 once and returns the second answer", async () => {
    const { calls, port } = apiWith([
      {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 0 },
      } as Reply,
      { ok: true, result: true },
    ]);

    await expect(port.deleteMessage({ chat_id: 1, message_id: 2 })).resolves.toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("does not sleep through a long 429; the service persists retry_after instead", async () => {
    const { calls, port } = apiWith([
      {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 30 },
      } as Reply,
    ]);

    await expect(port.deleteMessage({ chat_id: 1, message_id: 2 })).rejects.toMatchObject({
      code: 429,
      parameters: { retry_after: 30 },
    });
    expect(calls).toHaveLength(1);
  });

  it("does not retry server errors, which may have been applied", async () => {
    const { calls, port } = apiWith([{ ok: false, error_code: 502, description: "Bad Gateway" }]);

    await expect(port.sendMessage({ chat_id: 1, text: "x" })).rejects.toMatchObject({ code: 502 });
    expect(calls).toHaveLength(1);
  });

  it("normalizes transport failures without exposing network errors or credentials", async () => {
    const { calls, port } = apiWith([
      new HttpError(
        "Network request for 'getMe' failed!",
        new Error("failed https://api.telegram.org/bot123:secret/getMe"),
      ),
    ]);

    let caught: unknown;
    try {
      await port.getMe();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramApiError);
    if (!(caught instanceof TelegramApiError)) throw new Error("Expected a Telegram API error.");
    expect(caught.code).toBeUndefined();
    expect(caught.message).not.toContain("123:secret");
    expect(caught.message).not.toContain("https://");
    expect(caught.cause).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("keeps webhook replies off and bounds each request", () => {
    expect(API_CLIENT_OPTIONS.timeoutSeconds).toBe(15);
    expect(API_CLIENT_OPTIONS.canUseWebhookReply?.("approveChatJoinRequest")).toBe(false);
    expect(createApi("token").options).toBe(API_CLIENT_OPTIONS);
  });

  it("requires a bot token", () => {
    expect(() => createApi("  ")).toThrow("Telegram bot token is required.");
  });
});
