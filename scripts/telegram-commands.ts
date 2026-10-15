import { COMMAND_LANGUAGES, COMMAND_SCOPES, botCommands } from "../src/lib/commands.ts";

type TelegramResponse = { ok: boolean; error_code?: number };

async function setMyCommands(token: string, parameters: Record<string, unknown>): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parameters),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Telegram request failed or timed out. Credentials are omitted.");
  }
  let body: TelegramResponse;
  try {
    body = (await response.json()) as TelegramResponse;
  } catch {
    throw new Error("Telegram returned an invalid response. Credentials are omitted.");
  }
  if (!response.ok || !body.ok)
    throw new Error(
      `Telegram rejected the request (HTTP ${response.status}, code ${body.error_code ?? "unknown"}).`,
    );
}

async function main(): Promise<void> {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("Set BOT_TOKEN in .dev.vars and run commands:set.");
  for (const { scope, commands } of COMMAND_SCOPES) {
    for (const { code, key } of COMMAND_LANGUAGES) {
      await setMyCommands(token, {
        commands: botCommands(commands, key),
        scope,
        ...(code ? { language_code: code } : {}),
      });
    }
  }
  console.log("Command menus registered for private chats and group administrators (en, zh).");
}

main().catch((error: unknown) => {
  // Only our redacted errors are surfaced; raw fetch errors can contain credentials.
  console.error(
    error instanceof Error && !/api\.telegram\.org\/bot/.test(error.message)
      ? error.message
      : "Command registration failed.",
  );
  process.exitCode = 1;
});
