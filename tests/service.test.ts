import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type {
  BlocklistDocument,
  BotApi,
  CallbackQuery,
  Config,
  ContentPack,
  Context,
  JoinRequest,
  Message,
  Repository,
  Session,
} from "../src/types.js";

import { createRepository } from "../src/lib/repository.js";
import { createService } from "../src/lib/service.js";
import { callbackData, refreshCallbackData } from "../src/lib/quiz.js";
import { compileBlocklist, type SpamSettings } from "../src/lib/spam.js";

type ServiceCall =
  | { method: "sendMessage"; args: Parameters<BotApi["sendMessage"]>[0] }
  | { method: "editMessageText"; args: Parameters<BotApi["editMessageText"]>[0] }
  | { method: "answerCallbackQuery"; args: Parameters<BotApi["answerCallbackQuery"]>[0] }
  | { method: "approveChatJoinRequest"; args: Parameters<BotApi["approveChatJoinRequest"]>[0] }
  | { method: "declineChatJoinRequest"; args: Parameters<BotApi["declineChatJoinRequest"]>[0] }
  | {
      method: "answerChatJoinRequestQuery";
      args: Parameters<BotApi["answerChatJoinRequestQuery"]>[0];
    }
  | { method: "deleteMessage"; args: Parameters<BotApi["deleteMessage"]>[0] }
  | { method: "banChatMember"; args: Parameters<BotApi["banChatMember"]>[0] }
  | { method: "banChatSenderChat"; args: Parameters<BotApi["banChatSenderChat"]>[0] }
  | { method: "getChatMember"; args: Parameters<BotApi["getChatMember"]>[0] };

interface TestContext {
  api: BotApi;
  calls: ServiceCall[];
  repository: Repository;
  service: ReturnType<typeof createService>;
  setNow(value: number): void;
  close(): void;
}

interface ApiFailure extends Error {
  code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

const closeDatabases: Array<() => void> = [];
const initialNow = Date.UTC(2026, 9, 11, 0, 0, 0);
const testContent: ContentPack = {
  id: "test-content",
  version: "test-content-v1",
  questions: [
    {
      id: "test-q1",
      prompt: "测试题目一",
      options: ["正确选项", "错误选项一", "错误选项二", "错误选项三"],
      answerIndex: 0,
      translations: {
        en: {
          prompt: "English prompt 1",
          options: ["Correct 1", "Wrong 1A", "Wrong 1B", "Wrong 1C"],
        },
      },
    },
    {
      id: "test-q2",
      prompt: "测试题目二",
      options: ["正确选项", "错误选项一", "错误选项二", "错误选项三"],
      answerIndex: 0,
      translations: {
        en: {
          prompt: "English prompt 2",
          options: ["Correct 2", "Wrong 2A", "Wrong 2B", "Wrong 2C"],
        },
      },
    },
    {
      id: "test-q3",
      prompt: "测试题目三",
      options: ["正确选项", "错误选项一", "错误选项二", "错误选项三"],
      answerIndex: 0,
      translations: {
        en: {
          prompt: "English prompt 3",
          options: ["Correct 3", "Wrong 3A", "Wrong 3B", "Wrong 3C"],
        },
      },
    },
  ],
  rules: {
    version: "test-rules-v1",
    cn: "测试专用中文规则，请勿用于真实群组。",
    en: "Test-only English rules. Do not use in a real group.",
  },
};

const config: Config = {
  language: "en",
  enabled: true,
  contentId: testContent.id,
  timeoutSeconds: 300,
  cooldownSeconds: 60,
};

function localizedConfig(language: Config["language"]): Config {
  return { ...config, language };
}

function apiFailure(message: string, fields: Omit<ApiFailure, keyof Error> = {}): ApiFailure {
  return Object.assign(new Error(message), fields);
}

function setup({
  apiOverrides = {},
  defaultDeleteJoinMessages,
  blocklist,
  casCheck = async () => false,
  spamDefaults,
}: {
  apiOverrides?: Partial<BotApi>;
  defaultDeleteJoinMessages?: boolean;
  blocklist?: BlocklistDocument;
  casCheck?: (userId: number) => Promise<boolean>;
  spamDefaults?: SpamSettings;
} = {}): TestContext {
  const sqlite = new DatabaseSync(":memory:");
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      sqlite.close();
    }
  };
  closeDatabases.push(close);
  sqlite.exec(`
    CREATE TABLE groups (
      group_id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE sessions (
      key TEXT PRIMARY KEY,
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      effect_lease_until INTEGER,
      cleanup_lease_until INTEGER,
      cleanup_retry_at INTEGER,
      message_id INTEGER,
      message_deleted_at INTEGER,
      request_date INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX idx_sessions_group_id ON sessions(group_id);
    CREATE INDEX idx_sessions_user_id ON sessions(user_id);
    CREATE TABLE packs (
      id TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE rules (
      id TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE questions (
      type TEXT NOT NULL,
      id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (type, id)
    );
    CREATE TABLE blocklists (
      id TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE members (
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      messages INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );
  `);
  const database = drizzle(
    async (query: string, params: SQLInputValue[], method: "run" | "all" | "values" | "get") => {
      const statement = sqlite.prepare(query);
      if (method === "run") {
        statement.run(...params);
        return { rows: [] };
      }
      if (method === "get") {
        const row = statement.get(...params);
        return { rows: row ? Object.values(row) : [] };
      }
      return { rows: statement.all(...params).map((row) => Object.values(row)) };
    },
  );
  sqlite.prepare("INSERT INTO packs (id, payload, updated_at) VALUES (?, ?, 0)").run(
    testContent.id,
    JSON.stringify({
      id: testContent.id,
      version: testContent.version,
      rules: "test-rules",
      questionTypes: ["fixture"],
    }),
  );
  sqlite
    .prepare("INSERT INTO rules (id, payload, updated_at) VALUES (?, ?, 0)")
    .run("test-rules", JSON.stringify(testContent.rules));
  const seedQuestion = sqlite.prepare(
    "INSERT INTO questions (type, id, payload, updated_at) VALUES (?, ?, ?, 0)",
  );
  for (const question of testContent.questions) {
    seedQuestion.run("fixture", question.id, JSON.stringify(question));
  }
  const calls: ServiceCall[] = [];
  let nextMessageId = 1000;
  const api: BotApi = {
    async sendMessage(args) {
      calls.push({ method: "sendMessage", args });
      return {
        message_id: nextMessageId++,
        chat: { id: args.chat_id, type: "private" },
      };
    },
    async editMessageText(args) {
      calls.push({ method: "editMessageText", args });
      return true;
    },
    async answerCallbackQuery(args) {
      calls.push({ method: "answerCallbackQuery", args });
      return true;
    },
    async approveChatJoinRequest(args) {
      calls.push({ method: "approveChatJoinRequest", args });
      return true;
    },
    async declineChatJoinRequest(args) {
      calls.push({ method: "declineChatJoinRequest", args });
      return true;
    },
    async answerChatJoinRequestQuery(args) {
      calls.push({ method: "answerChatJoinRequestQuery", args });
      return true;
    },
    async deleteMessage(args) {
      calls.push({ method: "deleteMessage", args });
      return true;
    },
    async createChatInviteLink() {
      return { invite_link: "https://t.me/+test" };
    },
    async getMe() {
      return { id: 1 };
    },
    async getChat({ chat_id }) {
      return { id: chat_id, type: "private" };
    },
    async getChatMember(args) {
      calls.push({ method: "getChatMember", args });
      return { status: "member" };
    },
    async banChatMember(args) {
      calls.push({ method: "banChatMember", args });
      return true;
    },
    async banChatSenderChat(args) {
      calls.push({ method: "banChatSenderChat", args });
      return true;
    },
    ...apiOverrides,
  };
  const repository = createRepository(database);
  let clock = initialNow;
  const service = createService({
    api,
    repository,
    now: () => clock,
    random: () => 0.25,
    defaultDeleteJoinMessages,
    blocklist: async () => (blocklist ? compileBlocklist(blocklist) : null),
    casCheck,
    spamDefaults,
  });
  return {
    api,
    calls,
    repository,
    service,
    setNow(value: number) {
      clock = value;
    },
    close,
  };
}

