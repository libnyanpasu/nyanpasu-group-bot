# Nyanpasu Group Bot

A Telegram private-group join verification bot on Cloudflare Workers. Hono handles authenticated webhooks, Drizzle + D1 persist state, and a fetch client calls the standard Telegram Bot API. Telegram Serverless access is not required. There is no public frontend.

A requester sees the full group rules and one bilingual multiple-choice question in private chat. The question can be refreshed twice at most; the answer button also explicitly accepts the rules. A correct answer approves the join request, while a wrong answer or timeout declines it and starts the default 30-minute approval cooldown. Prompts are available in `cn` and `en`.

## Project structure

| Path                            | Purpose                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `src/index.ts`                  | Hono webhook, health check and Workers scheduled entry                         |
| `src/lib/telegram.ts`           | Bot API client built on fetch, with timeouts and redacted errors               |
| `src/lib/service.ts`            | Verification flow, revision CAS, approval retries and scheduled cleanup        |
| `src/lib/repository.ts`         | Drizzle queries and revision CAS                                               |
| `src/schema.ts` / `migrations/` | D1 table definitions and SQL migrations                                        |
| `private-content/`              | Local checkout of the private question repository (gitignored); synced with D1 |
| `scripts/build.mjs`             | Bundles the Worker                                                             |
| `scripts/content-cli.mjs`       | Content CLI: push, pull and list packs between a checkout and D1               |
| `dist/worker.js`                | Generated deployment bundle                                                    |

## Development

Use Node.js 24+ and pnpm 12 (`pnpm@12.11.2` in `packageManager`).

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm db:migrate:local
pnpm content:push
cp .env.example .dev.vars
# Fill BOT_TOKEN and WEBHOOK_SECRET for a dedicated test bot.
pnpm dev
```

`pnpm check` runs strict TypeScript checks for source and tests, oxlint, oxfmt, schema-copy checks, Vitest, bundling and a Wrangler deploy dry-run; it never deploys remote resources. Every test is a `.test.ts` file. Vitest verifies SQL, CAS and query conditions against real in-memory SQLite, validates migrations and the database adapter through local Wrangler D1, and exercises the verification flow and webhook with a mocked Telegram API. Local mocks do not prove live Telegram behavior.

The dev server listens on `http://localhost:8787` by default. `GET /` is a minimal health check; `POST /webhook` handles Telegram updates and only requests carrying a valid `X-Telegram-Bot-Api-Secret-Token` enter the verification flow. With `--test-scheduled`, `http://localhost:8787/__scheduled` triggers local maintenance manually; this debug route is not part of the deployed public interface. `pnpm dev` builds before starting; rebuild after source changes. Content changes only need `pnpm content:push` and take effect without a restart.

## Deployment

