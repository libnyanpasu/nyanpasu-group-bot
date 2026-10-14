import { describe, expect, it } from "vitest";
import {
  answerSession,
  callbackData,
  createSession,
  DEFAULT_CONFIG,
  MAX_REFRESHES,
  parseCallbackData,
  refreshCallbackData,
  refreshSession,
  renderQuestion,
  selectQuestions,
  validateConfig,
  validateContentPack,
} from "../src/lib/quiz.ts";
import { detectLanguage, t } from "../src/lib/i18n.ts";
import type { Config, ContentPack, Session } from "../src/types.js";
import type { CreateSessionInput } from "../src/lib/quiz.js";

const makeQuestion = (id: string) => ({
  id,
  prompt: `题目 ${id}`,
  options: ["正确选项", "干扰选项一", "干扰选项二", "干扰选项三"],
  answerIndex: 0,
  explanation: `解释 ${id}`,
  translations: {
    en: {
      prompt: `Question ${id}`,
      options: ["Correct choice", "Distractor one", "Distractor two", "Distractor three"],
      explanation: `Explanation ${id}`,
    },
  },
});

const makePack = (overrides: Partial<ContentPack> = {}): ContentPack => ({
  id: "default",
  version: "2026-10",
  questions: [makeQuestion("q-a"), makeQuestion("q-b"), makeQuestion("q-c"), makeQuestion("q-d")],
  rules: { version: "rules-4", cn: "社区规则中文版。", en: "Community rules in English." },
  ...overrides,
});

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
  ...DEFAULT_CONFIG,
  ...overrides,
});
const NOW = 1_800_000_000_000;

const makeSession = (overrides: Partial<CreateSessionInput> = {}) =>
  createSession({
    key: "group:1:user:2",
    groupId: -1,
    userId: 2,
    userChatId: 2,
    requestDate: 1_800_000_000,
    requestId: "request-1",
    title: "社区问答",
    nonce: "abc123",
    config: makeConfig(),
    content: makePack(),
    now: NOW,
    random: () => 0.37,
    ...overrides,
  });

function answerCurrent(
  session: Session,
  option = session.questions[session.index].answerIndex,
  now = NOW,
) {
  return answerSession(session, {
    userId: session.userId,
    nonce: session.nonce,
    index: session.index,
    option,
    now,
  });
}

function skipToIndex(session: Session, target: number) {
  let current = session;
  while (current.index < target) {
    const result = refreshSession(current, {
      userId: current.userId,
      nonce: current.nonce,
      index: current.index,
      now: NOW + 1000 * (current.index + 1),
    });
    current = result.session;
  }
  return current;
}

