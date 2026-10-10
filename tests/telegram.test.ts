import { describe, expect, it } from "vitest";

import { createTelegramApi, TelegramApiError } from "../src/lib/telegram.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetch-based Telegram Bot API", () => {
  it("posts JSON to the selected method with a bounded timeout", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const api = createTelegramApi("123:secret", async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return response({ ok: true, result: { message_id: 5, chat: { id: 9, type: "private" } } });
    });

    await expect(api.sendMessage({ chat_id: 9, text: "hello" })).resolves.toMatchObject({
      message_id: 5,
    });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://api.telegram.org/bot123:secret/sendMessage");
    expect(request.init.method).toBe("POST");
    expect(request.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(request.init.body as string)).toEqual({ chat_id: 9, text: "hello" });
    expect(request.init.signal).toBeInstanceOf(AbortSignal);
    expect(request.init.signal).toHaveProperty("aborted", false);
  });

  it("preserves Telegram error code, retry_after, and safe description", async () => {
    const api = createTelegramApi("123:secret", async () =>
      response(
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry at https://example.test/123:secret",
          parameters: { retry_after: 12 },
        },
        429,
      ),
    );

    await expect(api.approveChatJoinRequest({ chat_id: -1001, user_id: 42 })).rejects.toMatchObject(
      {
        code: 429,
        parameters: { retry_after: 12 },
        description: "Too Many Requests: retry at [redacted URL]",
      },
    );
  });

  it("normalizes transport failures without exposing fetch errors or credentials", async () => {
    const api = createTelegramApi("123:secret", async () => {
      throw new Error("failed https://api.telegram.org/bot123:secret/sendMessage");
    });

    let caught: unknown;
    try {
      await api.getMe();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramApiError);
    if (!(caught instanceof TelegramApiError)) throw new Error("Expected a Telegram API error.");
    expect(caught.message).not.toContain("123:secret");
    expect(caught.message).not.toContain("https://");
    expect(caught.cause).toBeUndefined();
  });

  it("rejects malformed responses and success bodies without a result", async () => {
    const invalidJson = createTelegramApi("token", async () => new Response("not-json"));
    await expect(invalidJson.getMe()).rejects.toBeInstanceOf(TelegramApiError);

    const missingResult = createTelegramApi("token", async () => response({ ok: true }));
    await expect(missingResult.getMe()).rejects.toBeInstanceOf(TelegramApiError);
  });

  it("accepts boolean results and covers deleteMessage", async () => {
    const methods: Array<string | undefined> = [];
    const api = createTelegramApi("token", async (input) => {
      methods.push(String(input).split("/").at(-1));
      return response({ ok: true, result: true });
    });

    await expect(api.answerCallbackQuery({ callback_query_id: "cb" })).resolves.toBe(true);
    await expect(api.deleteMessage({ chat_id: -1001, message_id: 5 })).resolves.toBe(true);
    expect(methods).toEqual(["answerCallbackQuery", "deleteMessage"]);
  });
});