function joinRequest({
  groupId = -100,
  userId = 42,
  chatId = userId,
  date = initialNow,
}: { groupId?: number; userId?: number; chatId?: number; date?: number } = {}): JoinRequest {
  return {
    chat: { id: groupId, type: "supergroup", title: `Group ${groupId}` },
    from: { id: userId },
    user_chat_id: chatId,
    date: Math.floor(date / 1000),
  };
}

function privateMessage(userId: number, chatId = userId, text = "/start"): Message {
  return { message_id: 1, chat: { id: chatId, type: "private" }, from: { id: userId }, text };
}

function update(updateId: number): Context {
  return { update: { update_id: updateId } };
}

async function requiredSession(repository: Repository, key: string): Promise<Session> {
  const session = await repository.getSession(key);
  if (!session) throw new Error(`Missing test session ${key}`);
  return session;
}

function requiredMessageId(session: Session): number {
  if (session.messageId === null) throw new Error("Test session has no validation message");
  return session.messageId;
}

function answerData(
  session: Session,
  option = session.questions[session.index].answerIndex,
): string {
  const data = callbackData(session, option);
  if (!data) throw new Error("Test answer callback data is invalid");
  return data;
}

function refreshData(session: Session): string {
  const data = refreshCallbackData(session);
  if (!data) throw new Error("Test refresh callback data is invalid");
  return data;
}

function requiredCall<T>(call: T | undefined): T {
  if (!call) throw new Error("Expected test API call was not recorded");
  return call;
}

function requiredNumber(value: number | undefined): number {
  if (value === undefined) throw new Error("Expected test timestamp was not recorded");
  return value;
}

async function sendAnswer({
  service,
  repository,
  userId,
  key,
  option,
}: {
  service: TestContext["service"];
  repository: Repository;
  userId: number;
  key: string;
  option?: number;
}): Promise<void> {
  const session = await requiredSession(repository, key);
  const data = answerData(session, option);
  await service.callback({
    id: `callback-${session.index}-${Math.random()}`,
    from: { id: userId },
    data,
    message: {
      message_id: requiredMessageId(session),
      chat: { id: session.userChatId, type: "private" },
    },
  });
}

async function sendRefresh({
  service,
  repository,
  userId,
  key,
}: {
  service: TestContext["service"];
  repository: Repository;
  userId: number;
  key: string;
}): Promise<void> {
  const session = await requiredSession(repository, key);
  await service.callback({
    id: `refresh-${Math.random()}`,
    from: { id: userId },
    data: refreshData(session),
    message: {
      message_id: requiredMessageId(session),
      chat: { id: session.userChatId, type: "private" },
    },
  });
}

function callbackQuery(
  session: Session,
  data: string,
  id = "callback",
  userId = session.userId,
): CallbackQuery {
  return {
    id,
    from: { id: userId },
    data,
    message: {
      message_id: requiredMessageId(session),
      chat: { id: session.userChatId, type: "private" },
    },
  };
}

async function finishQuestions(ctx: TestContext, key = "-100:42"): Promise<Session> {
  for (let index = 0; index < 3; index += 1) {
    const session = await requiredSession(ctx.repository, key);
    if (session.status !== "active") break;
    await sendAnswer({ ...ctx, userId: session.userId, key });
  }
  return requiredSession(ctx.repository, key);
}

afterEach(() => {
  for (const close of closeDatabases.splice(0)) close();
  vi.restoreAllMocks();
});

