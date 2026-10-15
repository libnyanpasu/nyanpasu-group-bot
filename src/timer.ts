import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "./types.js";
import { apiError } from "./lib/api-error.js";
import { createRuntime } from "./lib/runtime.js";

const KEY = "key";
// A session that is still due after a run (a held lease, a failing call) is retried no
// sooner than this, so a stuck session cannot spin the alarm.
const MIN_REARM_MS = 15_000;

/**
 * One timer per verification session, addressed by its key. D1 stays the source of truth:
 * the timer only wakes the service at the session's next due time, and the service re-reads
 * the session before acting, so a stale or duplicate alarm does nothing.
 */
export class SessionTimer extends DurableObject<Bindings> {
  /**
   * Wake no later than `at`; a time already past (or 0, "due now") fires immediately. An
   * earlier pending alarm wins, and the timer re-arms itself after it runs.
   */
  async schedule(key: string, at: number): Promise<void> {
    await this.ctx.storage.put(KEY, key);
    const pending = await this.ctx.storage.getAlarm();
    const wake = Math.max(at, Date.now());
    if (pending === null || wake < pending) await this.ctx.storage.setAlarm(wake);
  }

  async alarm(): Promise<void> {
    const key = await this.ctx.storage.get<string>(KEY);
    if (key === undefined) return;
    try {
      // The timer re-arms itself from the returned due time, so it runs without a scheduler.
      const next = await createRuntime(this.env, undefined, null).service.maintainSession(key);
      if (next === null) await this.ctx.storage.deleteAll();
      else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + MIN_REARM_MS));
    } catch (caught) {
      // Rethrow so Workers retries the alarm with backoff; the cron sweep is the backstop.
      console.warn("Session timer failed", apiError(caught).code);
      throw caught;
    }
  }
}
