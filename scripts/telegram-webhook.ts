type TelegramResponse = {
  ok: boolean;
  error_code?: number;
  result?:
    | {
        url?: string;
        pending_update_count?: number;
        allowed_updates?: string[];
        last_error_date?: number;
      }
    | boolean;
};

async function main(): Promise<void> {
  const [command, address] = process.argv.slice(2);
  const token = process.env.BOT_TOKEN;
  if (!token || !["set", "info"].includes(command ?? "")) {
    throw new Error("Set BOT_TOKEN in .dev.vars and use webhook:set <Worker URL> or webhook:info.");
  }
  let parameters: Record<string, unknown> = {};
  if (command === "set") {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
      throw new Error(
        "WEBHOOK_SECRET must contain 1–256 URL-safe letters, digits, underscores or hyphens.",
      );
    }
    if (!address) throw new Error("Provide the HTTPS Worker base URL.");
    const url = new URL(address);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("Provide an HTTPS base URL without credentials, path, query or fragment.");
    }
    parameters = {
      url: new URL("/webhook", url).href,
      secret_token: secret,
      allowed_updates: ["message", "callback_query", "chat_join_request"],
      max_connections: 10,
      drop_pending_updates: false,
    };
  } else if (address) {
    throw new Error("webhook:info takes no arguments.");
  }
  let response: Response;
  try {
    response = await fetch(
      `https://api.telegram.org/bot${token}/${command === "set" ? "setWebhook" : "getWebhookInfo"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parameters),
        signal: AbortSignal.timeout(15_000),
      },
    );
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
  if (command === "set") console.log("Webhook registered. Pending updates were preserved.");
  else if (typeof body.result === "object" && body.result) {
    console.log(
      JSON.stringify(
        {
          url: body.result.url,
          pendingUpdates: body.result.pending_update_count,
          allowedUpdates: body.result.allowed_updates,
          lastErrorDate: body.result.last_error_date,
        },
        null,
        2,
      ),
    );
  }
}

main().catch((error: unknown) => {
  // Only our redacted errors are surfaced; raw fetch errors can contain credentials.
  console.error(
    error instanceof Error && !/api\.telegram\.org\/bot/.test(error.message)
      ? error.message
      : "Webhook setup failed.",
  );
  process.exitCode = 1;
});