describe("quiz config and private content pack validation", () => {
  it("validates advertising filter settings", () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, spamMode: "new", spamFirstMessages: 3 })).toBeNull();
    expect(validateConfig({ ...DEFAULT_CONFIG, spamMode: "some" })).toMatch(/spamMode/);
    expect(validateConfig({ ...DEFAULT_CONFIG, spamFirstMessages: 0 })).toMatch(
      /spamFirstMessages/,
    );
    expect(validateConfig({ ...DEFAULT_CONFIG, spamFirstMessages: 1.5 })).toMatch(
      /spamFirstMessages/,
    );
    expect(validateConfig({ ...DEFAULT_CONFIG, spamBan: "on" })).toMatch(/spamBan/);
  });

  it("accepts the disabled default config and enforces config bounds", () => {
    expect(DEFAULT_CONFIG).toEqual({
      language: "cn",
      enabled: false,
      contentId: "default",
      timeoutSeconds: 300,
      cooldownSeconds: 1800,
    });
    expect(validateConfig(DEFAULT_CONFIG)).toBeNull();
    expect(validateConfig(makeConfig({ language: "en" }))).toBeNull();
    expect(validateConfig({ ...makeConfig(), language: "fr" })).toMatch(/language/);
    expect(validateConfig({ ...makeConfig(), enabled: 1 })).toMatch(/enabled/);
    expect(validateConfig(makeConfig({ contentId: "" }))).toMatch(/contentId/);
    expect(validateConfig(makeConfig({ timeoutSeconds: 0 }))).toMatch(/timeoutSeconds/);
    expect(validateConfig(makeConfig({ timeoutSeconds: 86401 }))).toMatch(/timeoutSeconds/);
    expect(validateConfig(makeConfig({ cooldownSeconds: -1 }))).toMatch(/cooldownSeconds/);
    expect(validateConfig(makeConfig({ cooldownSeconds: 604801 }))).toMatch(/cooldownSeconds/);
  });

  it("requires a bilingual bank of 3 to 100 questions with stable unique IDs", () => {
    expect(validateContentPack(makePack())).toBeNull();
    expect(validateContentPack(makePack({ questions: [makeQuestion("one")] }))).toMatch(
      /3 and 100/,
    );
    expect(
      validateContentPack(
        makePack({
          questions: Array.from({ length: 101 }, (_, index) => makeQuestion(`q-${index}`)),
        }),
      ),
    ).toMatch(/3 and 100/);
    expect(
      validateContentPack(
        makePack({
          questions: [makeQuestion("same"), makeQuestion("same"), makeQuestion("third")],
        }),
      ),
    ).toMatch(/unique/);
    const missingEnglish = { ...makeQuestion("en-missing"), translations: {} };
    expect(
      validateContentPack(
        makePack({ questions: [missingEnglish, makeQuestion("second"), makeQuestion("third")] }),
      ),
    ).toMatch(/English translation/);
  });

  it("rejects invalid answer maps, non-four-choice questions, and oversized content", () => {
    const wrongAnswer = { ...makeQuestion("bad"), answerIndex: 4 };
    expect(
      validateContentPack(
        makePack({ questions: [wrongAnswer, makeQuestion("b"), makeQuestion("c")] }),
      ),
    ).toMatch(/answerIndex/);
    const wrongCount = { ...makeQuestion("bad-count"), options: ["A", "B", "C"] };
    expect(
      validateContentPack(
        makePack({ questions: [wrongCount, makeQuestion("b"), makeQuestion("c")] }),
      ),
    ).toMatch(/four unique/);
    const longPrompt = { ...makeQuestion("long"), prompt: "问".repeat(2001) };
    expect(
      validateContentPack(
        makePack({ questions: [longPrompt, makeQuestion("b"), makeQuestion("c")] }),
      ),
    ).toMatch(/prompt/);
    const longRules = { version: "rules-4", cn: "中".repeat(3001), en: "English rules" };
    expect(validateContentPack(makePack({ rules: longRules }))).toMatch(/rules.cn/);
    const longEnglishOption = makeQuestion("long-option");
    longEnglishOption.translations.en.options[0] = "E".repeat(101);
    expect(
      validateContentPack(
        makePack({ questions: [longEnglishOption, makeQuestion("b"), makeQuestion("c")] }),
      ),
    ).toMatch(/translations.en.options/);
  });

  it("validates rules, prompt, choices, title, and guidance as one rendered Telegram message", () => {
    const oversized = makeQuestion("oversized");
    oversized.prompt = "问".repeat(1000);
    oversized.translations.en.prompt = "Question ".repeat(120);
    const rules = { version: "rules-4", cn: "规则。".repeat(500), en: "Rule. ".repeat(500) };
    const error = validateContentPack(
      makePack({ questions: [oversized, makeQuestion("b"), makeQuestion("c")], rules }),
    );
    expect(error).toMatch(/4096-character message limit/);
  });
});

describe("question selection and session snapshots", () => {
  it("selects distinct questions and shuffles options without losing answer mapping", () => {
    const bank = [
      makeQuestion("one"),
      makeQuestion("two"),
      makeQuestion("three"),
      makeQuestion("four"),
    ];
    const selected = selectQuestions(bank, 3, () => 0, "cn");

    expect(selected).toHaveLength(3);
    expect(new Set(selected.map(({ id }) => id)).size).toBe(3);
    for (const snapshot of selected) {
      const original = bank.find(({ id }) => id === snapshot.id)!;
      expect(snapshot.options).not.toBe(original.options);
      expect(snapshot.options[snapshot.answerIndex]).toBe(original.options[original.answerIndex]);
      expect(snapshot.translations).toBeUndefined();
    }
    expect(bank[0].options).toEqual(["正确选项", "干扰选项一", "干扰选项二", "干扰选项三"]);
  });

  it("localizes question and rules snapshots from the configured language", () => {
    const english = makeSession({ config: makeConfig({ language: "en" }) });
    const chinese = makeSession();

    expect(english.language).toBe("en");
    expect(english.questions[0].prompt).toMatch(/^Question /);
    expect(english.questions[0].options[english.questions[0].answerIndex]).toBe("Correct choice");
    expect(english.rules).toEqual({ version: "rules-4", text: "Community rules in English." });
    expect(chinese.questions[0].prompt).toMatch(/^题目 /);
    expect(chinese.rules.text).toBe("社区规则中文版。");
  });

  it("creates a format-v3 session with three snapshots and a frozen rules version", () => {
    const content = makePack();
    const session = makeSession({ content });
    content.rules.cn = "创建后修改的规则。";

    expect(session).toMatchObject({
      key: "group:1:user:2",
      groupId: -1,
      userId: 2,
      status: "active",
      language: "cn",
      index: 0,
      formatVersion: 3,
      contentVersion: "2026-10",
      refreshes: 0,
      expiresAt: NOW + 300_000,
      cooldownSeconds: 1800,
      blockedUntil: 0,
      revision: 0,
      messageId: null,
    });
    expect(session.questions).toHaveLength(3);
    expect(session.rules).toEqual({ version: "rules-4", text: "社区规则中文版。" });
    expect("mistakes" in session).toBe(false);
    expect(() => makeSession({ config: makeConfig({ contentId: "other" }) })).toThrow(/content.id/);
    expect(() => makeSession({ nonce: "contains punctuation!" })).toThrow(/nonce/);
  });
});

