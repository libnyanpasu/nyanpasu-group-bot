import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({ createRuntime: vi.fn() }));
vi.mock("../src/lib/runtime.js", () => runtimeMock);

import { SessionTimer } from "../src/timer.js";
import type { Bindings } from "../src/types.js";

const env = { DB: {}, BOT_TOKEN: "private-bot-token", WEBHOOK_SECRET: "s" } as Bindings;
const NOW = 1_800_000_000_000;

function createTimer() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    put: vi.fn(async (key: string, value: unknown) => void values.set(key, value)),
    get: vi.fn(async (key: string) => values.get(key)),
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (at: number) => void (alarm = at)),
    deleteAll: vi.fn(async () => {
      values.clear();
      alarm = null;
    }),
  };
  const timer = new SessionTimer({ storage } as unknown as DurableObjectState, env);
  return { timer, storage, alarmAt: () => alarm };
}

function maintainWith(result: number | null | Error) {
  const maintainSession = vi.fn(async (_key: string) => {
    if (result instanceof Error) throw result;
    return result;
  });
  runtimeMock.createRuntime.mockReturnValue({ service: { maintainSession } });
  return maintainSession;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  runtimeMock.createRuntime.mockReset();
});

describe("SessionTimer", () => {
  it("arms an alarm and lets an earlier one win", async () => {
    const { timer, alarmAt } = createTimer();

    await timer.schedule("-100:1", NOW + 60_000);
    await timer.schedule("-100:1", NOW + 120_000);
    expect(alarmAt()).toBe(NOW + 60_000);

    await timer.schedule("-100:1", NOW + 5_000);
    expect(alarmAt()).toBe(NOW + 5_000);
  });

  it("fires immediately for a session that is already due", async () => {
    const { timer, alarmAt } = createTimer();

    await timer.schedule("-100:1", 0);

    // Workers rejects an alarm at or before time zero, so "due now" becomes the current time.
    expect(alarmAt()).toBe(NOW);
  });

  it("maintains the stored session without arming new timers, then goes idle when done", async () => {
    const { timer, storage, alarmAt } = createTimer();
    const maintainSession = maintainWith(null);
    await timer.schedule("-100:1", NOW);

    await timer.alarm();

    expect(runtimeMock.createRuntime).toHaveBeenCalledWith(env, undefined, null);
    expect(maintainSession).toHaveBeenCalledExactlyOnceWith("-100:1");
    expect(storage.deleteAll).toHaveBeenCalledOnce();
    expect(alarmAt()).toBeNull();
  });

  it("re-arms at the next due time but never sooner than the minimum gap", async () => {
    const { timer, alarmAt } = createTimer();
    await timer.schedule("-100:1", NOW);

    maintainWith(NOW + 600_000);
    await timer.alarm();
    expect(alarmAt()).toBe(NOW + 600_000);

    maintainWith(NOW - 1);
    await timer.alarm();
    expect(alarmAt()).toBe(NOW + 15_000);
  });

  it("does nothing without a stored session", async () => {
    const { timer } = createTimer();
    const maintainSession = maintainWith(null);

    await timer.alarm();

    expect(maintainSession).not.toHaveBeenCalled();
  });

  it("rethrows failures so Workers retries the alarm, logging only the error code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { timer } = createTimer();
    await timer.schedule("-100:1", NOW);
    const failure = Object.assign(new Error("private-bot-token"), { code: 500 });
    maintainWith(failure);

    await expect(timer.alarm()).rejects.toBe(failure);

    expect(warn).toHaveBeenCalledWith("Session timer failed", 500);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-bot-token");
  });
});
