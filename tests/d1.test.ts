import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepository } from "../src/lib/repository.js";
import type { PlatformProxy } from "wrangler";
import type { Repository, Session } from "../src/types.js";

let proxy: PlatformProxy<{ DB: D1Database }> | undefined;
let directory: string | undefined;
let repository: Repository;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "bot-d1-test-"));
  const configPath = join(directory, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "bot-d1-test",
      compatibility_date: "2026-10-11",
      d1_databases: [
        {
          binding: "DB",
          database_name: "bot-d1-test",
          database_id: "00000000-0000-0000-0000-000000000001",
        },
      ],
    }),
  );
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath,
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(new URL(name, migrations), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) await proxy.env.DB.prepare(statement).run();
    }
  }
  repository = createRepository(drizzle(proxy.env.DB));
}, 30_000);

afterAll(async () => {
  if (proxy) await proxy.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function session(userId: number): Session {
  return {
    key: `-100:${userId}`,
    groupId: -100,
    userId,
    userChatId: userId,
    language: "en",
    requestDate: 1,
    requestId: String(userId),
    title: "Test group",
    nonce: `fixture${userId}`,
    status: "active",
    questions: [],
    index: 0,
    formatVersion: 3,
    contentVersion: "fixture-v1",
    refreshes: 0,
    rules: { version: "fixture-v1", text: "Test rules" },
    expiresAt: 1000,
    cooldownSeconds: 30,
    blockedUntil: 0,
    revision: 0,
    messageId: 8,
  };
}

describe("real local D1 binding", () => {
  it("runs generated migrations and round-trips Drizzle JSON config", async () => {
    const config = {
      language: "en" as const,
      enabled: true,
      contentId: "fixture",
      timeoutSeconds: 300,
      cooldownSeconds: 30,
      deleteJoinMessages: true,
    };
    expect(await repository.getConfig(-100)).toBeNull();
    await repository.saveConfig(-100, config);
    expect(await repository.getConfig(-100)).toEqual(config);
  });

  it("uses D1 RETURNING for unique creation, CAS and maintenance metadata", async () => {
    const initial = session(1);
    expect(await repository.createSession(initial)).toBe(true);
    expect(await repository.createSession(initial)).toBe(false);
    const next: Session = { ...initial, status: "decline_pending", effectLeaseUntil: 5000 };
    expect(await repository.casSession(initial, next)).toBe(true);
    expect(next.revision).toBe(1);
    expect(await repository.casSession(initial, { ...initial, status: "approved" })).toBe(false);
    expect(await repository.listActionableSessions(2000, 3)).toEqual([]);
    expect(await repository.listActionableSessions(5000, 3)).toEqual([next]);
    const terminal: Session = { ...next, status: "declined", effectLeaseUntil: 0 };
    expect(await repository.casSession(next, terminal)).toBe(true);
    expect(await repository.listActionableSessions(5000, 3)).toEqual([terminal]);
    const deleted = { ...terminal, messageDeletedAt: 5000 };
    expect(await repository.casSession(terminal, deleted)).toBe(true);
    expect(await repository.listActionableSessions(5000, 3)).toEqual([]);
    expect(await repository.getSession(initial.key)).toEqual(deleted);
  });

  it("assembles content documents stored in D1 JSON columns", async () => {
    const db = proxy?.env.DB;
    if (!db) throw new Error("D1 platform proxy was not initialized");
    const question = (id: string) => ({
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
    });
    await db.batch([
      db.prepare("INSERT INTO packs (id, updated_at, payload) VALUES (?, ?, ?)").bind(
        "fixture",
        1,
        JSON.stringify({
          id: "fixture",
          version: "fixture-v2",
          rules: "fixture-rules",
          questionTypes: ["fixture"],
        }),
      ),
      db
        .prepare("INSERT INTO rules (id, updated_at, payload) VALUES (?, ?, ?)")
        .bind("fixture-rules", 1, JSON.stringify({ version: "rules-v2", cn: "规则", en: "Rules" })),
      ...[question("z-last"), question("a-first")].map((document) =>
        db
          .prepare("INSERT INTO questions (type, id, updated_at, payload) VALUES (?, ?, ?, ?)")
          .bind("fixture", document.id, 1, JSON.stringify(document)),
      ),
    ]);

    const pack = await repository.getContentPack("fixture");
    expect(pack?.version).toBe("fixture-v2");
    expect(pack?.rules).toEqual({ version: "rules-v2", cn: "规则", en: "Rules" });
    expect(pack?.questions.map(({ id }) => id)).toEqual(["a-first", "z-last"]);
    expect(await repository.getContentPack("absent")).toBeNull();
  });
});
