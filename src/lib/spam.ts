import type { BlocklistDocument, Config, Message, SpamMode, User } from "../types.js";

export const DEFAULT_BLOCKLIST_ID = "default";
export const DEFAULT_SPAM_FIRST_MESSAGES = 3;
export const MAX_SPAM_FIRST_MESSAGES = 100;
const MAX_BLOCKLIST_ENTRIES = 5000;
const MAX_BLOCKLIST_ENTRY_LENGTH = 200;
const BLOCKLIST_CACHE_MS = 60_000;
const CAS_TIMEOUT_MS = 3_000;
// A message whose Han characters are mostly followed by spaces ("加 微 信 领 钱") is
// a common keyword-evasion pattern; short texts are skipped to limit false positives.
const SPACED_HAN_MIN = 5;
const SPACED_HAN_RATIO = 0.8;

/**
 * Latin look-alikes from Cyrillic and Greek that spammers swap in to dodge keywords.
 * Applied after lower-casing to both messages and blocklist entries, so it only has to be consistent.
 */
const CONFUSABLES: Record<string, string> = {
  а: "a",
  е: "e",
  ё: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  к: "k",
  м: "m",
  т: "t",
  н: "h",
  і: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ɡ: "g",
  α: "a",
  ο: "o",
  ρ: "p",
  τ: "t",
  ι: "i",
  κ: "k",
  ν: "v",
  υ: "u",
  χ: "x",
};
const confusablePattern = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");

export interface SpamSettings {
  mode: SpamMode;
  firstMessages: number;
  ban: boolean;
  cas: boolean;
}

export type SpamVerdict =
  | { action: "ban"; reason: "keyword" | "cas" }
  | { action: "delete"; reason: "keyword" | "spacing" };

export interface BlocklistMatcher {
  version: string;
  ban: string[];
  delete: string[];
  banExact: Set<string>;
  deleteExact: Set<string>;
}

export const DEFAULT_SPAM_SETTINGS: SpamSettings = {
  mode: "off",
  firstMessages: DEFAULT_SPAM_FIRST_MESSAGES,
  ban: true,
  cas: true,
};

/** Resolve a group's filter settings; unset fields follow the Worker-wide defaults. */
export function spamSettings(
  config: Config | null | undefined,
  defaults: SpamSettings = DEFAULT_SPAM_SETTINGS,
): SpamSettings {
  return {
    mode: config?.spamMode ?? defaults.mode,
    firstMessages: config?.spamFirstMessages ?? defaults.firstMessages,
    ban: config?.spamBan ?? defaults.ban,
    cas: config?.spamCas ?? defaults.cas,
  };
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  const text = value?.trim().toLowerCase() ?? "";
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  return fallback;
}

/**
 * Read the Worker-wide filter defaults from SPAM_MODE, SPAM_FIRST_MESSAGES, SPAM_BAN and
 * SPAM_CAS. Missing or malformed values fall back to the built-in defaults.
 */
export function spamDefaultsFromEnv(env: {
  SPAM_MODE?: string;
  SPAM_FIRST_MESSAGES?: string;
  SPAM_BAN?: string;
  SPAM_CAS?: string;
}): SpamSettings {
  const mode = env.SPAM_MODE?.trim().toLowerCase();
  const firstMessages = Number(env.SPAM_FIRST_MESSAGES?.trim() || Number.NaN);
  return {
    mode: mode === "off" || mode === "new" || mode === "all" ? mode : DEFAULT_SPAM_SETTINGS.mode,
    firstMessages:
      Number.isSafeInteger(firstMessages) &&
      firstMessages >= 1 &&
      firstMessages <= MAX_SPAM_FIRST_MESSAGES
        ? firstMessages
        : DEFAULT_SPAM_SETTINGS.firstMessages,
    ban: envBoolean(env.SPAM_BAN, DEFAULT_SPAM_SETTINGS.ban),
    cas: envBoolean(env.SPAM_CAS, DEFAULT_SPAM_SETTINGS.cas),
  };
}

/**
 * Fold text into a comparable skeleton: NFKC (full-width, circled and styled letters),
 * lower case, Latin look-alikes, then drop everything except letters and digits so
 * spacing, punctuation, emoji and zero-width characters cannot split a keyword.
 */
export function normalizeSpamText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(confusablePattern, (character) => CONFUSABLES[character] ?? character)
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function entryKey(entry: string): { exact: boolean; key: string } {
  const exact = entry.startsWith("=");
  return { exact, key: normalizeSpamText(exact ? entry.slice(1) : entry) };
}

/** Validate a blocklist document. Entries prefixed with "=" must equal a whole text. */
export function validateBlocklist(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "Blocklist must be an object.";
  const document = value as Record<string, unknown>;
  if (
    typeof document.version !== "string" ||
    !document.version.trim() ||
    document.version.length > 64
  )
    return "version must be a non-empty string of at most 64 characters.";
  for (const tier of ["ban", "delete"] as const) {
    const entries = document[tier];
    if (!Array.isArray(entries) || entries.length > MAX_BLOCKLIST_ENTRIES)
      return `${tier} must be an array of at most ${MAX_BLOCKLIST_ENTRIES} entries.`;
    for (const [index, entry] of entries.entries()) {
      if (typeof entry !== "string" || entry.length > MAX_BLOCKLIST_ENTRY_LENGTH)
        return `${tier}[${index}] must be a string of at most ${MAX_BLOCKLIST_ENTRY_LENGTH} characters.`;
      // A one-character key would match nearly every message in its script.
      if ([...entryKey(entry).key].length < 2)
        return `${tier}[${index}] must keep at least two letters or digits after normalization.`;
    }
  }
  return null;
}

