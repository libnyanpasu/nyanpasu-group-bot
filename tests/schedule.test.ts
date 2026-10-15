import { afterEach, describe, expect, it, vi } from "vitest";

import { createRepository } from "../src/lib/repository.js";
import { nextDueAt, withScheduling } from "../src/lib/schedule.js";
import type { Repository, Session } from "../src/types.js";
import { createTestDatabase } from "./helpers/sqlite.js";

const DEADLINE = 1_800_000_300_000;

function makeSession(index: number, overrides: Partial<Session> = {}): Session {
  return {
    language: "en",
    key: `-100:${index}`,
    groupId: -100,
    userId: index,
    userChatId: index,
    requestDate: 1_800_000_000 + index,
    requestId: `request-${index}`,
    title: "Group",
    nonce: `nonce${index}`,
    status: "active",
    questions: [],
    index: 0,
    formatVersion: 3,
    contentVersion: "test-content-v1",
    refreshes: 0,
    rules: { version: "rules-v1", text: "Read the rules." },
    expiresAt: DEADLINE,
    cooldownSeconds: 30,
    blockedUntil: 0,
    revision: 0,
    messageId: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nextDueAt", () => {
  const cases: Array<[string, Partial<Session>, number | null]> = [
    ["an unanswered session at its deadline", { status: "active" }, DEADLINE],
    ["a session awaiting rules at its deadline", { status: "awaiting_rules" }, DEADLINE],
    ["a decision with no lease immediately", { status: "approve_pending" }, 0],
    [
      "a decision when its lease lapses",
      { status: "decline_pending", effectLeaseUntil: DEADLINE + 7_000 },
      DEADLINE + 7_000,
    ],
    ["a finished session without a prompt never", { status: "approved", messageId: null }, null],
    [
      "a finished session whose prompt is gone never",
      { status: "declined", messageId: 5, messageDeletedAt: DEADLINE },
      null,
    ],
    ["a prompt at the deadline", { status: "approved", messageId: 5 }, DEADLINE],
    [
      "a prompt after its cleanup retry",
      { status: "declined", messageId: 5, cleanupRetryAt: DEADLINE + 9_000 },
      DEADLINE + 9_000,
    ],
    [
      "a prompt after its cleanup lease",
      { status: "declined", messageId: 5, cleanupLeaseUntil: DEADLINE + 60_000 },
      DEADLINE + 60_000,
    ],
  ];

  it.each(cases)("schedules %s", (_name, overrides, expected) => {
    expect(nextDueAt(makeSession(1, overrides))).toBe(expected);
  });

  it("is due exactly when the repository lists the session as actionable", async () => {
    const { database, close } = createTestDatabase();
    try {
      const repository = createRepository(database);
      const sessions = cases.map(([, overrides], offset) => makeSession(offset + 1, overrides));
      for (const session of sessions) await repository.createSession(session);

      for (const session of sessions) {
        const due = nextDueAt(session);
        for (const at of [0, DEADLINE - 1, DEADLINE, DEADLINE + 7_000, DEADLINE + 60_000]) {
          const listed = (await repository.listActionableSessions(at, 200)).some(
            (row) => row.key === session.key,
          );
          expect(listed, `${session.key} status=${session.status} at=${at}`).toBe(
            due !== null && due <= at,
          );
        }
      }
    } finally {
      close();
    }
  });
});

describe("withScheduling", () => {
  function fakeRepository(results: { create?: boolean; cas?: boolean } = {}) {
    return {
      createSession: vi.fn(async (_session: Session) => results.create ?? true),
      casSession: vi.fn(async (_previous: Session, _next: Session) => results.cas ?? true),
      getSession: vi.fn(async () => null),
    } as unknown as Repository;
  }

  it("arms the timer for a new session at its deadline", async () => {
    const schedule = vi.fn(async () => {});
    const repository = withScheduling(fakeRepository(), schedule);

    await expect(repository.createSession(makeSession(1))).resolves.toBe(true);

    expect(schedule).toHaveBeenCalledExactlyOnceWith("-100:1", DEADLINE);
  });

  it("re-arms only when a committed write moves the due time", async () => {
    const schedule = vi.fn(async () => {});
    const repository = withScheduling(fakeRepository(), schedule);
    const active = makeSession(1);

    await repository.casSession(active, { ...active, index: 1 });
    expect(schedule).not.toHaveBeenCalled();

    const lease = DEADLINE + 60_000;
    await repository.casSession(active, {
      ...active,
      status: "decline_pending",
      effectLeaseUntil: lease,
    });
    expect(schedule).toHaveBeenCalledExactlyOnceWith("-100:1", lease);
  });

  it("does not arm for a lost CAS or when nothing is left to do", async () => {
    const schedule = vi.fn(async () => {});
    const lost = withScheduling(fakeRepository({ cas: false, create: false }), schedule);
    const active = makeSession(1);
    await lost.casSession(active, { ...active, status: "decline_pending" });
    await lost.createSession(active);

    const finished = withScheduling(fakeRepository(), schedule);
    await finished.casSession(active, { ...active, status: "declined", messageId: null });

    expect(schedule).not.toHaveBeenCalled();
  });

  it("keeps the committed write when arming fails, logging only the error code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schedule = vi.fn(async () => {
      throw Object.assign(new Error("private-bot-token"), { code: 503 });
    });
    const repository = withScheduling(fakeRepository(), schedule);

    await expect(repository.createSession(makeSession(1))).resolves.toBe(true);

    expect(warn).toHaveBeenCalledWith("Cannot arm session timer", 503);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-bot-token");
  });
});