describe("join verification service", () => {
  it("shows rules with the question and approves on the first correct answer that consents", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));

      await sendAnswer({ ...ctx, userId: 42, key: "-100:42" });

      const approved = await requiredSession(ctx.repository, "-100:42");
      expect(approved.status).toBe("approved");
      expect(approved.rulesAcceptedAt).toBe(initialNow);
      expect(approved.rulesAcceptedVersion).toBe(testContent.rules.version);
      expect(ctx.calls.filter((call) => call.method === "approveChatJoinRequest")).toHaveLength(1);
      expect(ctx.calls.filter((call) => call.method === "answerCallbackQuery")).toHaveLength(1);
      expect(ctx.calls.filter((call) => call.method === "sendMessage")[0].args.text).toContain(
        testContent.rules.en,
      );
      expect(
        ctx.calls
          .filter((call) => call.method === "sendMessage")[0]
          .args.reply_markup!.inline_keyboard.flat()
          .some((button) => button.text.includes("Agree to rules")),
      ).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("renders and settles English and Chinese sessions in the configured language", async () => {
    for (const language of ["en", "cn"] as const) {
      const ctx = setup();
      try {
        await ctx.repository.saveConfig(-100, localizedConfig(language));
        await ctx.service.join(joinRequest(), update(1));
        const active = await requiredSession(ctx.repository, "-100:42");
        expect(active.language).toBe(language);
        expect(
          requiredCall(ctx.calls.find((call) => call.method === "sendMessage")).args.text,
        ).toContain(language === "en" ? "English prompt" : "测试题目");

        const firstMessage = ctx.calls.filter((call) => call.method === "sendMessage")[0].args.text;
        expect(firstMessage).toContain(
          language === "en" ? testContent.rules.en : testContent.rules.cn,
        );
        expect(firstMessage).toContain(language === "en" ? "English prompt" : "测试题目");
        const final = await finishQuestions(ctx);
        expect(final.status).toBe("approved");
        const finalMessage = requiredCall(
          ctx.calls.filter((call) => call.method === "editMessageText").at(-1),
        ).args.text;
        expect(finalMessage).toContain(
          language === "en" ? "Your join request has been approved." : "入群申请已通过。",
        );
      } finally {
        ctx.close();
      }
    }
  });

  it.each([0, 1, 2])(
    "allows %i refreshes without consent, then approves on one correct answer",
    async (count) => {
      const ctx = setup();
      try {
        await ctx.repository.saveConfig(-100, config);
        await ctx.service.join(joinRequest(), update(1));
        const original = await requiredSession(ctx.repository, "-100:42");
        const oldQuestion = answerData(original);
        const deadline = original.expiresAt;
        const initialText = ctx.calls.filter((call) => call.method === "sendMessage")[0].args.text;
        expect(initialText).toContain(testContent.rules.en);

        for (let index = 0; index < count; index += 1) {
          await sendRefresh({ ...ctx, userId: 42, key: "-100:42" });
          const current = await requiredSession(ctx.repository, "-100:42");
          expect(current.refreshes).toBe(index + 1);
          expect(current.index).toBe(index + 1);
          expect(current.rulesAcceptedAt).toBeUndefined();
          expect(current.rulesAcceptedVersion).toBeUndefined();
          if (index === 0) {
            await ctx.service.callback(callbackQuery(current, oldQuestion, "old-question"));
            expect((await requiredSession(ctx.repository, "-100:42")).index).toBe(1);
          }
        }
        const current = await requiredSession(ctx.repository, "-100:42");
        expect(current.expiresAt).toBe(deadline);

        await sendAnswer({ ...ctx, userId: 42, key: "-100:42" });
        const approved = await requiredSession(ctx.repository, "-100:42");
        expect(approved.status).toBe("approved");
        expect(approved.rulesAcceptedAt).toBe(initialNow);
        expect(approved.rulesAcceptedVersion).toBe(testContent.rules.version);
      } finally {
        ctx.close();
      }
    },
  );

  it("declines a wrong answer after recording the explicit rules consent", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      const before = await requiredSession(ctx.repository, "-100:42");
      const wrongOption = before.questions[before.index].answerIndex === 0 ? 1 : 0;
      await sendAnswer({ ...ctx, userId: 42, key: "-100:42", option: wrongOption });
      const declined = await requiredSession(ctx.repository, "-100:42");
      expect(declined.status).toBe("declined");
      expect(declined.rulesAcceptedAt).toBe(initialNow);
      expect(declined.rulesAcceptedVersion).toBe(testContent.rules.version);
      expect(ctx.calls.filter((call) => call.method === "approveChatJoinRequest")).toHaveLength(0);
      expect(ctx.calls.filter((call) => call.method === "declineChatJoinRequest")).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("resumes the combined rules and question page through /start", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      await ctx.service.start(privateMessage(42));
      const session = await requiredSession(ctx.repository, "-100:42");
      const lastMessage = requiredCall(
        ctx.calls.filter((call) => call.method === "editMessageText").at(-1),
      );
      expect(session.status).toBe("active");
      expect(lastMessage.args.text).toContain(testContent.rules.en);
      expect(lastMessage.args.text).toContain("English prompt");
    } finally {
      ctx.close();
    }
  });

  it("does not accept an answer after the request expires", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      ctx.setNow(initialNow + config.timeoutSeconds * 1000);
      await sendAnswer({ ...ctx, userId: 42, key: "-100:42" });

      expect((await requiredSession(ctx.repository, "-100:42")).status).toBe("declined");
      expect(ctx.calls.filter((call) => call.method === "approveChatJoinRequest")).toHaveLength(0);
      expect(ctx.calls.filter((call) => call.method === "declineChatJoinRequest")).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("races an answer and refresh safely without accepting stale callback state", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      const first = await requiredSession(ctx.repository, "-100:42");
      await Promise.all([
        ctx.service.callback(callbackQuery(first, answerData(first), "answer")),
        ctx.service.callback(callbackQuery(first, refreshData(first), "refresh")),
      ]);
      let current = await requiredSession(ctx.repository, "-100:42");
      expect(["active", "approved"]).toContain(current.status);
      expect([0, 1]).toContain(current.refreshes);
      if (current.status === "active") {
        expect(current.rulesAcceptedAt).toBeUndefined();
        await sendAnswer({ ...ctx, userId: 42, key: "-100:42" });
        current = await requiredSession(ctx.repository, "-100:42");
      }
      expect(current.status).toBe("approved");
      expect(ctx.calls.filter((call) => call.method === "approveChatJoinRequest")).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("declines legacy pending approvals that have no matching rules-consent record", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      const waiting = await requiredSession(ctx.repository, "-100:42");
      const legacyPending = {
        ...waiting,
        formatVersion: 2,
        status: "approve_pending",
        rulesAcceptedAt: undefined,
        rulesAcceptedVersion: undefined,
      } as unknown as Session;
      expect(await ctx.repository.casSession(waiting, legacyPending)).toBe(true);

      await ctx.service.start(privateMessage(42));
      expect((await requiredSession(ctx.repository, "-100:42")).status).toBe("declined");
      expect(ctx.calls.filter((call) => call.method === "approveChatJoinRequest")).toHaveLength(0);
      expect(ctx.calls.filter((call) => call.method === "declineChatJoinRequest")).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("deduplicates concurrent join replay and duplicate correct-answer callbacks", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      const request = joinRequest();
      await Promise.all([
        ctx.service.join(request, update(200)),
        ctx.service.join(request, update(200)),
      ]);
      expect(ctx.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);

      const session = await requiredSession(ctx.repository, "-100:42");
      const correctAnswer = answerData(session);
      await Promise.all([
        ctx.service.callback(callbackQuery(session, correctAnswer, "duplicate-1")),
        ctx.service.callback(callbackQuery(session, correctAnswer, "duplicate-2")),
      ]);

      expect((await requiredSession(ctx.repository, "-100:42")).status).toBe("approved");
      expect(ctx.calls.filter((call) => call.method === "approveChatJoinRequest")).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("completes an external decision if only notification metadata races with its lease", async () => {
    let releaseApproval: (() => void) | undefined;
    let markApprovalStarted: (() => void) | undefined;
    let approvalAttempts = 0;
    let failNextEdit = false;
    const approvalStarted = new Promise<void>((resolve) => {
      markApprovalStarted = resolve;
    });
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const ctx = setup({
      apiOverrides: {
        async approveChatJoinRequest(args) {
          approvalAttempts += 1;
          ctx?.calls.push({ method: "approveChatJoinRequest", args });
          if (approvalAttempts === 1) {
            markApprovalStarted?.();
            await approvalGate;
          }
          return true;
        },
        async editMessageText(args) {
          if (failNextEdit) {
            failNextEdit = false;
            throw apiFailure("Bad Request: message can't be edited", {
              code: 400,
              description: "Bad Request: message can't be edited",
            });
          }
          ctx?.calls.push({ method: "editMessageText", args });
          return true;
        },
      },
    });
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      const session = await requiredSession(ctx.repository, "-100:42");
      const finalCallback = {
        id: "final-in-flight",
        from: { id: 42 },
        data: answerData(session),
        message: {
          message_id: requiredMessageId(session),
          chat: { id: 42, type: "private" },
        },
      };

      const first = ctx.service.callback(finalCallback);
      await approvalStarted;
      failNextEdit = true;
      await ctx.service.callback({ ...finalCallback, id: "duplicate-in-flight" });
      releaseApproval?.();
      await first;

      const settled = await requiredSession(ctx.repository, "-100:42");
      expect(settled.status).toBe("approved");
      expect(approvalAttempts).toBe(1);
    } finally {
      releaseApproval?.();
      ctx.close();
    }
  });

  it("declines a wrong answer and rejects a rejoin until cooldown expires", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      const before = await requiredSession(ctx.repository, "-100:42");
      const wrongOption = before.questions[before.index].answerIndex === 0 ? 1 : 0;
      await sendAnswer({ ...ctx, userId: 42, key: "-100:42", option: wrongOption });
      const first = await requiredSession(ctx.repository, "-100:42");
      expect(first.status).toBe("declined");
      expect(first.blockedUntil).toBe(initialNow + config.cooldownSeconds * 1000);

      await ctx.service.join(joinRequest({ date: initialNow + 1000 }), update(2));
      const retried = await requiredSession(ctx.repository, "-100:42");
      expect(retried.status).toBe("declined");
      expect(retried.blockedUntil).toBe(first.blockedUntil);
      expect(retried.requestId).toBe("2");
      expect(ctx.calls.filter((call) => call.method === "declineChatJoinRequest")).toHaveLength(2);
    } finally {
      ctx.close();
    }
  });

  it("shows the remaining cooldown when /start recovers a declined session", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      const before = await requiredSession(ctx.repository, "-100:42");
      const wrongOption = before.questions[before.index].answerIndex === 0 ? 1 : 0;
      await sendAnswer({ ...ctx, userId: 42, key: "-100:42", option: wrongOption });

      await ctx.service.start(privateMessage(42));
      const latestEdit = requiredCall(
        ctx.calls.filter((call) => call.method === "editMessageText").at(-1),
      );
      expect(latestEdit.args.text).toContain("You can try again in 60 seconds.");
    } finally {
      ctx.close();
    }
  });

  it("queues Bot API join-query requests without creating a quiz session", async () => {
    const ctx = setup();
    try {
      await ctx.service.join({ ...joinRequest(), query_id: "query-123" }, update(1));
      expect(ctx.calls).toEqual([
        {
          method: "answerChatJoinRequestQuery",
          args: { chat_join_request_query_id: "query-123", result: "queue" },
        },
      ]);
      expect(await ctx.repository.getSession("-100:42")).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("rejects a rejoin submitted during cooldown even if the webhook arrives later", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      const before = await requiredSession(ctx.repository, "-100:42");
      const wrongOption = before.questions[before.index].answerIndex === 0 ? 1 : 0;
      await sendAnswer({ ...ctx, userId: 42, key: "-100:42", option: wrongOption });
      const declined = await requiredSession(ctx.repository, "-100:42");

      ctx.setNow(initialNow + 100_000);
      await ctx.service.join(joinRequest({ date: initialNow + 30_000 }), update(2));
      const lateDelivery = await requiredSession(ctx.repository, "-100:42");
      expect(lateDelivery.status).toBe("declined");
      expect(lateDelivery.blockedUntil).toBe(declined.blockedUntil);
    } finally {
      ctx.close();
    }
  });

  it("ignores a callback from another user", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      const before = await requiredSession(ctx.repository, "-100:42");
      await ctx.service.callback({
        id: "forged",
        from: { id: 99 },
        data: answerData(before, before.questions[0].answerIndex),
        message: {
          message_id: requiredMessageId(before),
          chat: { id: 42, type: "private" },
        },
      });

      expect(await requiredSession(ctx.repository, "-100:42")).toEqual(before);
      expect(
        requiredCall(ctx.calls.filter((call) => call.method === "answerCallbackQuery").at(-1)).args
          .text,
      ).toContain("已更新");
      expect(ctx.calls.filter((call) => call.method === "approveChatJoinRequest")).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });

  it("does not create a session when no enabled config exists", async () => {
    const ctx = setup();
    try {
      await ctx.service.join(joinRequest(), update(1));
      expect(await ctx.repository.getSession("-100:42")).toBeNull();
      expect(ctx.calls).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });

  it("declines an expired session when /start recovers it", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      ctx.setNow(initialNow + (config.timeoutSeconds + 1) * 1000);
      await ctx.service.start(privateMessage(42));

      const session = await requiredSession(ctx.repository, "-100:42");
      expect(session.status).toBe("declined");
      expect(session.blockedUntil).toBe(ctxTime(initialNow, config));
      expect(ctx.calls.filter((call) => call.method === "declineChatJoinRequest")).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("expires without a callback, deletes the validation message, and does not restore the quiz", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      const original = await requiredSession(ctx.repository, "-100:42");
      ctx.setNow(original.expiresAt);

      await ctx.service.maintenance();

      const expired = await requiredSession(ctx.repository, "-100:42");
      expect(expired.status).toBe("declined");
      expect(expired.messageDeletedAt).toBe(original.expiresAt);
      expect(expired.messageId).toBe(original.messageId);
      expect(ctx.calls.filter((call) => call.method === "declineChatJoinRequest")).toHaveLength(1);
      expect(ctx.calls.filter((call) => call.method === "deleteMessage")).toEqual([
        {
          method: "deleteMessage",
          args: { chat_id: original.userChatId, message_id: original.messageId },
        },
      ]);

      await ctx.service.start(privateMessage(42));
      const afterStart = await requiredSession(ctx.repository, "-100:42");
      const statusMessage = requiredCall(
        ctx.calls.filter((call) => call.method === "sendMessage").at(-1),
      );
      expect(statusMessage.args.text).toContain("You can try again in 60 seconds.");
      expect(statusMessage.args.text).not.toContain("English prompt");
      expect(afterStart.messageId).toBe(original.messageId);
      expect(afterStart.messageDeletedAt).toBe(original.expiresAt);
    } finally {
      ctx.close();
    }
  });

  it("retries an expired approval intent after its existing lease through maintenance", async () => {
    let attempts = 0;
    const ctx = setup({
      apiOverrides: {
        async approveChatJoinRequest(args) {
          attempts += 1;
          ctx?.calls.push({ method: "approveChatJoinRequest", args });
          if (attempts === 1) {
            throw apiFailure("temporary approval failure", { code: 500 });
          }
          return true;
        },
      },
    });
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      await expect(finishQuestions(ctx)).rejects.toThrow("temporary approval failure");
      const pendingApproval = await requiredSession(ctx.repository, "-100:42");
      expect(pendingApproval.status).toBe("approve_pending");
      expect(pendingApproval.rulesAcceptedAt).toBe(initialNow);

      ctx.setNow(requiredNumber(pendingApproval.effectLeaseUntil));
      await ctx.service.maintenance();

      expect((await requiredSession(ctx.repository, "-100:42")).status).toBe("approved");
      expect(attempts).toBe(2);
    } finally {
      ctx.close();
    }
  });

  it("retries a due decline intent through maintenance", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      const active = await requiredSession(ctx.repository, "-100:42");
      expect(
        await ctx.repository.casSession(active, {
          ...active,
          status: "decline_pending",
          effectLeaseUntil: initialNow,
        }),
      ).toBe(true);

      await ctx.service.maintenance();

      expect((await requiredSession(ctx.repository, "-100:42")).status).toBe("declined");
      expect(ctx.calls.filter((call) => call.method === "declineChatJoinRequest")).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("waits for a pending lease, then deletes an expired prompt even when decline fails", async () => {
    let ctx: TestContext | undefined;
    let declines = 0;
    ctx = setup({
      apiOverrides: {
        async declineChatJoinRequest(args) {
          declines += 1;
          ctx?.calls.push({ method: "declineChatJoinRequest", args });
          throw apiFailure("temporary decline failure", { code: 500 });
        },
      },
    });
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      const active = await requiredSession(ctx.repository, "-100:42");
      const effectLeaseUntil = active.expiresAt + 30_000;
      expect(
        await ctx.repository.casSession(active, {
          ...active,
          status: "decline_pending",
          effectLeaseUntil,
        }),
      ).toBe(true);

      ctx.setNow(active.expiresAt);
      await ctx.service.maintenance();
      let pendingSession = await requiredSession(ctx.repository, "-100:42");
      expect(pendingSession.status).toBe("decline_pending");
      expect(pendingSession.messageDeletedAt).toBeUndefined();
      expect(ctx.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(0);
      expect(declines).toBe(0);

      ctx.setNow(effectLeaseUntil);
      await ctx.service.maintenance();

      pendingSession = await requiredSession(ctx.repository, "-100:42");
      expect(pendingSession.status).toBe("decline_pending");
      expect(pendingSession.messageDeletedAt).toBe(effectLeaseUntil);
      expect(pendingSession.effectLeaseUntil).toBe(effectLeaseUntil + 5000);
      expect(ctx.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(1);
      expect(declines).toBe(1);
    } finally {
      ctx.close();
    }
  });

  it("isolates maintenance item failures and does not log error secrets", async () => {
    let ctx: TestContext | undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ctx = setup({
      apiOverrides: {
        async declineChatJoinRequest(args) {
          ctx?.calls.push({ method: "declineChatJoinRequest", args });
          if (args.chat_id === -100) {
            throw apiFailure("private credential do-not-log", {
              code: 500,
              description: "private credential do-not-log",
            });
          }
          return true;
        },
      },
    });
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.repository.saveConfig(-200, config);
      await ctx.service.join(joinRequest({ groupId: -100 }), update(1));
      await ctx.service.join(joinRequest({ groupId: -200 }), update(2));
      ctx.setNow(initialNow + config.timeoutSeconds * 1000);

      await ctx.service.maintenance();

      expect((await requiredSession(ctx.repository, "-100:42")).status).toBe("decline_pending");
      expect((await requiredSession(ctx.repository, "-200:42")).status).toBe("declined");
      expect(
        ctx.calls
          .filter((call) => call.method === "declineChatJoinRequest")
          .map((call) => call.args.chat_id),
      ).toEqual(expect.arrayContaining([-100, -200]));
      expect(JSON.stringify(warn.mock.calls)).not.toContain("do-not-log");
    } finally {
      ctx.close();
    }
  });

  it("honors delete retry_after and treats only an already-missing message as idempotent", async () => {
    let attempts = 0;
    const ctx = setup({
      apiOverrides: {
        async deleteMessage(args) {
          attempts += 1;
          ctx?.calls.push({ method: "deleteMessage", args });
          if (attempts === 1) {
            throw apiFailure("rate limited", {
              code: 429,
              parameters: { retry_after: 7 },
            });
          }
          throw apiFailure("already removed", {
            code: 400,
            description: "Bad Request: message to delete not found",
          });
        },
      },
    });
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      const active = await requiredSession(ctx.repository, "-100:42");
      await finishQuestions(ctx);
      ctx.setNow(active.expiresAt);

      await ctx.service.maintenance();
      let session = await requiredSession(ctx.repository, "-100:42");
      expect(session.cleanupRetryAt).toBe(active.expiresAt + 7000);
      expect(session.cleanupLeaseUntil).toBe(0);
      expect(session.messageDeletedAt).toBeUndefined();
      await ctx.service.maintenance();
      expect(attempts).toBe(1);

      ctx.setNow(requiredNumber(session.cleanupRetryAt));
      await ctx.service.maintenance();
      session = await requiredSession(ctx.repository, "-100:42");
      expect(session.messageDeletedAt).toBe(active.expiresAt + 7000);
      expect(attempts).toBe(2);
    } finally {
      ctx.close();
    }
  });

  it("does not delete a replacement session message from a stale maintenance snapshot", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      await finishQuestions(ctx);
      const original = await requiredSession(ctx.repository, "-100:42");
      ctx.setNow(original.expiresAt);
      const listActionable = ctx.repository.listActionableSessions.bind(ctx.repository);
      let replaced = false;
      ctx.repository.listActionableSessions = async (at, limit) => {
        const candidates = await listActionable(at, limit);
        if (!replaced) {
          const current = await requiredSession(ctx.repository, "-100:42");
          await ctx.repository.casSession(current, {
            ...current,
            nonce: "replacement-session",
            messageId: 9001,
          });
          replaced = true;
        }
        return candidates;
      };

      await ctx.service.maintenance();

      const replacement = await requiredSession(ctx.repository, "-100:42");
      expect(replacement.nonce).toBe("replacement-session");
      expect(replacement.messageId).toBe(9001);
      expect(ctx.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });

  it("declines a join request immediately when its webhook arrives after the quiz timeout", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      ctx.setNow(initialNow + (config.timeoutSeconds + 5) * 1000);
      await ctx.service.join(joinRequest({ date: initialNow }), update(1));

      const session = await requiredSession(ctx.repository, "-100:42");
      expect(session.status).toBe("declined");
      expect(session.expiresAt).toBe(initialNow + config.timeoutSeconds * 1000);
      expect(session.blockedUntil).toBe(
        initialNow + (config.timeoutSeconds + 5) * 1000 + config.cooldownSeconds * 1000,
      );
      expect(ctx.calls.filter((call) => call.method === "declineChatJoinRequest")).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("persists a failed approval and retries it after the lease expires", async () => {
    let attempts = 0;
    const ctx = setup({
      apiOverrides: {
        async approveChatJoinRequest(args) {
          attempts += 1;
          ctx?.calls.push({ method: "approveChatJoinRequest", args });
          if (attempts === 1) {
            throw apiFailure("temporary network failure", { code: 500 });
          }
          return true;
        },
      },
    });
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.join(joinRequest(), update(1));
      await expect(finishQuestions(ctx)).rejects.toThrow("temporary network failure");

      const pendingSession = await requiredSession(ctx.repository, "-100:42");
      expect(pendingSession.status).toBe("approve_pending");
      expect(pendingSession.rulesAcceptedAt).toBe(initialNow);
      expect(pendingSession.rulesAcceptedVersion).toBe(testContent.rules.version);
      expect(pendingSession.effectLeaseUntil).toBe(initialNow + 5000);

      ctx.setNow(initialNow + 5001);
      await ctx.service.start(privateMessage(42));
      expect((await requiredSession(ctx.repository, "-100:42")).status).toBe("approved");
      expect(attempts).toBe(2);
    } finally {
      ctx.close();
    }
  });

  it("recovers a failed private notification through /start", async () => {
    let failOnce = true;
    const ctx = setup({
      apiOverrides: {
        async sendMessage(args) {
          if (failOnce) {
            failOnce = false;
            throw new Error("private message unavailable");
          }
          ctx?.calls.push({ method: "sendMessage", args });
          return { message_id: 2000, chat: { id: args.chat_id, type: "private" } };
        },
      },
    });
    try {
      await ctx.repository.saveConfig(-100, config);
      await expect(ctx.service.join(joinRequest(), update(1))).rejects.toThrow(
        "private message unavailable",
      );
      expect((await requiredSession(ctx.repository, "-100:42")).status).toBe("active");
      expect((await requiredSession(ctx.repository, "-100:42")).messageId).toBeNull();

      await ctx.service.start(privateMessage(42));
      expect((await requiredSession(ctx.repository, "-100:42")).messageId).toBe(2000);
      expect(ctx.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("keeps sessions and join effects separate across groups", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, config);
      await ctx.repository.saveConfig(-200, config);
      await ctx.service.join(joinRequest({ groupId: -100, date: initialNow }), update(1));
      ctx.setNow(initialNow + 1000);
      await ctx.service.join(joinRequest({ groupId: -200, date: initialNow + 1000 }), update(2));
      await ctx.service.start(privateMessage(42));

      for (const key of ["-100:42", "-200:42"]) {
        await finishQuestions(ctx, key);
      }

      expect((await requiredSession(ctx.repository, "-100:42")).status).toBe("approved");
      expect((await requiredSession(ctx.repository, "-200:42")).status).toBe("approved");
      expect(
        ctx.calls
          .filter((call) => call.method === "approveChatJoinRequest")
          .map((call) => call.args.chat_id)
          .sort((a, b) => a - b),
      ).toEqual([-200, -100]);
    } finally {
      ctx.close();
    }
  });
});