/** Normalize a valid blocklist once so each message only runs substring checks. */
export function compileBlocklist(document: BlocklistDocument): BlocklistMatcher {
  const matcher: BlocklistMatcher = {
    version: document.version,
    ban: [],
    delete: [],
    banExact: new Set(),
    deleteExact: new Set(),
  };
  for (const tier of ["ban", "delete"] as const) {
    for (const entry of document[tier]) {
      const { exact, key } = entryKey(entry);
      if (exact) matcher[tier === "ban" ? "banExact" : "deleteExact"].add(key);
      else matcher[tier].push(key);
    }
  }
  return matcher;
}

function userTexts(user: User | undefined): string[] {
  if (!user) return [];
  return [[user.first_name, user.last_name].filter(Boolean).join(" "), user.username ?? ""];
}

/**
 * Collect every text a reader sees with the message: body, caption, hidden link
 * targets, inline button labels and URLs, quotes, forward origins and the sender's names.
 */
export function messageTexts(message: Message): string[] {
  const texts = [message.text ?? "", message.caption ?? "", message.quote?.text ?? ""];
  for (const entity of [...(message.entities ?? []), ...(message.caption_entities ?? [])])
    if (entity.url) texts.push(entity.url);
  for (const row of message.reply_markup?.inline_keyboard ?? [])
    for (const button of row) texts.push(button.text, button.url ?? "");
  const origin = message.forward_origin;
  if (origin) {
    texts.push(origin.sender_user_name ?? "", ...userTexts(origin.sender_user));
    for (const chat of [origin.sender_chat, origin.chat])
      if (chat) texts.push(chat.title ?? "", chat.username ?? "");
  }
  texts.push(...userTexts(message.from));
  if (message.sender_chat)
    texts.push(message.sender_chat.title ?? "", message.sender_chat.username ?? "");
  return texts.filter((text) => text.trim().length > 0);
}

/** True when most Han characters that have a following Han neighbour are separated from it by whitespace. */
export function spacedHan(text: string): boolean {
  const normalized = text.normalize("NFKC");
  const han = normalized.match(/\p{Script=Han}/gu)?.length ?? 0;
  if (han < SPACED_HAN_MIN) return false;
  const spaced = normalized.match(/\p{Script=Han}\s+(?=\p{Script=Han})/gu)?.length ?? 0;
  const adjacent = normalized.match(/\p{Script=Han}(?=\p{Script=Han})/gu)?.length ?? 0;
  return spaced + adjacent > 0 && spaced / (spaced + adjacent) > SPACED_HAN_RATIO;
}

/** Classify a message against the blocklist and the spacing heuristic. */
export function detectSpam(message: Message, matcher: BlocklistMatcher | null): SpamVerdict | null {
  const keys = messageTexts(message).map(normalizeSpamText).filter(Boolean);
  if (matcher) {
    if (
      keys.some(
        (key) => matcher.banExact.has(key) || matcher.ban.some((entry) => key.includes(entry)),
      )
    )
      return { action: "ban", reason: "keyword" };
    if (
      keys.some(
        (key) =>
          matcher.deleteExact.has(key) || matcher.delete.some((entry) => key.includes(entry)),
      )
    )
      return { action: "delete", reason: "keyword" };
  }
  if ([message.text, message.caption].some((text) => text && spacedHan(text)))
    return { action: "delete", reason: "spacing" };
  return null;
}

let cached: { id: string; at: number; matcher: BlocklistMatcher | null } | undefined;

/**
 * Load and compile a blocklist, reusing the result for a minute within one isolate so
 * busy groups do not read D1 for every message. Invalid documents disable keyword checks.
 */
export async function loadBlocklist(
  load: (id: string) => Promise<BlocklistDocument | null>,
  id = DEFAULT_BLOCKLIST_ID,
  now = Date.now(),
): Promise<BlocklistMatcher | null> {
  if (cached && cached.id === id && now - cached.at < BLOCKLIST_CACHE_MS) return cached.matcher;
  const document = await load(id);
  const matcher = document && !validateBlocklist(document) ? compileBlocklist(document) : null;
  cached = { id, at: now, matcher };
  return matcher;
}

/** Drop the isolate cache; tests use this to observe fresh documents. */
export function clearBlocklistCache(): void {
  cached = undefined;
}

/**
 * Ask the Combot Anti-Spam (CAS) list whether a user is a known spammer. Listed users
 * return `ok: true`; unknown users return `ok: false`. Failures count as not listed.
 */
export async function casListed(userId: number, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(`https://api.cas.chat/check?user_id=${userId}`, {
      signal: AbortSignal.timeout(CAS_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}
