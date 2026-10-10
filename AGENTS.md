# Development

This is a Telegram join verification bot on Cloudflare Workers with no frontend.

- Edit strict TypeScript in src/. dist/ is generated and must never hold handwritten changes. Shared interfaces live in src/types.d.ts.
- Use Hono for the webhook, Drizzle with D1 for storage, and fetch for Telegram Bot API calls. Runtime code must use Workers APIs rather than Node.js filesystem or process APIs.
- All database calls are async. Persist answers with revision CAS and API decisions before sending. Do not assume a transaction spans D1 and Telegram.
- Authenticate webhook requests before parsing their bodies. Await processing before acknowledging updates; return a retryable error on failed processing. Cron maintenance handles overdue sessions, pending decisions and message deletion.
- Keep prompts localized in en and cn. Question translations share an answer index and option count. Correct answers must never appear in public UI.
- Use oxlint and oxfmt. Run pnpm check before delivering changes.
- Tests run source using Vitest and real SQLite adapters; validate D1 SQL using local Wrangler migrations.
- .tgcloud/ is dead legacy private state; leave it alone. .dev.vars, .env files, .wrangler/ and private-content/ are private. Never commit tokens or question content.
- Question packs live in D1 (`packs`, `rules`, `questions`) and are synced from the gitignored private-content/ checkout with `pnpm content:push|pull|list`; the Worker bundle never contains content, and deploy never writes D1.
- Deployment and D1 migrations are separate. Live Telegram checks need a dedicated test group; local mocks do not prove live Telegram behavior.
