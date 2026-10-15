import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it } from "vitest";

import { blocklists, packs, questions, rules, schema } from "../src/schema.js";
import { createRepository } from "../src/lib/repository.js";
import type { Config, Question, Session } from "../src/types.js";

const closeDatabases: Array<() => void> = [];
const migrationDirectory = new URL("../migrations/", import.meta.url);

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      sqlite.close();
    }
  };
  closeDatabases.push(close);

  for (const filename of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql"))) {
    sqlite.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }

  const database = drizzle(
    async (
      query: string,
      params: unknown[],
      method: "run" | "all" | "values" | "get",
    ): Promise<{ rows: SQLOutputValue[][] }> => {
      const statement = sqlite.prepare(query);
      const values = params as SQLInputValue[];
      if (method === "run") {
        statement.run(...values);
        return { rows: [] };
      }

      if (method === "get") {
        const row = statement.get(...values);
        return { rows: row ? [Object.values(row)] : [] };
      }
      return { rows: statement.all(...values).map((row) => Object.values(row)) };
    },
    { schema },
  );

  return { database, sqlite, close };
}

function makeSession(index: number, overrides: Partial<Session> = {}): Session {
  return {
    language: "en",
    key: `-100:${index}`,
    groupId: -100,
    userId: index,
    userChatId: index,
    requestDate: 1_800_000_000 + index,
    requestId: `request-${index}`,
    title: `Group ${index}`,
    nonce: `nonce-${index}`,
    status: "active",
    questions: [],
    index: 0,
    formatVersion: 3,
    contentVersion: "test-content-v1",
    refreshes: 0,
    rules: { version: "rules-v1", text: "Read the rules." },
    expiresAt: 1_800_000_000_000,
    cooldownSeconds: 30,
    blockedUntil: 0,
    revision: 0,
    messageId: null,
    ...overrides,
  };
}

function contentQuestion(id: string): Question {
  return {
    id,
    prompt: `Fixture ${id}`,
    options: ["Fixture A", "Fixture B", "Fixture C", "Fixture D"],
    answerIndex: 0,
    translations: {
      en: {
        prompt: `Fixture ${id} EN`,
        options: ["Fixture A", "Fixture B", "Fixture C", "Fixture D"],
      },
    },
  };
}

const config: Config = {
  language: "en",
  enabled: true,
  contentId: "test-content",
  timeoutSeconds: 300,
  cooldownSeconds: 30,
  deleteJoinMessages: false,
};

afterEach(() => {
  for (const close of closeDatabases.splice(0)) close();
});