describe("answer and refresh state transitions", () => {
  it("ignores forged user, nonce, stale index, and invalid option without mutation", () => {
    const session = makeSession();
    const attempts = [
      { userId: 3, nonce: session.nonce, index: 0, option: 0 },
      { userId: 2, nonce: "forged", index: 0, option: 0 },
      { userId: 2, nonce: session.nonce, index: 1, option: 0 },
      { userId: 2, nonce: session.nonce, index: 0, option: 0.5 },
      { userId: 2, nonce: session.nonce, index: "0", option: 0 },
      { userId: 2, nonce: session.nonce, index: 0, option: 4 },
    ];
    for (const attempt of attempts) {
      expect(answerSession(session, { ...attempt, now: NOW }).kind).toBe("ignored");
    }
    expect(session).toMatchObject({
      status: "active",
      index: 0,
      refreshes: 0,
      expiresAt: NOW + 300_000,
    });
    expect(session.rulesAcceptedAt).toBeUndefined();
  });

  it("declines at the exact deadline without recording a late rules acceptance", () => {
    const session = makeSession();
    const result = answerCurrent(session, session.questions[0].answerIndex, session.expiresAt);
    expect(result).toMatchObject({
      kind: "decision",
      session: {
        status: "decline_pending",
        blockedUntil: session.expiresAt + 1_800_000,
      },
    });
    expect(result.session.rulesAcceptedAt).toBeUndefined();
    expect(session.status).toBe("active");
  });

  it("records rules acceptance with any in-time answer and declines a wrong answer", () => {
    const session = makeSession();
    const wrong = (session.questions[0].answerIndex + 1) % 4;
    const result = answerCurrent(session, wrong, NOW + 5_000);

    expect(result).toMatchObject({
      kind: "decision",
      session: {
        status: "decline_pending",
        index: 0,
        rulesAcceptedAt: NOW + 5_000,
        rulesAcceptedVersion: "rules-4",
        blockedUntil: NOW + 5_000 + 1_800_000,
      },
    });
    expect(session.rulesAcceptedAt).toBeUndefined();
    expect(session.status).toBe("active");
  });

  it.each([0, 1, 2])("approves on one correct answer after %i refreshes", (refreshCount) => {
    const session = skipToIndex(makeSession(), refreshCount);
    const result = answerCurrent(
      session,
      session.questions[session.index].answerIndex,
      NOW + 10_000,
    );

    expect(result).toMatchObject({
      kind: "decision",
      session: {
        status: "approve_pending",
        index: refreshCount,
        refreshes: refreshCount,
        rulesAcceptedAt: NOW + 10_000,
        rulesAcceptedVersion: "rules-4",
      },
    });
  });

  it("lets the applicant skip at most two questions without recording agreement or resetting time", () => {
    const session = makeSession();
    const first = refreshSession(session, {
      userId: 2,
      nonce: session.nonce,
      index: 0,
      now: NOW + 1000,
    });
    expect(first).toMatchObject({ kind: "question", session: { index: 1, refreshes: 1 } });
    expect(first.session.expiresAt).toBe(session.expiresAt);
    expect(first.session.rulesAcceptedAt).toBeUndefined();
    expect(
      refreshSession(first.session, { userId: 2, nonce: session.nonce, index: 0, now: NOW + 1000 }),
    ).toMatchObject({ kind: "ignored", reason: "stale_index" });

    const second = refreshSession(first.session, {
      userId: 2,
      nonce: session.nonce,
      index: 1,
      now: NOW + 2000,
    });
    expect(second).toMatchObject({
      kind: "question",
      session: { index: 2, refreshes: MAX_REFRESHES },
    });
    expect(
      refreshSession(second.session, {
        userId: 2,
        nonce: session.nonce,
        index: 2,
        now: NOW + 3000,
      }),
    ).toMatchObject({ kind: "ignored", reason: "refresh_limit" });
    expect(second.session.expiresAt).toBe(session.expiresAt);
    expect(second.session.rulesAcceptedAt).toBeUndefined();
  });
});

