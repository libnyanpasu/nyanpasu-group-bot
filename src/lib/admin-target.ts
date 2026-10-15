/** Bot API supergroup IDs are `-100` followed by the channel ID, i.e. -(10^12 + n). */
const SUPERGROUP_BASE = 1_000_000_000_000;
const REF_PATTERN = /^([sg])(\d{1,13})$/;

/**
 * Encode a group chat ID as a short token that is safe in `/start` payloads (A-Za-z0-9_-,
 * 64 characters) and in 64-byte `callback_data`: `s<n>` for supergroups, `g<n>` for basic
 * groups. Returns null for IDs that are not group chats.
 */
export function encodeGroupRef(chatId: number): string | null {
  if (!Number.isSafeInteger(chatId) || chatId >= 0) return null;
  const magnitude = -chatId;
  const ref = magnitude > SUPERGROUP_BASE ? `s${magnitude - SUPERGROUP_BASE}` : `g${magnitude}`;
  // Only hand out tokens that decode back to the same chat.
  return decodeGroupRef(ref) === chatId ? ref : null;
}

/** Inverse of `encodeGroupRef`; null for anything that is not a canonical token. */
export function decodeGroupRef(ref: string): number | null {
  const match = REF_PATTERN.exec(ref);
  if (!match) return null;
  const value = Number(match[2]);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== match[2]) return null;
  return match[1] === "s" ? -(SUPERGROUP_BASE + value) : -value;
}

/** A saved group selection is kept this long after its last use. */
export const ADMIN_TARGET_TTL_MS = 24 * 60 * 60 * 1000;
/** Identifies our `request_chat` keyboard button in the `chat_shared` service message. */
export const GROUP_PICKER_REQUEST_ID = 1;
