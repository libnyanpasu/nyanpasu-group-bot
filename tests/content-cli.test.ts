import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildContentSql,
  exportContentFiles,
  loadBlocklistValidator,
  loadContentValidator,
  parseArguments,
} from "../scripts/content-cli.mjs";
import { assembleContentPacks, readContentDocuments } from "../scripts/content-files.mjs";
import { validateContentPack } from "../src/lib/quiz.js";
import type { BlocklistDocument, Question } from "../src/types.js";

const question = (id: string, prompt = `Prompt ${id}`): Question => ({
  id,
  prompt,
  options: ["Fixture A", "Fixture B", "Fixture C", "Fixture D"],
  answerIndex: 0,
  translations: {
    en: {
      prompt: `${prompt} EN`,
      options: ["Fixture A", "Fixture B", "Fixture C", "Fixture D"],
    },
  },
});

function fixtureDocuments() {
  return {
    packs: [
      {
        id: "default",
        document: {
          id: "default",
          version: "test-v1",
          rules: "default",
          questionTypes: ["fixture"],
        },
      },
    ],
    rules: [
      {
        id: "default",
        document: { version: "rules-v1", cn: "测试专用规则。", en: "Test-only rules." },
      },
    ],
    questions: ["q1", "q2", "q3"].map((id) => ({
      type: "fixture",
      id,
      document: question(id),
    })),
    blocklists: [
      {
        id: "default",
        document: { version: "bl-v1", ban: ["fixture ban"], delete: ["fixture delete"] },
      },
    ] as { id: string; document: BlocklistDocument }[] | undefined,
  };
}

describe("content CLI", () => {
  it("builds idempotent upserts and escapes quoted payload text", () => {
    const documents = fixtureDocuments();
    documents.questions[0].document = question("q1", "Don't; split 'this'");
    const sql = buildContentSql(documents, { updatedAt: 123 });

    expect(sql).toContain("INSERT INTO packs (id, payload, updated_at) VALUES ('default'");
    expect(sql).toContain("ON CONFLICT(id) DO UPDATE SET payload = excluded.payload");
    expect(sql).toContain("ON CONFLICT(type, id) DO UPDATE SET payload = excluded.payload");
    expect((sql.match(/INSERT INTO questions/g) ?? []).length).toBe(3);
    expect(sql).toContain("Don''t; split ''this''");
    expect(sql).not.toContain("DELETE");
  });

  it("upserts blocklists and leaves them untouched when not selected", () => {
    const documents = fixtureDocuments();
    expect(buildContentSql(documents)).toContain(
      "INSERT INTO blocklists (id, payload, updated_at) VALUES ('default'",
    );
    documents.blocklists = undefined;
    const selected = buildContentSql(documents, { prune: true });
    expect(selected).not.toContain("blocklists");
  });

  it("validates blocklists with the bundled Worker validator", async () => {
    const validateBlocklist = await loadBlocklistValidator();
    expect(validateBlocklist(fixtureDocuments().blocklists?.[0].document)).toBeNull();
    expect(validateBlocklist({ version: "v", ban: ["!!"], delete: [] })).toMatch(/ban\[0\]/);
  });

  it("mirrors deletes only when pruning", () => {
    const sql = buildContentSql(fixtureDocuments(), { prune: true, updatedAt: 1 });
    expect(sql).toContain("DELETE FROM packs WHERE id NOT IN ('default');");
    expect(sql).toContain("DELETE FROM rules WHERE id NOT IN ('default');");
    expect(sql).toContain(
      "DELETE FROM questions WHERE NOT ((type = 'fixture' AND id IN ('q1', 'q2', 'q3')));",
    );

    expect(sql).toContain("DELETE FROM blocklists WHERE id NOT IN ('default');");

    const empty = buildContentSql(
      { packs: [], rules: [], questions: [], blocklists: [] },
      { prune: true },
    );
    expect(empty).toContain("DELETE FROM blocklists;");
    expect(empty).toContain("DELETE FROM packs;");
    expect(empty).toContain("DELETE FROM rules;");
    expect(empty).toContain("DELETE FROM questions;");
  });

  it("exports the checkout layout and round-trips documents", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-content-cli-"));
    try {
      const documents = fixtureDocuments();
      const written = exportContentFiles(directory, documents);
      expect(written).toEqual({ packs: 1, rules: 1, questions: 3, blocklists: 1 });
      const blocklistFile = JSON.parse(
        readFileSync(join(directory, "blocklists/default.json"), "utf8"),
      );
      expect(blocklistFile.$schema).toBe("../schemas/blocklist.schema.json");

      const packFile = JSON.parse(readFileSync(join(directory, "packs/default.json"), "utf8"));
      expect(packFile.$schema).toBe("../schemas/pack.schema.json");
      expect(packFile.id).toBe("default");
      const questionFile = JSON.parse(
        readFileSync(join(directory, "questions/fixture/q2.json"), "utf8"),
      );
      expect(questionFile.$schema).toBe("../../schemas/question.schema.json");
      expect(questionFile.id).toBe("q2");

      const readBack = readContentDocuments(directory, true);
      expect(readBack.blocklists).toEqual(documents.blocklists);
      expect(assembleContentPacks(readBack, validateContentPack)).toEqual(
        assembleContentPacks(documents, validateContentPack),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite existing content without --force", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-content-cli-"));
    try {
      exportContentFiles(directory, fixtureDocuments());
      expect(() => exportContentFiles(directory, fixtureDocuments())).toThrow(/--force/);
      expect(exportContentFiles(directory, fixtureDocuments(), { force: true }).packs).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses arguments and rejects invalid combinations", () => {
    expect(parseArguments(["push", "--remote", "--prune", "default"])).toMatchObject({
      command: "push",
      remote: true,
      prune: true,
      directory: "private-content",
      packs: ["default"],
    });
    expect(parseArguments(["pull", "--dir", "/tmp/checkout"]).directory).toBe("/tmp/checkout");
    expect(() => parseArguments([])).toThrow(/Usage/);
    expect(() => parseArguments(["list", "--force"])).toThrow(/--force/);
    expect(() => parseArguments(["pull", "--prune"])).toThrow(/--prune/);
    expect(() => parseArguments(["list", "default"])).toThrow(/push/);
    expect(() => parseArguments(["push", "--dir"])).toThrow(/--dir/);
    expect(() => parseArguments(["push", "--unknown"])).toThrow(/Unknown option/);
  });

  it("bundles the shared runtime validator", async () => {
    const validate = await loadContentValidator();
    const [pack] = assembleContentPacks(fixtureDocuments(), validate);
    expect(validate(pack)).toBeNull();
    expect(typeof validate({})).toBe("string");
  });
});
