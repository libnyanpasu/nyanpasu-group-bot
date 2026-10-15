# Cloudflare Workers platform notes

The bot runs as an ES module Worker bundled from strict TypeScript. Hono handles `GET /` and `POST /webhook`; Workers `scheduled` runs maintenance. There is no public frontend or static-asset binding. Runtime dependencies are Hono, grammY (with `@grammyjs/auto-retry`) and Drizzle ORM; development packages and the private question checkout stay on the developer's machine.

## Bindings and authentication

`DB` is a D1 binding. `BOT_TOKEN` is the ordinary BotFather Bot API token, and `WEBHOOK_SECRET` is an independently generated URL-safe secret. Production values use Wrangler secrets; ignored `.dev.vars` supplies local values. Only the webhook registration and command-menu scripts need local credentials.

The webhook authenticates `X-Telegram-Bot-Api-Secret-Token` before parsing JSON or touching D1. It then requires a JSON object with an integer `update_id` and hands the update to grammY's `webhookCallback`, which does not validate update structure further (the secret already authenticates the sender). grammY reads the body before it checks its own secret, so our check must stay first. Handlers are awaited before the 200; a failure or the 25 s timeout becomes a 500 so Telegram redelivers. Webhook updates never reach `bot.catch`: the Hono handler logs only the update ID and API error code, because a `BotError` message embeds its cause's text. Do not log full updates, private question content, API URLs containing tokens or unredacted exceptions. Health responses expose no private content.

## grammY

`src/bot.ts` builds a `Bot` per request and routes `chat_join_request`, `callback_query`, `edited_message`, join service messages, spam filtering, admin commands, `/start`/`/help` and the group picker result (`bot.command` only matches commands addressed to this bot). `getMe` is cached per isolate. Webhook replies are disabled (`canUseWebhookReply: () => false`) because decisions must be persisted around the real API result, and each request has a 15 s timeout.

`@grammyjs/auto-retry` retries one 429 of at most 3 s; longer waits, 5xx and network failures are rethrown, and the service persists `retry_after` or keeps the decision pending in D1. `src/lib/telegram.ts` adapts the `Api` to the narrow `BotApi` port and converts every failure to a `TelegramApiError` without payloads, URLs or tokens. `@grammyjs/i18n` is not used: it needs Deno shims that do not bundle for Workers. The bundle grew from about 345 KiB to about 571 KiB (116 KiB gzip) when grammY was adopted. Health responses expose no private content.

Group selection uses Telegram's native chat picker. `/verify_groups` sends a `request_chat` keyboard button limited to groups (`bot_is_member`, and `user_administrator_rights` with `can_invite_users`). The picker's result arrives as an ordinary `message` with `chat_shared`, so `allowed_updates` is unchanged. Administrators in a group get a `url` button with a deep link, `https://t.me/<bot>?start=s<n>` for supergroups or `g<n>` for basic groups; Telegram limits deep-link parameters to 64 letters, digits, `_` and `-`, which these fit. The shared ID and the deep-link payload are both untrusted, so each selection is checked with `getChatMember` before it is stored.

Command menus are display-only. `pnpm commands:set` registers `setMyCommands` lists for `all_private_chats` (start, help, verify_groups) and `all_chat_administrators` (the group admin commands), in English by default and in `zh`. After an administrator selects a group, the Worker also sets a menu for that private chat that adds the management commands; failures there are ignored. Clients may take a while to show menu changes, and no menu grants access: each command still checks the caller's rights.

## D1 and consistency

Drizzle SQLite schema definitions generate reviewed SQL under `migrations/`. Configuration is stored in `groups`, question content in `packs`, `rules` and `questions`, and sessions store private JSON snapshots plus indexed state/deadline/revision metadata. The same write updates payload and indexed metadata. Revision compare-and-swap is a single conditional update, not a read/modify/write transaction. All calls are awaited. Administrator group selections live in `admin_targets` (user ID, group ID and update time, added by `migrations/0003_admin_targets.sql`); rows older than 24 hours are ignored and pruned by cron maintenance.