function ctxTime(start: number, quizConfig: Config): number {
  return start + (quizConfig.timeoutSeconds + 1) * 1000 + quizConfig.cooldownSeconds * 1000;
}

describe("join notice cleanup", () => {
  const notice: Message = {
    message_id: 77,
    chat: { id: -100, type: "supergroup" },
    from: { id: 42 },
    new_chat_members: [{ id: 42 }],
  };
  const deletions = (ctx: TestContext) =>
    ctx.calls.filter((call) => call.method === "deleteMessage");

  it("keeps join messages unless the group opted in", async () => {
    const ctx = setup();
    try {
      await ctx.service.joinNotice(notice);
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.joinNotice(notice);

      expect(deletions(ctx)).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });

  it("deletes join messages when enabled, even while verification is disabled", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, {
        ...config,
        enabled: false,
        deleteJoinMessages: true,
      });
      await ctx.service.joinNotice(notice);

      expect(deletions(ctx)).toEqual([
        { method: "deleteMessage", args: { chat_id: -100, message_id: 77 } },
      ]);
    } finally {
      ctx.close();
    }
  });

  it("follows the Worker default unless the group set its own value", async () => {
    const ctx = setup({ defaultDeleteJoinMessages: true });
    try {
      await ctx.service.joinNotice(notice);
      await ctx.repository.saveConfig(-100, config);
      await ctx.service.joinNotice(notice);
      await ctx.repository.saveConfig(-100, { ...config, deleteJoinMessages: false });
      await ctx.service.joinNotice(notice);

      expect(deletions(ctx)).toHaveLength(2);
    } finally {
      ctx.close();
    }
  });

  it("ignores permanent Telegram refusals and rethrows retryable failures", async () => {
    let failure = apiFailure("denied", {
      code: 400,
      description: "Bad Request: message can't be deleted",
    });
    const ctx = setup({
      apiOverrides: {
        async deleteMessage() {
          throw failure;
        },
      },
    });
    try {
      await ctx.repository.saveConfig(-100, { ...config, deleteJoinMessages: true });
      await expect(ctx.service.joinNotice(notice)).resolves.toBeUndefined();

      failure = apiFailure("limited", { code: 429, parameters: { retry_after: 3 } });
      await expect(ctx.service.joinNotice(notice)).rejects.toBe(failure);
    } finally {
      ctx.close();
    }
  });
});

