import type { BotApi } from "../types.js";

type TelegramParameters = { retry_after?: number };

type TelegramErrorDetails = {
  code?: number;
  description?: string;
  parameters?: TelegramParameters;
};

/** A safe, typed error shape consumed by the service retry and API handling. */
export class TelegramApiError extends Error {
  readonly code?: number;
  readonly description?: string;
  readonly parameters?: TelegramParameters;

  constructor(details: TelegramErrorDetails = {}) {
    super("Telegram API request failed.");
    this.name = "TelegramApiError";
    this.code = details.code;
    this.description = details.description;
    this.parameters = details.parameters;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiDescription(value: unknown, token: string): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .split(token)
    .join("[redacted]")
    .replace(/https?:\/\/\S+/gi, "[redacted URL]");
}

function apiParameters(value: unknown): TelegramParameters | undefined {
  if (!isRecord(value)) return undefined;
  const retryAfter = value.retry_after;
  return typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter >= 0
    ? { retry_after: retryAfter }
    : undefined;
}

/** Build a Bot API implementation that uses only the Workers fetch runtime. */
export function createTelegramApi(token: string, fetcher: typeof fetch = fetch): BotApi {
  if (!token.trim()) throw new Error("Telegram bot token is required.");

  async function call<Result>(method: string, input: object): Promise<Result> {
    let response: Response;
    try {
      response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new TelegramApiError();
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramApiError({ code: response.status });
    }

    if (!isRecord(payload)) throw new TelegramApiError({ code: response.status });

    if (payload.ok !== true) {
      const code =
        typeof payload.error_code === "number" && Number.isSafeInteger(payload.error_code)
          ? payload.error_code
          : response.status;
      throw new TelegramApiError({
        code,
        description: apiDescription(payload.description, token),
        parameters: apiParameters(payload.parameters),
      });
    }

    if (!response.ok || !Object.hasOwn(payload, "result")) {
      throw new TelegramApiError({ code: response.status });
    }
    return payload.result as Result;
  }

  return {
    createChatInviteLink: (input) => call("createChatInviteLink", input),
    sendMessage: (input) => call("sendMessage", input),
    editMessageText: (input) => call("editMessageText", input),
    answerCallbackQuery: (input) => call("answerCallbackQuery", input),
    approveChatJoinRequest: (input) => call("approveChatJoinRequest", input),
    declineChatJoinRequest: (input) => call("declineChatJoinRequest", input),
    answerChatJoinRequestQuery: (input) => call("answerChatJoinRequestQuery", input),
    deleteMessage: (input) => call("deleteMessage", input),
    getMe: () => call("getMe", {}),
    getChat: (input) => call("getChat", input),
    getChatMember: (input) => call("getChatMember", input),
  };
}