D1 and Telegram calls cannot commit atomically. Persist approval/decline intentions before calling Telegram, acquire short leases through CAS, and preserve pending state after ambiguous errors. Telegram may repeat an update or an API call may succeed with its response lost; administrators must reconcile irrecoverable external-state differences. No claim of exactly-once external effects is made.

All deadlines, leases and retry timestamps are milliseconds. Telegram `request.date` is seconds and is converted when calculating deadlines. Do not mix these units.

## Maintenance

Each verification session has a Durable Object timer (`SessionTimer`, SQLite-backed, addressed by the session key). Every committed D1 write that moves a session's next due time arms it (`withScheduling` in `src/lib/schedule.ts`), and its alarm calls `service.maintainSession(key)`: expire an unanswered session into a decline intention, retry a due decision, and delete the verification message after its original deadline. The alarm re-reads D1, does nothing before the session is due, and re-arms itself from the persisted retry, lease and cleanup times (never sooner than 15 s). Sessions are independent, so a backlog drains in parallel instead of at a fixed rate.

D1 stays the source of truth and the timer holds only the session key. Arming happens after the D1 write and is best effort, and the timer is at-least-once, so the CAS and lease rules above still decide every outcome. A per-minute Cron Trigger remains the backstop: it processes a small bounded batch of anything overdue (sessions that predate the timers, or whose timer could not be armed), and its writes arm timers too. `nextDueAt` mirrors the conditions of `listActionableSessions`; a test keeps them in sync. Without the `SESSION_TIMER` binding (such as unit tests) cron alone runs maintenance.

The first deploy applies the `SessionTimer` Durable Object migration (`migrations` in `wrangler.jsonc`, tag `v1`); this is separate from D1 migrations. Never rename or delete the class without a new migration tag.

The deadline covers the whole verification and is not extended by refreshing or `/start`. Cleanup timing is approximate: cron scheduling, backlog, rate limits and deployment propagation can delay it. Cron configuration changes may take up to 15 minutes to propagate. Production live behavior still needs a dedicated Telegram test group.

Workers Free has per-invocation resource limits, including a 50-subrequest limit and D1 query limits. Batches are intentionally bounded; paid plans or a queue-based design may be appropriate for busier deployments. API timeouts bound individual network waits. Existing `/start` recovery may consider up to 20 recent group sessions, so unusually many simultaneous memberships should be checked against the plan's budget.

## Deployment

`pnpm run deploy` applies pending remote D1 migrations without Wrangler's interactive confirmation, then deploys the Worker; it does not run `pnpm check`. D1 may be unavailable while migrations run. A failed migration stops deployment; a successful migration remains applied if the Worker deployment later fails, so schema changes must remain compatible with the currently deployed code. Use an expand-and-contract rollout for incompatible changes. Set production secrets, then register the HTTPS `/webhook` URL with Telegram and publish the command menus with `pnpm commands:set`. Deployment never writes question content: packs reach D1 through `pnpm content:push --remote` from the gitignored `private-content/` checkout. Generate and review migrations before deployment; content-only changes need a content push and no redeploy.

Public CI does not clone the private content checkout; schema sync is skipped when it is absent, and the Worker bundle never contains question content. `dist/` and `.wrangler/` hold build output only, and `private-content/` stays ignored. No automatic session retention cleanup is currently configured.

## Official references

- [Hono on Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [grammY webhooks](https://grammy.dev/guide/deployment-types) and [auto-retry](https://grammy.dev/plugins/auto-retry)
- [Drizzle with D1](https://orm.drizzle.team/docs/get-started/d1-new)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Workers Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook)
- [Telegram ChatJoinRequest](https://core.telegram.org/bots/api#chatjoinrequest)
