import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { validateContentPack } from "../src/lib/quiz.js";
import {
  assembleContentPacks,
  loadContent,
  readContentDocuments,
} from "../scripts/content-files.mjs";
import type { Question } from "../src/types.js";

interface PackFixture {
  id: string;
  version: string;
  questionTypes: string[];
  rules: string;
}

type QuestionModifier = (question: Question) => unknown;

const q = (id: string, prompt = `Fixture prompt ${id}`): Question => ({
  id,
  prompt,
  options: ["Fixture A", "Fixture B", "Fixture C", "Fixture D"],
  answerIndex: 1,
  translations: {
    en: {
      prompt: `English ${prompt}`,
      options: ["Fixture A", "Fixture B", "Fixture C", "Fixture D"],
    },
  },
});

const pack = (id = "default", questionTypes = ["fixture"]): PackFixture => ({
  id,
  version: `test-${id}-v1`,
  questionTypes,
  rules: id,
});

function writeJson(root: string, path: string, value: unknown): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, JSON.stringify(value) ?? "null");
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bot-content-"));
  const dirs = ["packs", "rules", "questions/fixture"];
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  writeJson(root, "packs/default.json", pack());
  writeJson(root, "rules/default.json", {
    version: "rules-test-v1",
    cn: "测试专用规则文本，不用于真实群组。",
    en: "Test-only rules. Not for real groups.",
  });
  writeJson(root, "questions/fixture/test-0.json", q("test-0"));
  writeJson(root, "questions/fixture/test-1.json", q("test-1"));
  writeJson(root, "questions/fixture/test-2.json", q("test-2"));
  return root;
}