describe("spam filter", () => {
  const blocklist: BlocklistDocument = {
    version: "test-blocklist",
    ban: ["日入过万", "=加我"],
    delete: ["点我主页"],
  };
  const groupMessage = (overrides: Partial<Message> = {}): Message => ({
    message_id: 90,
    chat: { id: -100, type: "supergroup" },
    from: { id: 42, first_name: "Member" },
    text: "hello everyone",
    ...overrides,
  });
  const methods = (ctx: TestContext) => ctx.calls.map((call) => call.method);
  const spamConfig = (overrides: Partial<Config> = {}): Config => ({
    ...config,
    spamMode: "new",
    ...overrides,
  });

  it("does nothing while the filter is off", async () => {
    const ctx = setup({ blocklist });
    try {
      await ctx.repository.saveConfig(-100, config);
      await expect(ctx.service.moderate(groupMessage({ text: "日入过万" }))).resolves.toBe(false);
      expect(ctx.calls).toEqual([]);
      expect(await ctx.repository.getMemberMessages(-100, 42)).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("deletes and bans ban-tier matches through spacing, punctuation and full-width tricks", async () => {
    const ctx = setup({ blocklist });
    try {
      await ctx.repository.saveConfig(-100, spamConfig());
      await expect(
        ctx.service.moderate(groupMessage({ text: "轻松 日·入 过-万！！" })),
      ).resolves.toBe(true);
      expect(ctx.calls).toEqual([
        { method: "getChatMember", args: { chat_id: -100, user_id: 42 } },
        { method: "deleteMessage", args: { chat_id: -100, message_id: 90 } },
        { method: "banChatMember", args: { chat_id: -100, user_id: 42 } },
      ]);
      expect(await ctx.repository.getMemberMessages(-100, 42)).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("only deletes delete-tier matches, and only deletes ban-tier matches when spamBan is off", async () => {
    const ctx = setup({ blocklist });
    try {
      await ctx.repository.saveConfig(-100, spamConfig());
      await ctx.service.moderate(groupMessage({ caption: "详情点我主页" }));
      await ctx.repository.saveConfig(-100, spamConfig({ spamBan: false }));
      await ctx.service.moderate(groupMessage({ text: "日入过万" }));
      expect(methods(ctx).filter((method) => method.startsWith("ban"))).toEqual([]);
      expect(methods(ctx).filter((method) => method === "deleteMessage")).toHaveLength(2);
    } finally {
      ctx.close();
    }
  });

  it("checks buttons, names and forward origins, and honours exact entries", async () => {
    const ctx = setup({ blocklist });
    try {
      await ctx.repository.saveConfig(-100, spamConfig({ spamMode: "all" }));
      const hits = [
        groupMessage({ reply_markup: { inline_keyboard: [[{ text: "日入过万 →" }]] } }),
        groupMessage({ from: { id: 43, first_name: "日入", last_name: "过万" } }),
        groupMessage({
          forward_origin: {
            type: "channel",
            chat: { id: -1009, type: "channel", title: "日入过万" },
          },
        }),
        groupMessage({ text: "加 我！" }),
      ];
      for (const message of hits) await expect(ctx.service.moderate(message)).resolves.toBe(true);
      await expect(ctx.service.moderate(groupMessage({ text: "加我好友聊游戏" }))).resolves.toBe(
        false,
      );
    } finally {
      ctx.close();
    }
  });

  it("deletes messages whose Han characters are spaced apart", async () => {
    const ctx = setup();
    try {
      await ctx.repository.saveConfig(-100, spamConfig());
      await expect(
        ctx.service.moderate(groupMessage({ text: "想 赚 钱 的 朋 友 看 过 来" })),
      ).resolves.toBe(true);
      expect(methods(ctx)).toEqual(["getChatMember", "deleteMessage"]);
    } finally {
      ctx.close();
    }
  });

  it("exempts administrators and anonymous admins", async () => {
    const ctx = setup({
      blocklist,
      apiOverrides: {
        async getChatMember() {
          return { status: "administrator" };
        },
      },
    });
    try {
      await ctx.repository.saveConfig(-100, spamConfig());
      await expect(ctx.service.moderate(groupMessage({ text: "日入过万" }))).resolves.toBe(false);
      await expect(
        ctx.service.moderate(
          groupMessage({ text: "日入过万", sender_chat: { id: -100, type: "supergroup" } }),
        ),
      ).resolves.toBe(false);
      expect(methods(ctx)).toEqual([]);
    } finally {
      ctx.close();
    }
  });

  it("bans channel identities with banChatSenderChat", async () => {
    const ctx = setup({ blocklist });
    try {
      await ctx.repository.saveConfig(-100, spamConfig());
      await ctx.service.moderate(
        groupMessage({ text: "日入过万", sender_chat: { id: -1009, type: "channel" } }),
      );
      expect(ctx.calls).toEqual([
        { method: "deleteMessage", args: { chat_id: -100, message_id: 90 } },
        { method: "banChatSenderChat", args: { chat_id: -100, sender_chat_id: -1009 } },
      ]);
    } finally {
      ctx.close();
    }
  });

  it("stops inspecting after the first N clean messages until the member rejoins", async () => {
    const ctx = setup({ blocklist });
    try {
      await ctx.repository.saveConfig(-100, spamConfig({ spamFirstMessages: 2 }));
      await ctx.service.moderate(groupMessage());
      await ctx.service.moderate(groupMessage({ text: "edited later" }), { edited: true });
      await ctx.service.moderate(groupMessage());
      expect(await ctx.repository.getMemberMessages(-100, 42)).toBe(2);
      await expect(ctx.service.moderate(groupMessage({ text: "日入过万" }))).resolves.toBe(false);

      await ctx.service.joinNotice(groupMessage({ new_chat_members: [{ id: 42 }] }));
      await expect(ctx.service.moderate(groupMessage({ text: "日入过万" }))).resolves.toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("inspects every message in all mode", async () => {
    const ctx = setup({ blocklist });
    try {
      await ctx.repository.saveConfig(-100, spamConfig({ spamMode: "all" }));
      for (let index = 0; index < 5; index += 1) await ctx.service.moderate(groupMessage());
      expect(await ctx.repository.getMemberMessages(-100, 42)).toBe(1);
      await expect(ctx.service.moderate(groupMessage({ text: "日入过万" }))).resolves.toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("bans CAS-listed users on their first message only", async () => {
    const casCheck = vi.fn(async (userId: number) => userId === 666);
    const ctx = setup({ casCheck });
    try {
      await ctx.repository.saveConfig(-100, spamConfig());
      await ctx.service.moderate(groupMessage());
      await ctx.service.moderate(groupMessage());
      await expect(ctx.service.moderate(groupMessage({ from: { id: 666 } }))).resolves.toBe(true);
      expect(casCheck.mock.calls.map(([userId]) => userId)).toEqual([42, 666]);
      expect(methods(ctx)).toEqual(["getChatMember", "deleteMessage", "banChatMember"]);

      casCheck.mockClear();
      await ctx.repository.saveConfig(-100, spamConfig({ spamCas: false }));
      await ctx.service.moderate(groupMessage({ from: { id: 777 } }));
      expect(casCheck).not.toHaveBeenCalled();
    } finally {
      ctx.close();
    }
  });

  it("applies Worker-wide defaults to groups without their own spam settings", async () => {
    const ctx = setup({
      blocklist,
      spamDefaults: { mode: "all", firstMessages: 3, ban: false, cas: false },
    });
    try {
      await expect(ctx.service.moderate(groupMessage({ text: "日入过万" }))).resolves.toBe(true);
      expect(methods(ctx)).toEqual(["getChatMember", "deleteMessage"]);

      await ctx.repository.saveConfig(-100, { ...config, spamMode: "off" });
      await expect(ctx.service.moderate(groupMessage({ text: "日入过万" }))).resolves.toBe(false);
    } finally {
      ctx.close();
    }
  });

  it("ignores permanent refusals but rethrows retryable failures", async () => {
    let failure = apiFailure("denied", {
      code: 400,
      description: "Bad Request: not enough rights",
    });
    const ctx = setup({
      blocklist,
      apiOverrides: {
        async banChatMember() {
          throw failure;
        },
      },
    });
    try {
      await ctx.repository.saveConfig(-100, spamConfig());
      await expect(ctx.service.moderate(groupMessage({ text: "日入过万" }))).resolves.toBe(true);
      failure = apiFailure("limited", { code: 429, parameters: { retry_after: 1 } });
      await expect(ctx.service.moderate(groupMessage({ text: "日入过万" }))).rejects.toBe(failure);
    } finally {
      ctx.close();
    }
  });
});
