import { afterEach, describe, expect, it, vi } from "vitest";
import {
  casListed,
  clearBlocklistCache,
  compileBlocklist,
  detectSpam,
  loadBlocklist,
  normalizeSpamText,
  spacedHan,
  spamDefaultsFromEnv,
  spamSettings,
  validateBlocklist,
} from "../src/lib/spam.js";
import type { Message } from "../src/types.js";

const message = (overrides: Partial<Message>): Message => ({
  message_id: 1,
  chat: { id: -100, type: "supergroup" },
  ...overrides,
});

afterEach(() => clearBlocklistCache());

describe("normalizeSpamText", () => {
  it("folds width, case, look-alikes, separators, emoji and zero-width characters", () => {
    expect(normalizeSpamText("Ｔ ｅ\u200bｌ-Е🔥gram")).toBe("telegram");
    expect(normalizeSpamText("ⓐⓓ  ⑧⑧")).toBe("ad88");
    expect(normalizeSpamText("日·入，过 万！")).toBe("日入过万");
  });
});

describe("validateBlocklist", () => {
  it("accepts tiers of entries and rejects unusable ones", () => {
    expect(validateBlocklist({ version: "v1", ban: ["日入过万", "=加我"], delete: [] })).toBeNull();
    expect(validateBlocklist({ version: "", ban: [], delete: [] })).toMatch(/version/);
    expect(validateBlocklist({ version: "v1", ban: "x", delete: [] })).toMatch(/ban/);
    expect(validateBlocklist({ version: "v1", ban: [], delete: ["a"] })).toMatch(/delete\[0\]/);
    expect(validateBlocklist({ version: "v1", ban: ["= !"], delete: [] })).toMatch(/ban\[0\]/);
  });
});

describe("detectSpam", () => {
  const matcher = compileBlocklist({ version: "v1", ban: ["usdt"], delete: ["看简介"] });

  it("prefers the ban tier and inspects hidden link targets", () => {
    expect(
      detectSpam(
        message({
          text: "看简介",
          entities: [{ type: "text_link", url: "https://example.test/USDT" }],
        }),
        matcher,
      ),
    ).toEqual({ action: "ban", reason: "keyword" });
    expect(detectSpam(message({ quote: { text: "看 简 介" } }), matcher)).toEqual({
      action: "delete",
      reason: "keyword",
    });
    expect(detectSpam(message({ text: "normal chat" }), matcher)).toBeNull();
    expect(detectSpam(message({ text: "usdt" }), null)).toBeNull();
  });
});

describe("spacedHan", () => {
  it("needs enough Han characters and a high spacing ratio", () => {
    expect(spacedHan("加 微 信 领 钱")).toBe(true);
    expect(spacedHan("加　微　信　领　钱")).toBe(true);
    expect(spacedHan("加 微 信")).toBe(false);
    expect(spacedHan("今天 天气 不错 我们 出去 玩")).toBe(false);
  });
});

describe("loadBlocklist", () => {
  it("caches compiled documents for a minute and ignores invalid ones", async () => {
    const load = vi.fn(async () => ({ version: "v1", ban: ["usdt"], delete: [] }));
    expect((await loadBlocklist(load, "default", 0))?.version).toBe("v1");
    await loadBlocklist(load, "default", 59_999);
    expect(load).toHaveBeenCalledOnce();
    await loadBlocklist(load, "default", 60_000);
    expect(load).toHaveBeenCalledTimes(2);

    clearBlocklistCache();
    expect(await loadBlocklist(async () => ({ version: "", ban: [], delete: [] }))).toBeNull();
  });
});

describe("casListed", () => {
  it("only treats ok: true as listed and fails open", async () => {
    const reply = (body: unknown) => async () => Response.json(body);
    expect(await casListed(1, reply({ ok: true, result: {} }))).toBe(true);
    expect(await casListed(1, reply({ ok: false, description: "Record not found." }))).toBe(false);
    expect(await casListed(1, async () => new Response("bad", { status: 502 }))).toBe(false);
    expect(
      await casListed(1, async () => {
        throw new Error("offline");
      }),
    ).toBe(false);
  });
});

describe("spam defaults", () => {
  it("reads Worker variables and falls back on missing or malformed values", () => {
    expect(spamDefaultsFromEnv({})).toEqual({
      mode: "off",
      firstMessages: 3,
      ban: true,
      cas: true,
    });
    expect(
      spamDefaultsFromEnv({
        SPAM_MODE: " ALL ",
        SPAM_FIRST_MESSAGES: "5",
        SPAM_BAN: "false",
        SPAM_CAS: "0",
      }),
    ).toEqual({ mode: "all", firstMessages: 5, ban: false, cas: false });
    expect(
      spamDefaultsFromEnv({
        SPAM_MODE: "on",
        SPAM_FIRST_MESSAGES: "0",
        SPAM_BAN: "maybe",
        SPAM_CAS: "",
      }),
    ).toEqual({ mode: "off", firstMessages: 3, ban: true, cas: true });
    expect(spamDefaultsFromEnv({ SPAM_FIRST_MESSAGES: "101" }).firstMessages).toBe(3);
    expect(spamDefaultsFromEnv({ SPAM_FIRST_MESSAGES: "2.5" }).firstMessages).toBe(3);
  });

  it("lets group settings override the defaults field by field", () => {
    const defaults = { mode: "all" as const, firstMessages: 5, ban: false, cas: false };
    expect(spamSettings(null, defaults)).toEqual(defaults);
    expect(
      spamSettings(
        {
          language: "cn",
          enabled: false,
          contentId: "default",
          timeoutSeconds: 300,
          cooldownSeconds: 1800,
          spamMode: "new",
          spamBan: true,
        },
        defaults,
      ),
    ).toEqual({ mode: "new", firstMessages: 5, ban: true, cas: false });
  });
});
