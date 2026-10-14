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

Optionally set `DELETE_JOIN_MESSAGES` (`true` or `false`, default `false` in `wrangler.jsonc` `vars`) to delete "joined the group" service messages in every group that has not chosen its own `deleteJoinMessages` setting. The `SPAM_*` variables set spam filter defaults the same way; see [Spam filter](#spam-filter). It is not a secret; edit `wrangler.jsonc` and redeploy, or override it locally in `.dev.vars`.

5. Put the same two values in the ignored `.dev.vars` and register the webhook:

```sh
pnpm webhook:set https://nyanpasu-group-bot.<your-subdomain>.workers.dev
pnpm webhook:info
```

The helper registers `/webhook`, the four required update types (`message`, `edited_message`, `callback_query` and `chat_join_request`) and the secret header without dropping pending updates. Rerun `pnpm webhook:set` after upgrading from a version that did not subscribe to `edited_message`. A custom HTTPS domain also works. Do not put interactive Cloudflare Access in front of the Telegram webhook.

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
5. Optionally send `/verify_config deleteJoinMessages=on` to delete Telegram's "joined the group" service messages. This works independently of `/verify_enable` and requires the bot's delete-messages permission; the bot warns when that permission is missing. `deleteJoinMessages=off` keeps them again, and `deleteJoinMessages=default` follows the Worker-wide `DELETE_JOIN_MESSAGES` variable (see [Deployment](#deployment)).
6. Optionally enable the spam filter, for example `/verify_config spamMode=new spamFirstMessages=3 spamBan=on spamCas=on`. See [Spam filter](#spam-filter).
7. Share the approval link and revoke old links that admit users without approval. Other administrators can still bypass verification by direct invitation or manual approval; agree on a process for that.

No public group or group username is required. Admin commands are `/verify_help`, `/verify_status`, `/verify_config`, `/verify_enable`, `/verify_disable` and `/verify_invite`; target a group by ID in private chat and omit it inside the group. Questions and rules are managed through private content, not commands. See [Private group setup](docs/private-group-setup.md) for details.

## Runtime and consistency

The verification deadline runs from the join request; refreshing and `/start` do not extend it. Answers, rule acceptance and approval intentions are persisted through D1 revision CAS before any Telegram call. Short leases reduce duplicate concurrent work and `retry_after` drives retries, but no transaction spans D1 and the Bot API, so an ambiguous network outcome cannot guarantee exactly-once external effects.

A per-minute Cron Trigger processes a small batch of expired sessions: it declines overdue requests, retries unfinished decisions and deletes verification messages after their original deadline. Scheduling, backlog and API retries can delay cleanup, and cron changes need time to propagate. The approval cooldown is a bot-side gate, not a Telegram group ban.

The webhook returns 2xx only after processing completes and returns a retryable error when processing fails. Telegram may still deliver updates more than once. Existing sessions keep their private question and rules snapshots across deployments, and `/verify_disable` only stops new sessions: existing verification and maintenance continue.

D1 stores the group configuration, session snapshots, the content bank, spam blocklists and per-group message counts for the spam filter. Session payloads keep their own question and rules snapshots, so content updates never change in-flight verifications. There is no automatic session-retention cleanup yet, and Workers and D1 free-plan call, CPU and query limits apply; maintenance runs in bounded batches, so consider a queue or a paid plan for busier deployments. See [Platform notes](docs/platform-notes.md).

## Spam filter

The filter deletes spam (advertising, scams, funnelling and topics our groups do not host, such as politics) that matches the private blocklist, and can ban senders. It is independent of join verification. Each group configures it with `/verify_config`; options a group has not set follow Worker-wide defaults from `wrangler.jsonc` `vars`:

| Group option             | Worker variable       | Built-in default | Meaning                                                                                       |
| ------------------------ | --------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `spamMode=off\|new\|all` | `SPAM_MODE`           | `off`            | `new` inspects each member's first `spamFirstMessages` messages; `all` inspects every message |
| `spamFirstMessages=N`    | `SPAM_FIRST_MESSAGES` | `3`              | Messages inspected per member in `new` mode, 1–100. Counts restart when a member rejoins      |
| `spamBan=on\|off`        | `SPAM_BAN`            | `true`           | Ban senders on ban-tier matches and CAS hits; off only deletes, useful for trying out a list  |
| `spamCas=on\|off`        | `SPAM_CAS`            | `true`           | Check a sender's first message against the [CAS](https://cas.chat) ban list                   |

Every group option also accepts `default`, which clears the group's own value so the Worker variable applies again; `/verify_config` marks inherited values with "(global default)". Worker variables take `true`/`false` (or `1`/`0`); missing or malformed values fall back to the built-in defaults. They are not secrets: edit `wrangler.jsonc` and redeploy, or override them locally in `.dev.vars`. Setting `SPAM_MODE=all` makes every group without its own setting inspect all messages, including deleting political discussion.

A message is checked together with its caption, hidden link targets, inline button labels and URLs, quoted text, forward origin and the sender's names and username. Edited messages are checked again. Before matching, text and blocklist entries are folded the same way: NFKC (full-width, circled and styled characters), lower case, Cyrillic/Greek look-alikes of Latin letters, and removal of everything except letters and digits, so spacing, punctuation, emoji and zero-width characters cannot split a keyword. Traditional Chinese is not converted; list both forms when needed. Messages whose Han characters are mostly separated by spaces (`加 微 信 领 钱`) are deleted as keyword evasion.

- **Ban tier** (`ban`): delete and ban (`banChatMember`, or `banChatSenderChat` for channel identities).
- **Delete tier** (`delete`) and the spacing rule: delete only.
- Administrators, anonymous administrators and automatic forwards from the linked channel are exempt. Admin status is looked up only after a match.
- The bot needs the delete-messages permission, plus ban-users when `spamBan=on`; `/verify_config` warns about missing rights. Permanent Telegram refusals are ignored, while rate limits and server errors fail the webhook so Telegram retries.
- `new` mode starts counting when the filter first sees a member, so existing members are inspected for their next N messages after enabling it.

The blocklist is generated by `pnpm blocklist:build` (see [Blocklist sources](#blocklist-sources)) into the content checkout as `blocklists/default.json`, and synced to D1 with `pnpm content:push`. It is never part of the Worker bundle, and each Worker isolate caches it for up to a minute.

```json
{
  "$schema": "../schemas/blocklist.schema.json",
  "version": "2026-10",
  "ban": ["example ban phrase", "=example whole message"],
  "delete": ["example suspicious phrase"]
}
```

Entries match as substrings after normalization and must keep at least two letters or digits; an entry starting with `=` must equal a whole text. Keep the ban tier to phrases that do not occur in normal chat. The detection code is our own; its approach draws on [tg-spam](https://github.com/umputun/tg-spam), [xiaomaoJT/TgBot](https://github.com/xiaomaoJT/TgBot) and [bayes_spam_sniper](https://github.com/ramsayleung/bayes_spam_sniper).

### Blocklist sources

`pnpm blocklist:build` fetches the upstream word lists pinned in [`blocklist/sources.json`](blocklist/sources.json), applies our curation in [`blocklist/overrides.json`](blocklist/overrides.json), then normalizes, deduplicates and merges them into `<content checkout>/blocklists/default.json`. Both files are public so the result can be reviewed and reproduced. Review the generated file, then run `pnpm content:push`.

```sh
pnpm blocklist:build --dry-run          # print the merge report only
pnpm blocklist:build                    # write private-content/blocklists/default.json
pnpm blocklist:build --dir <path> --version 2026-10
```

- Duplicates are merged after normalization, and the stronger tier wins.
- An entry is dropped when a shorter entry of the same or a stronger tier already contains it.
- `drop` removes entries by reason: insults, common words with a high false-positive risk, and upstream in-jokes. Political terms are kept in the delete tier because our groups do not encourage political discussion. They come from upstream at build time and are never stored in this repository.
- `delete` demotes risky ban-tier entries.
- `add` holds our own entries, grouped by category: proxy airport promotion and reseller recruitment, group funnelling, and crypto scams.
- Every entry is tested against `safeSamples`, normal messages from our groups. An entry that would match one is dropped and reported. Add a sample whenever a false positive shows up.

The merged list currently uses these projects. We thank their authors:

| Project         | URL                                  | License       | What we use                                                                                              |
| --------------- | ------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------- |
| tg-spam         | <https://github.com/umputun/tg-spam> | MIT           | `data/stop-words.txt`, ban tier                                                                          |
| xiaomaoJT/TgBot | <https://github.com/xiaomaoJT/TgBot> | None declared | `sensitive_words` sheet of `XiaoMaoBot_DB.xlsx`: column A ban tier, column B delete tier, after curation |

**If you are an author of one of these projects and do not want your list used here, please [open an issue](https://github.com/libnyanpasu/nyanpasu-group-bot/issues) or contact the maintainers. We will remove your source from `blocklist/sources.json` and stop distributing the derived entries.** The same applies if you would like different attribution.

## Content management

Questions, rules and pack manifests live in D1 (`packs`, `rules` and `questions` tables) and are edited in a local checkout of the private question repository. The checkout keeps the JSON layout the schemas describe: `packs/<id>.json`, `rules/<id>.json` and `questions/<type>/<id>.json`, plus optional `blocklists/<id>.json` spam blocklists; a `default` pack is required. JSON Schemas provide editor completion, and the CLI validates fields, references, unique IDs, answer indexes and bilingual message lengths with the same validator the Worker uses. Rules text is never truncated.

```sh
pnpm content:list                  # show the packs, question types, rules and blocklists in local D1
pnpm content:push                  # import the checkout into local D1 (upsert)
pnpm content:push --prune          # also delete D1 rows that are absent from the checkout
pnpm content:push --remote         # import into the production D1 (requires wrangler login)
pnpm content:pull --dir <path>     # export D1 content into a directory
pnpm content:pull --dir <path> --force  # overwrite existing files in the target directory
```

Local D1 is the default target; `--remote` is required for production. Blocklists are pushed and pulled with the packs, except when `push` is given explicit pack ids. `push` upserts only, so pass `--prune` to mirror deletions, and `--dir` selects another checkout. `pull` refuses to overwrite an existing checkout without `--force`, restores the `$schema` markers and runs oxfmt so exported files match the checkout format. Invalid banks are rejected before anything is written.

The schemas are kept in sync with the checkout:

```sh
pnpm content:schemas
pnpm content:schemas:check
```

There is no public content endpoint or static asset binding, and the Worker bundle never contains question content. Never commit content JSON, database dumps or exported banks to this repository.

After table-definition changes, run `pnpm db:generate`, review the generated migration and apply the remote migration separately.

[Cloudflare Workers](https://developers.cloudflare.com/workers/) · [Drizzle D1](https://orm.drizzle.team/docs/get-started/d1-new) · [Telegram Bot API](https://core.telegram.org/bots/api)