function withRoot(test: (root: string) => void): void {
  const root = fixtureRoot();
  try {
    test(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("content checkout files", () => {
  it("allows an absent optional checkout but requires it for deployment", () => {
    const root = mkdtempSync(join(tmpdir(), "bot-content-"));
    try {
      expect(loadContent(join(root, "missing"), false, validateContentPack)).toEqual([]);
      expect(() => loadContent(join(root, "missing"), true, validateContentPack)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assembles multiple question types and filenames in deterministic order", () => {
    withRoot((root) => {
      mkdirSync(join(root, "questions/second"));
      writeJson(root, "questions/fixture/z-last.json", q("z-last"));
      writeJson(root, "questions/fixture/a-first.json", q("a-first"));
      writeJson(root, "questions/second/middle.json", q("middle"));
      writeJson(root, "packs/other.json", pack("other", ["second", "fixture"]));
      writeJson(root, "rules/other.json", {
        version: "other-rules-v1",
        cn: "另一个测试规则。",
        en: "Other test rules.",
      });

      const content = loadContent(root, true, validateContentPack);
      expect(content.map(({ id }) => id)).toEqual(["default", "other"]);
      expect(content[0].questions.map(({ id }) => id)).toEqual([
        "a-first",
        "test-0",
        "test-1",
        "test-2",
        "z-last",
      ]);
      expect(content[1].questions.map(({ id }) => id)).toEqual([
        "a-first",
        "test-0",
        "test-1",
        "test-2",
        "z-last",
        "middle",
      ]);
    });
  });

  it("returns documents keyed for database sync without $schema markers", () => {
    withRoot((root) => {
      const documents = readContentDocuments(root, true);
      expect(documents.packs.map(({ id }) => id)).toEqual(["default"]);
      expect(documents.rules.map(({ id }) => id)).toEqual(["default"]);
      expect(documents.questions.map(({ type, id }) => `${type}/${id}`)).toEqual([
        "fixture/test-0",
        "fixture/test-1",
        "fixture/test-2",
      ]);
      expect(documents.questions[0].document).not.toHaveProperty("$schema");
      expect(assembleContentPacks(documents, validateContentPack)).toEqual(
        loadContent(root, true, validateContentPack),
      );
    });
  });

  it("accepts an optional question $schema marker but omits it from runtime content", () => {
    withRoot((root) => {
      writeJson(root, "questions/fixture/test-0.json", {
        ...q("test-0"),
        $schema: "https://json-schema.org/draft/2020-12/schema",
      });
      const content = loadContent(root, true, validateContentPack);
      expect(content[0].questions[0]).not.toHaveProperty("$schema");
      expect(content[0].questions[0].id).toBe("test-0");
    });
  });

  it("rejects an existing empty or invalid packs directory even for optional loads", () => {
    const root = mkdtempSync(join(tmpdir(), "bot-content-"));
    try {
      mkdirSync(join(root, "packs"));
      expect(() => loadContent(root, false, validateContentPack)).toThrow();
      writeJson(root, "rules/not-default.json", {
        version: "rules-test-v1",
        cn: "测试规则。",
        en: "Test rules.",
      });
      writeJson(root, "packs/not-default.json", { ...pack("not-default"), rules: "not-default" });
      mkdirSync(join(root, "questions"));
      mkdirSync(join(root, "questions/fixture"));
      writeJson(root, "questions/fixture/test-0.json", q("test-0"));
      writeJson(root, "questions/fixture/test-1.json", q("test-1"));
      writeJson(root, "questions/fixture/test-2.json", q("test-2"));
      expect(() => loadContent(root, false, validateContentPack)).toThrow(/default/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects schema violations and unknown properties with a relative path but no content", () => {
    withRoot((root) => {
      const secret = "PRIVATE_QUESTION_BODY_SENTINEL";
      writeJson(root, "questions/fixture/test-0.json", {
        ...q("test-0", secret),
        answerIndex: "1",
      });
      let message = "";
      try {
        loadContent(root, true, validateContentPack);
      } catch (error: unknown) {
        message = String(error);
      }
      expect(message).toMatch(/questions[\\/]fixture[\\/]test-0\.json/);
      expect(message).not.toContain(secret);

      writeJson(root, "questions/fixture/test-0.json", {
        ...q("test-0"),
        internalNotes: "must be rejected by additionalProperties=false",
      });
      expect(() => loadContent(root, true, validateContentPack)).toThrow(
        /questions[\\/]fixture[\\/]test-0\.json/,
      );
    });
  });

  it.each<[string, QuestionModifier]>([
    ["missing English translation", (question) => ({ ...question, translations: {} })],
    ["three choices", (question) => ({ ...question, options: question.options.slice(0, 3) })],
    ["answer index outside the choices", (question) => ({ ...question, answerIndex: 4 })],
  ])("rejects a question with %s", (_label, modify) => {
    withRoot((root) => {
      writeJson(root, "questions/fixture/test-0.json", modify(q("test-0")));
      expect(() => loadContent(root, true, validateContentPack)).toThrow(
        /questions[\\/]fixture[\\/]test-0\.json/,
      );
    });
  });

  it("does not include malformed JSON content in the validation error", () => {
    withRoot((root) => {
      const secret = "PRIVATE_MALFORMED_JSON_SENTINEL";
      writeFileSync(join(root, "questions/fixture/test-0.json"), `{"prompt":"${secret}"`);
      let message = "";
      try {
        loadContent(root, true, validateContentPack);
      } catch (error: unknown) {
        message = String(error);
      }
      expect(message).toMatch(/questions[\\/]fixture[\\/]test-0\.json/);
      expect(message).not.toContain(secret);
    });
  });

  it("rejects a legacy content.json both without packs and beside valid per-question content", () => {
    const rootWithoutPacks = mkdtempSync(join(tmpdir(), "bot-content-"));
    try {
      writeFileSync(join(rootWithoutPacks, "content.json"), "[]");
      expect(() => loadContent(rootWithoutPacks, false, validateContentPack)).toThrow(
        /content\.json.*legacy/i,
      );
    } finally {
      rmSync(rootWithoutPacks, { recursive: true, force: true });
    }

    withRoot((root) => {
      writeFileSync(join(root, "content.json"), "[]");
      expect(() => loadContent(root, true, validateContentPack)).toThrow(/content\.json.*legacy/i);
    });
  });

  it("rejects pack and question identity mismatches", () => {
    withRoot((root) => {
      writeJson(root, "packs/default.json", { ...pack(), id: "other" });
      expect(() => loadContent(root, true, validateContentPack)).toThrow(/packs[\\/]default\.json/);
      writeJson(root, "packs/default.json", pack());
      writeJson(root, "questions/fixture/test-0.json", q("not-test-0"));
      expect(() => loadContent(root, true, validateContentPack)).toThrow(
        /questions[\\/]fixture[\\/]test-0\.json/,
      );
    });
  });

  it("rejects duplicate question IDs across different question types", () => {
    withRoot((root) => {
      mkdirSync(join(root, "questions/second"));
      writeJson(root, "questions/second/test-0.json", q("test-0"));
      writeJson(root, "packs/default.json", pack("default", ["fixture", "second"]));
      expect(() => loadContent(root, true, validateContentPack)).toThrow(
        /invalid|questions[\\/]second[\\/]test-0\.json/i,
      );
    });
  });

  it("rejects missing rules, missing question types, and empty types", () => {
    withRoot((root) => {
      rmSync(join(root, "rules/default.json"));
      expect(() => loadContent(root, true, validateContentPack)).toThrow(/rules[\\/]default\.json/);
      writeJson(root, "rules/default.json", {
        version: "rules-test-v1",
        cn: "测试规则。",
        en: "Test rules.",
      });

      writeJson(root, "packs/default.json", pack("default", ["missing"]));
      expect(() => loadContent(root, true, validateContentPack)).toThrow(/questions[\\/]missing/);
      mkdirSync(join(root, "questions/missing"));
      expect(() => loadContent(root, true, validateContentPack)).toThrow(/questions[\\/]missing/);
    });
  });

  it("rejects symlinked question directories and files", () => {
    withRoot((root) => {
      const external = mkdtempSync(join(tmpdir(), "bot-content-external-"));
      try {
        mkdirSync(join(external, "linked-type"));
        writeJson(external, "linked-type/test-0.json", q("test-0"));
        symlinkSync(join(external, "linked-type"), join(root, "questions/linked"), "dir");
        writeJson(root, "packs/default.json", pack("default", ["fixture", "linked"]));
        expect(() => loadContent(root, true, validateContentPack)).toThrow(/symlink/i);
        rmSync(join(root, "questions/linked"));

        symlinkSync(
          join(root, "questions/fixture/test-0.json"),
          join(root, "questions/fixture/linked.json"),
          "file",
        );
        expect(() => loadContent(root, true, validateContentPack)).toThrow(/symlink/i);
      } finally {
        rmSync(external, { recursive: true, force: true });
      }
    });
  });

  it("rejects non-slug paths and directories without echoing their names as content", () => {
    withRoot((root) => {
      mkdirSync(join(root, "questions/bad type"));
      writeJson(root, "packs/default.json", pack("default", ["bad type"]));
      expect(() => loadContent(root, true, validateContentPack)).toThrow(/packs[\\/]default\.json/);
      expect(existsSync(join(root, "questions/bad type"))).toBe(true);
    });
  });
});
