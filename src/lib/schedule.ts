import type { Repository, Session } from "../types.js";
import { apiError } from "./api-error.js";

/** Arms the per-session timer: wake `key` no later than `at` (epoch ms). */
export type ScheduleTimer = (key: string, at: number) => Promise<void>;

/**
 * When a session next needs maintenance, mirroring `listActionableSessions`: an unanswered
 * session expires at its deadline, a pending decision retries when its lease lapses, and a
 * finished session's prompt is deleted after the deadline and any cleanup retry or lease.
 * `null` means no further work. Times at or before now are due immediately.
 */
export function nextDueAt(session: Session): number | null {
  switch (session.status) {
    case "active":
    case "awaiting_rules":
      return session.expiresAt;
    case "approve_pending":
    case "decline_pending":
      return session.effectLeaseUntil ?? 0;
    case "approved":
    case "declined":
      if (session.messageId === null || session.messageDeletedAt !== undefined) return null;
      return Math.max(
        session.expiresAt,
        session.cleanupRetryAt ?? 0,
        session.cleanupLeaseUntil ?? 0,
      );
  }
}

/**
 * Wrap a repository so every committed write that changes a session's next due time arms its
 * timer. Arming happens after the D1 write and is best effort: D1 stays the source of truth,
 * and the cron sweep finds any session whose timer could not be set.
 */
export function withScheduling(repository: Repository, schedule: ScheduleTimer): Repository {
  async function arm(session: Session, previous?: Session) {
    const at = nextDueAt(session);
    if (at === null || (previous && nextDueAt(previous) === at)) return;
    try {
      await schedule(session.key, at);
    } catch (caught) {
      console.warn("Cannot arm session timer", apiError(caught).code);
    }
  }

  return {
    ...repository,
    async createSession(session) {
      const created = await repository.createSession(session);
      if (created) await arm(session);
      return created;
    },
    async casSession(previous, next) {
      // The repository stamps the new revision onto `next` and mutates it in place.
      const swapped = await repository.casSession(previous, next);
      if (swapped) await arm(next, previous);
      return swapped;
    },
  };
}