1. Create an ordinary bot with BotFather and obtain its **Bot API token**. No Telegram Serverless access is required.
2. Log in to Cloudflare and create D1:

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create nyanpasu-group-bot
```

Copy the returned `database_id` into the `DB` binding in `wrangler.jsonc`. Keep the database name in sync with the migration scripts.

3. Apply the D1 migrations and deploy the code:

```sh
pnpm db:migrate:remote
pnpm run deploy
```

`pnpm run deploy` runs the full check and deploys the Worker. Code deployment never changes D1; apply migrations first and register the webhook afterwards.

4. Set production secrets:

```sh
pnpm exec wrangler secret put BOT_TOKEN
pnpm exec wrangler secret put WEBHOOK_SECRET
```

Enter values interactively. `BOT_TOKEN` is the ordinary BotFather Bot API token; generate `WEBHOOK_SECRET` as a random URL-safe string, for example with `openssl rand -hex 32`. Never put tokens in `wrangler.jsonc`, source code, command-line arguments or chat logs. `.dev.vars` is local-only and is not automatically deployed as production secrets.

5. Put the same two values in the ignored `.dev.vars` and register the webhook:

```sh
pnpm webhook:set https://nyanpasu-group-bot.<your-subdomain>.workers.dev
pnpm webhook:info
```

The helper registers `/webhook`, the three required update types and the secret header without dropping pending updates. A custom HTTPS domain also works. Do not put interactive Cloudflare Access in front of the Telegram webhook.

6. Import the question bank into the production D1. The checkout is a normal clone of the private question repository (for example `git clone git@github.com:libnyanpasu/nyanpasu-verify-question.git private-content`); it is not part of this repository:

```sh
pnpm content:push --remote
```

Content changes take effect on the next join request without redeploying the Worker. See [Content management](#content-management) for push, pull and prune options.

7. Complete the group setup below in a dedicated private test group and verify both languages, correct/incorrect answers, the two refreshes, stale buttons, timeout, cooldown, recovery and scheduled cleanup before enabling production groups.

## Group setup

1. Add the bot to the private group and promote it to an administrator with the invite-user permission.
2. Send `/verify_status` in the group to confirm the content versions and permissions, and note the numeric group ID.
3. Configure and enable:

```text
/verify_config language=en timeoutSeconds=300 cooldownSeconds=1800
/verify_enable
```

4. A group administrator starts the bot privately with `/start`, then sends `/verify_invite -100GROUP_ID` to obtain an approval-required invite link.
5. Share the approval link and revoke old links that admit users without approval. Other administrators can still bypass verification by direct invitation or manual approval; agree on a process for that.

No public group or group username is required. Admin commands are `/verify_help`, `/verify_status`, `/verify_config`, `/verify_enable`, `/verify_disable` and `/verify_invite`; target a group by ID in private chat and omit it inside the group. Questions and rules are managed through private content, not commands. See [Private group setup](docs/private-group-setup.md) for details.

## Runtime and consistency

The verification deadline runs from the join request; refreshing and `/start` do not extend it. Answers, rule acceptance and approval intentions are persisted through D1 revision CAS before any Telegram call. Short leases reduce duplicate concurrent work and `retry_after` drives retries, but no transaction spans D1 and the Bot API, so an ambiguous network outcome cannot guarantee exactly-once external effects.

A per-minute Cron Trigger processes a small batch of expired sessions: it declines overdue requests, retries unfinished decisions and deletes verification messages after their original deadline. Scheduling, backlog and API retries can delay cleanup, and cron changes need time to propagate. The approval cooldown is a bot-side gate, not a Telegram group ban.

The webhook returns 2xx only after processing completes and returns a retryable error when processing fails. Telegram may still deliver updates more than once. Existing sessions keep their private question and rules snapshots across deployments, and `/verify_disable` only stops new sessions: existing verification and maintenance continue.

D1 stores the group configuration, session snapshots and the content bank. Session payloads keep their own question and rules snapshots, so content updates never change in-flight verifications. There is no automatic session-retention cleanup yet, and Workers and D1 free-plan call, CPU and query limits apply; maintenance runs in bounded batches, so consider a queue or a paid plan for busier deployments. See [Platform notes](docs/platform-notes.md).

## Content management

Questions, rules and pack manifests live in D1 (`packs`, `rules` and `questions` tables) and are edited in a local checkout of the private question repository. The checkout keeps the JSON layout the schemas describe: `packs/<id>.json`, `rules/<id>.json` and `questions/<type>/<id>.json`; a `default` pack is required. JSON Schemas provide editor completion, and the CLI validates fields, references, unique IDs, answer indexes and bilingual message lengths with the same validator the Worker uses. Rules text is never truncated.

```sh
pnpm content:list                  # show the packs, question types and rules in local D1
pnpm content:push                  # import the checkout into local D1 (upsert)
pnpm content:push --prune          # also delete D1 rows that are absent from the checkout
pnpm content:push --remote         # import into the production D1 (requires wrangler login)
pnpm content:pull --dir <path>     # export D1 content into a directory
pnpm content:pull --dir <path> --force  # overwrite existing files in the target directory
```

Local D1 is the default target; `--remote` is required for production. `push` upserts only, so pass `--prune` to mirror deletions, and `--dir` selects another checkout. `pull` refuses to overwrite an existing checkout without `--force`, restores the `$schema` markers and runs oxfmt so exported files match the checkout format. Invalid banks are rejected before anything is written.

The schemas are kept in sync with the checkout:

```sh
pnpm content:schemas
pnpm content:schemas:check
```

There is no public content endpoint or static asset binding, and the Worker bundle never contains question content. Never commit content JSON, database dumps or exported banks to this repository.

After table-definition changes, run `pnpm db:generate`, review the generated migration and apply the remote migration separately.

[Cloudflare Workers](https://developers.cloudflare.com/workers/) · [Drizzle D1](https://orm.drizzle.team/docs/get-started/d1-new) · [Telegram Bot API](https://core.telegram.org/bots/api)