describe("repository", () => {
  it("round-trips configurations and replaces previous values", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      expect(await repository.getConfig(-100)).toBeNull();
      expect(await repository.saveConfig(-100, config)).toEqual(config);
      expect(await repository.getConfig(-100)).toEqual(config);

      const replacement = { ...config, enabled: false };
      await repository.saveConfig(-100, replacement);
      expect(await repository.getConfig(-100)).toEqual(replacement);
    } finally {
      close();
    }
  });

  it("stores blocklists and counts member messages per group", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      expect(await repository.getBlocklist("default")).toBeNull();
      await database
        .insert(blocklists)
        .values({
          id: "default",
          updatedAt: 1,
          payload: { version: "v1", ban: ["xx"], delete: [] },
        })
        .run();
      expect(await repository.getBlocklist("default")).toEqual({
        version: "v1",
        ban: ["xx"],
        delete: [],
      });

      expect(await repository.getMemberMessages(-100, 7)).toBe(0);
      await repository.recordMemberMessage(-100, 7, 1);
      await repository.recordMemberMessage(-100, 7, 2);
      await repository.recordMemberMessage(-200, 7, 3);
      expect(await repository.getMemberMessages(-100, 7)).toBe(2);
      await repository.resetMembers(-100, [7, 8]);
      await repository.resetMembers(-100, []);
      expect(await repository.getMemberMessages(-100, 7)).toBe(0);
      expect(await repository.getMemberMessages(-200, 7)).toBe(1);
    } finally {
      close();
    }
  });

  it("keeps an unset join-message preference distinct from an explicit off", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      const { deleteJoinMessages: _omitted, ...inherited } = config;
      await repository.saveConfig(-100, inherited);
      expect(await repository.getConfig(-100)).toEqual(inherited);
      await repository.saveConfig(-100, { ...inherited, deleteJoinMessages: false });
      expect(await repository.getConfig(-100)).toEqual({ ...inherited, deleteJoinMessages: false });
    } finally {
      close();
    }
  });

  it("strips legacy embedded question banks when reading and saving configuration", async () => {
    const { database, sqlite, close } = setup();
    try {
      const repository = createRepository(database);
      const legacy = {
        ...config,
        questionCount: 1,
        maxMistakes: 0,
        bankConfirmed: true,
        questions: [
          {
            prompt: "legacy-private-question-should-not-be-kept",
            options: ["private option", "other"],
            answerIndex: 0,
          },
        ],
      };
      sqlite
        .prepare("INSERT INTO groups (group_id, payload) VALUES (?, ?)")
        .run(-100, JSON.stringify(legacy));

      expect(await repository.getConfig(-100)).toEqual(config);
      expect(await repository.saveConfig(-100, legacy)).toEqual(config);
      const storedPayload = sqlite
        .prepare("SELECT payload FROM groups WHERE group_id = ?")
        .get(-100)?.payload;
      expect(typeof storedPayload).toBe("string");
      if (typeof storedPayload !== "string") throw new Error("Stored configuration was not text");
      expect(JSON.parse(storedPayload)).toEqual(config);
      expect(storedPayload).not.toContain("legacy-private-question-should-not-be-kept");
    } finally {
      close();
    }
  });

  it("creates unique sessions and uses revision compare-and-swap", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      const original = makeSession(42);
      expect(await repository.createSession(original)).toBe(true);
      expect(await repository.createSession(original)).toBe(false);
      expect(await repository.getSession(original.key)).toEqual(original);

      const next = { ...original, status: "awaiting_rules" as const };
      expect(await repository.casSession(original, next)).toBe(true);
      expect(next.revision).toBe(1);
      expect(await repository.getSession(original.key)).toEqual(next);

      const staleNext = { ...original, status: "declined" as const };
      expect(await repository.casSession(original, staleNext)).toBe(false);
      expect(staleNext.revision).toBe(0);
      expect(await repository.getSession(original.key)).toEqual(next);
    } finally {
      close();
    }
  });

  it("assembles content packs from stored documents in checkout order", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      await database.insert(packs).values({
        id: "test-content",
        updatedAt: 1,
        payload: {
          id: "test-content",
          version: "test-content-v2",
          rules: "main-rules",
          questionTypes: ["typescript", "networking"],
        },
      });
      await database.insert(rules).values({
        id: "main-rules",
        updatedAt: 1,
        payload: { version: "rules-v2", cn: "测试规则", en: "Test rules" },
      });
      for (const [type, id] of [
        ["networking", "z-last"],
        ["networking", "a-first"],
        ["typescript", "strict"],
      ] as const) {
        await database
          .insert(questions)
          .values({ type, id, updatedAt: 1, payload: contentQuestion(id) });
      }

      const pack = await repository.getContentPack("test-content");
      expect(pack?.version).toBe("test-content-v2");
      expect(pack?.rules.version).toBe("rules-v2");
      expect(pack?.questions.map(({ id }) => id)).toEqual(["a-first", "z-last", "strict"]);
      expect(await repository.getContentPack("missing")).toBeNull();

      await database.insert(packs).values({
        id: "broken",
        updatedAt: 1,
        payload: {
          id: "broken",
          version: "broken-v1",
          rules: "missing-rules",
          questionTypes: ["networking"],
        },
      });
      expect(await repository.getContentPack("broken")).toBeNull();
    } finally {
      close();
    }
  });

  it("sorts session listings newest first and applies fixed bounds", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      for (let index = 0; index < 125; index += 1) {
        const userId = index < 25 ? 7 : 8;
        const session = makeSession(index, {
          userId,
          requestDate: 1_800_000_000 + index * 60,
        });
        expect(await repository.createSession(session)).toBe(true);
      }

      const userSessions = await repository.listSessionsForUser(7);
      expect(userSessions).toHaveLength(20);
      expect(userSessions[0]?.key).toBe("-100:24");
      expect(userSessions.at(-1)?.key).toBe("-100:5");

      const groupSessions = await repository.listSessionsForGroup(-100);
      expect(groupSessions).toHaveLength(100);
      expect(groupSessions[0]?.key).toBe("-100:124");
    } finally {
      close();
    }
  });

  it("returns only expired, due, and undeleted sessions with bounded scans", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      const now = 1_800_000_000_000;
      const candidates = [
        makeSession(1, { status: "active", expiresAt: now - 1 }),
        makeSession(2, { status: "awaiting_rules", expiresAt: now }),
        makeSession(3, { status: "active", expiresAt: now + 1 }),
        makeSession(4, { status: "approve_pending", effectLeaseUntil: now - 1 }),
        makeSession(5, { status: "decline_pending" }),
        makeSession(6, { status: "approve_pending", effectLeaseUntil: now + 1 }),
        makeSession(7, {
          status: "approved",
          expiresAt: now - 2,
          messageId: 77,
        }),
        makeSession(8, {
          status: "declined",
          expiresAt: now - 2,
          messageId: 78,
          cleanupRetryAt: now,
          cleanupLeaseUntil: now,
        }),
        makeSession(9, {
          status: "approved",
          expiresAt: now + 1,
          messageId: 79,
        }),
        makeSession(10, {
          status: "declined",
          expiresAt: now - 2,
          messageId: 80,
          messageDeletedAt: now - 1,
        }),
        makeSession(11, {
          status: "approved",
          expiresAt: now - 2,
          messageId: 81,
          cleanupRetryAt: now + 1,
        }),
        makeSession(12, {
          status: "declined",
          expiresAt: now - 2,
          messageId: 82,
          cleanupLeaseUntil: now + 1,
        }),
      ];
      for (const session of candidates) expect(await repository.createSession(session)).toBe(true);

      const due = await repository.listActionableSessions(now);
      expect(due.map(({ key }) => key).sort()).toEqual(
        ["-100:1", "-100:2", "-100:4", "-100:5", "-100:7", "-100:8"].sort(),
      );
      expect(await repository.listActionableSessions(now, 2)).toHaveLength(2);
      expect(await repository.listActionableSessions(now, 200)).toHaveLength(6);
      expect(await repository.listActionableSessions(now, 0)).toEqual([]);
    } finally {
      close();
    }
  });

  it("orders overdue work ahead of sessions whose retry time is newer", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      const now = 1_800_000_000_000;
      const sessions = [
        makeSession(20, { status: "active", expiresAt: now - 20_000 }),
        makeSession(21, { status: "awaiting_rules", expiresAt: now - 10_000 }),
        makeSession(22, {
          status: "approve_pending",
          expiresAt: now - 86_400_000,
          effectLeaseUntil: now - 5_000,
        }),
        makeSession(23, {
          status: "approved",
          expiresAt: now - 172_800_000,
          messageId: 823,
          cleanupRetryAt: now - 3_000,
        }),
      ];
      for (const session of sessions) expect(await repository.createSession(session)).toBe(true);

      const batch = await repository.listActionableSessions(now, 2);
      expect(batch.map(({ key }) => key)).toEqual(["-100:20", "-100:21"]);
    } finally {
      close();
    }
  });

  it("caps a due scan at 100 rows", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      const now = 1_800_000_000_000;
      for (let index = 0; index < 105; index += 1) {
        const session = makeSession(index, { expiresAt: now - 1 });
        expect(await repository.createSession(session)).toBe(true);
      }

      expect(await repository.listActionableSessions(now)).toHaveLength(100);
      expect(await repository.listActionableSessions(now, 105)).toHaveLength(100);
    } finally {
      close();
    }
  });
});