describe("callbacks, Telegram rendering, and translations", () => {
  it("round-trips answer and refresh callbacks within Telegram's 64-byte limit", () => {
    const session = { nonce: "a".repeat(24), index: 2 };
    const answer = callbackData(session, 3);
    const refresh = refreshCallbackData(session);
    for (const data of [answer, refresh]) {
      expect(data).toEqual(expect.any(String));
      expect(data!.length).toBeLessThanOrEqual(64);
    }
    expect(parseCallbackData(answer)).toEqual({
      kind: "answer",
      nonce: session.nonce,
      index: 2,
      option: 3,
    });
    expect(parseCallbackData(refresh)).toEqual({
      kind: "refresh",
      nonce: session.nonce,
      index: 2,
    });
  });

  it("rejects malformed, obsolete-consent, unsafe, and oversized callback payloads", () => {
    expect(parseCallbackData("q:bad_nonce:1:2")).toBeNull();
    expect(parseCallbackData("f:abc:1:2")).toBeNull();
    expect(parseCallbackData("c:abc:1:1")).toBeNull();
    expect(parseCallbackData("q:abc:1:4")).toBeNull();
    expect(parseCallbackData(`q:abc:${"9".repeat(70)}:0`)).toBeNull();
    expect(
      callbackData({ nonce: "a".repeat(24), index: Number.MAX_SAFE_INTEGER + 1 }, 3),
    ).toBeNull();
  });

  it("renders complete rules and choices with consent wording on every answer button", () => {
    const session = makeSession();
    const rendered = renderQuestion(session);
    const buttons = rendered.reply_markup.inline_keyboard.flat();
    const answerButtons = buttons.filter(
      ({ callback_data }) => parseCallbackData(callback_data)?.kind === "answer",
    );
    const refreshButton = buttons.find(
      ({ callback_data }) => parseCallbackData(callback_data)?.kind === "refresh",
    );

    expect(rendered.text).toContain(session.rules.text);
    expect(rendered.text).toContain(session.rules.version);
    expect(rendered.text).toContain(session.questions[0].prompt);
    expect(rendered.text).toContain("验证题（候选 1/3）");
    expect(rendered.text).toContain("A. ");
    expect(rendered.text).toContain("D. ");
    expect(rendered.text).toContain("答对一题即可入群");
    expect(rendered.text).toContain("答错将拒绝申请");
    expect(rendered.text).toContain("换题不代表同意");
    expect(rendered.text).toContain(new Date(session.expiresAt).toISOString());
    expect(rendered.text.length).toBeLessThanOrEqual(4096);
    expect(rendered.text).not.toContain("answerIndex");
    expect(answerButtons).toHaveLength(4);
    expect(answerButtons.map(({ text }) => text)).toEqual([
      "同意群规并选择 A",
      "同意群规并选择 B",
      "同意群规并选择 C",
      "同意群规并选择 D",
    ]);
    expect(parseCallbackData(refreshButton!.callback_data)?.kind).toBe("refresh");
    expect(refreshButton!.text).toContain("2");

    const lastQuestion = { ...session, index: 2, refreshes: 2 };
    const lastButtons = renderQuestion(lastQuestion).reply_markup.inline_keyboard.flat();
    expect(
      lastButtons.some(({ callback_data }) => parseCallbackData(callback_data)?.kind === "refresh"),
    ).toBe(false);
  });

  it("rejects runtime text that exceeds 4096 rather than truncating the rules", () => {
    const session = makeSession({ title: "组".repeat(4000) });
    expect(() => renderQuestion(session)).toThrow(/4096-character message limit/);
  });

  it("detects language variants and interpolates both language templates", () => {
    expect(detectLanguage("en-US")).toBe("en");
    expect(detectLanguage("EN_gb")).toBe("en");
    expect(detectLanguage("zh-CN")).toBe("cn");
    expect(detectLanguage()).toBe("cn");
    expect(t("en", "cooldown", { seconds: 30 })).toContain("30 seconds");
    expect(t("cn", "cooldown", { seconds: 30 })).toContain("30 秒");
    expect(t("en", "answerButton", { letter: "A" })).toContain("Agree to rules");
    expect(t("cn", "answerButton", { letter: "A" })).toBe("同意群规并选择 A");
    expect(
      t("en", "question", {
        title: "Join check",
        version: "v1",
        current: 1,
        total: 3,
        prompt: "Choose",
        choices: "A. Yes",
        rules: "Rules",
        deadline: "2026-01-01T00:00:00.000Z",
      }),
    ).toContain("candidate 1/3");
  });
});
