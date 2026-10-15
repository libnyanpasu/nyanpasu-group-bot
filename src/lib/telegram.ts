import { autoRetry } from "@grammyjs/auto-retry";
import { Api, GrammyError, type ApiClientOptions } from "grammy";
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

/**
 * Options for every grammY `Api`. Webhook replies stay off because a decision must be
 * persisted around the real API result, and the timeout bounds one request, not a retry.
 */
export const API_CLIENT_OPTIONS: ApiClientOptions = {
  timeoutSeconds: 15,
  canUseWebhookReply: () => false,
};

/**
 * Retry only 429, which Telegram rejects before acting. 5xx and network failures are
 * ambiguous (the call may have landed) and stay pending in D1; waits beyond three seconds
 * are rethrown so the service persists `retry_after` instead of sleeping in the Worker.
 */
export function configureApi<A extends Api>(api: A): A {
  api.config.use(
    autoRetry({
      maxRetryAttempts: 1,
      maxDelaySeconds: 3,
      rethrowInternalServerErrors: true,
      rethrowHttpErrors: true,
    }),
  );
  return api;
}

export function createApi(token: string): Api {
  if (!token.trim()) throw new Error("Telegram bot token is required.");
  return configureApi(new Api(token, API_CLIENT_OPTIONS));
}

function redact(value: string, token: string): string {
  return value
    .split(token)
    .join("[redacted]")
    .replace(/https?:\/\/\S+/gi, "[redacted URL]");
}

/** Reduce any grammY failure to a `TelegramApiError` that carries no payload or network detail. */
function normalize(error: unknown, token: string): TelegramApiError {
  if (!(error instanceof GrammyError)) return new TelegramApiError();
  const retryAfter = error.parameters.retry_after;
  return new TelegramApiError({
    code: error.error_code,
    description: redact(error.description, token),
    parameters:
      typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter >= 0
        ? { retry_after: retryAfter }
        : undefined,
  });
}

/** Adapt a grammY `Api` to the narrow `BotApi` port the service layer depends on. */
export function toBotApi(api: Api, token: string): BotApi {
  const raw = api.raw;
  async function call<Result>(run: () => Promise<Result>): Promise<Result> {
    try {
      return await run();
    } catch (error) {
      throw normalize(error, token);
    }
  }

  return {
    createChatInviteLink: (input) => call(() => raw.createChatInviteLink(input)),
    sendMessage: (input) => call(() => raw.sendMessage(input)),
    editMessageText: (input) => call(() => raw.editMessageText(input)),
    answerCallbackQuery: (input) => call(() => raw.answerCallbackQuery(input)),
    setMyCommands: (input) => call(() => raw.setMyCommands(input)),
    approveChatJoinRequest: (input) => call(() => raw.approveChatJoinRequest(input)),
    declineChatJoinRequest: (input) => call(() => raw.declineChatJoinRequest(input)),
    answerChatJoinRequestQuery: (input) => call(() => raw.answerChatJoinRequestQuery(input)),
    deleteMessage: (input) => call(() => raw.deleteMessage(input)),
    getMe: () => call(() => raw.getMe()),
    getChat: (input) => call(() => raw.getChat(input)),
    getChatMember: (input) => call(() => raw.getChatMember(input)),
    banChatMember: (input) => call(() => raw.banChatMember(input)),
    banChatSenderChat: (input) => call(() => raw.banChatSenderChat(input)),
  };
}

/** Build the service's Bot API port on grammY with the project's client options. */
export function createTelegramApi(token: string, api: Api = createApi(token)): BotApi {
  return toBotApi(api, token);
}