describe("admin targets", () => {
  it("returns null when no group is saved", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      expect(await repository.getAdminTarget(7, 0)).toBeNull();
    } finally {
      close();
    }
  });

  it("returns the saved group while its timestamp is at or after notBefore", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      await repository.setAdminTarget(7, -100, 1_000);
      expect(await repository.getAdminTarget(7, 1_000)).toBe(-100);
      expect(await repository.getAdminTarget(7, 500)).toBe(-100);
    } finally {
      close();
    }
  });

  it("returns null once notBefore is later than the saved timestamp", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      await repository.setAdminTarget(7, -100, 1_000);
      expect(await repository.getAdminTarget(7, 1_001)).toBeNull();
    } finally {
      close();
    }
  });

  it("overwrites the group and timestamp when the same user selects again", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      await repository.setAdminTarget(7, -100, 1_000);
      await repository.setAdminTarget(7, -200, 5_000);
      expect(await repository.getAdminTarget(7, 0)).toBe(-200);
      expect(await repository.getAdminTarget(7, 5_000)).toBe(-200);
      expect(await repository.getAdminTarget(7, 5_001)).toBeNull();
    } finally {
      close();
    }
  });

  it("keeps selections independent between users", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      await repository.setAdminTarget(7, -100, 1);
      await repository.setAdminTarget(8, -200, 2);
      expect(await repository.getAdminTarget(7, 0)).toBe(-100);
      expect(await repository.getAdminTarget(8, 0)).toBe(-200);

      await repository.setAdminTarget(8, -300, 3);
      expect(await repository.getAdminTarget(7, 0)).toBe(-100);
      expect(await repository.getAdminTarget(8, 0)).toBe(-300);
    } finally {
      close();
    }
  });

  it("clears only the given user's selection", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      await repository.setAdminTarget(7, -100, 1);
      await repository.setAdminTarget(8, -200, 2);
      await repository.clearAdminTarget(7);
      expect(await repository.getAdminTarget(7, 0)).toBeNull();
      expect(await repository.getAdminTarget(8, 0)).toBe(-200);
    } finally {
      close();
    }
  });

  it("prunes selections older than the cutoff and keeps newer ones", async () => {
    const { database, close } = setup();
    try {
      const repository = createRepository(database);
      await repository.setAdminTarget(1, -100, 100);
      await repository.setAdminTarget(2, -200, 200);
      await repository.setAdminTarget(3, -300, 300);
      await repository.pruneAdminTargets(200);
      expect(await repository.getAdminTarget(1, 0)).toBeNull();
      expect(await repository.getAdminTarget(2, 0)).toBe(-200);
      expect(await repository.getAdminTarget(3, 0)).toBe(-300);
    } finally {
      close();
    }
  });
});
