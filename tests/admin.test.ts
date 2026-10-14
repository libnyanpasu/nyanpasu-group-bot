import { describe, expect, it, vi } from "vitest";
import type { BotApi, Config, ContentPack, Member, Message, Repository } from "../src/types.js";

import { createAdmin } from "../src/lib/admin.ts";
import { DEFAULT_CONFIG } from "../src/lib/quiz.ts";

const TEST_OPTIONS = [
  "TEST ONLY: answer one",
  "TEST ONLY: answer two",
  "TEST ONLY: answer three",
  "TEST ONLY: answer four",
];
const TEST_PACK: ContentPack = {
  id: "default",
  version: "test-1",
  questions: [1, 2, 3].map((n) => ({
    id: `q${n}`,
    prompt: `TEST ONLY: question ${n}`,
    options: TEST_OPTIONS,
    answerIndex: 0,
    translations: {
      en: { prompt: `TEST ONLY: question ${n}`, options: TEST_OPTIONS },
      cn: { prompt: `测试专用：问题 ${n}`, options: TEST_OPTIONS },
    },
  })),
  rules: {
    version: "rules-test-1",
    en: "TEST ONLY: synthetic test rules.",
    cn: "测试专用：合成的测试规则。",
  },
};

const GROUP_ID = -100123;
const ADMIN_ID = 456;
const BOT_ID = 99;

function groupMessage(text: string, extra: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    text,
    chat: { id: GROUP_ID, type: "supergroup", title: "Test group" },
    from: { id: ADMIN_ID },
    ...extra,
  };
}

function privateMessage(text: string, extra: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    text,
    chat: { id: ADMIN_ID, type: "private" },
    from: { id: ADMIN_ID, language_code: "en" },
    ...extra,
  };
}

type AdminApi = Pick<
  BotApi,
  "sendMessage" | "getMe" | "getChat" | "getChatMember" | "createChatInviteLink"
>;
type AdminRepository = Pick<
  Repository,
  "getConfig" | "saveConfig" | "getContentPack" | "getBlocklist"
>;

interface SetupOptions {
  config?: Partial<Config> | null;
  member?: Member;
  botMember?: Member;
  pack?: ContentPack | null;
  defaultDeleteJoinMessages?: boolean;
}

function setup({
  config = null,
  member,
  botMember,
  pack = TEST_PACK,
  defaultDeleteJoinMessages,
}: SetupOptions = {}) {
  const storedConfig: Config | null = config ? { ...DEFAULT_CONFIG, ...config } : null;
  const api = {
    sendMessage: vi.fn<BotApi["sendMessage"]>().mockResolvedValue({
      message_id: 1,
      chat: { id: GROUP_ID, type: "supergroup" },
    }),
    getMe: vi.fn<BotApi["getMe"]>().mockResolvedValue({ id: BOT_ID, username: "verify_bot" }),
    getChat: vi
      .fn<BotApi["getChat"]>()
      .mockResolvedValue({ id: GROUP_ID, type: "supergroup", title: "Test group" }),
    getChatMember: vi.fn<BotApi["getChatMember"]>().mockImplementation(async ({ user_id }) => {
      if (user_id === BOT_ID) {
        return botMember ?? { status: "administrator", can_invite_users: true };
      }
      return member ?? { status: "administrator", can_invite_users: true };
    }),
    createChatInviteLink: vi.fn<BotApi["createChatInviteLink"]>().mockResolvedValue({
      invite_link: "https://t.me/+TEST_PRIVATE_LINK",
      creates_join_request: true,
    }),
  } satisfies AdminApi;
  const repository = {
    getConfig: vi.fn<Repository["getConfig"]>().mockResolvedValue(storedConfig),
    saveConfig: vi
      .fn<Repository["saveConfig"]>()
      .mockImplementation(async (_groupId, value) => value),
    getContentPack: vi
      .fn<Repository["getContentPack"]>()
      .mockImplementation(async (id) => (pack && pack.id === id ? pack : null)),
    getBlocklist: vi.fn<Repository["getBlocklist"]>().mockResolvedValue({
      version: "blocklist-test-1",
      ban: ["TEST ONLY banned phrase"],
      delete: [],
    }),
  } satisfies AdminRepository;
  const handle = createAdmin({ api, repository, defaultDeleteJoinMessages });
  return { api, repository, handle };
}

describe("createAdmin", () => {
  it("ignores non-admin commands and commands addressed to another bot", async () => {
    const { api, handle } = setup();

    await expect(handle(groupMessage("hello"))).resolves.toBe(false);
    await expect(handle(groupMessage("/verify_help@other_bot"))).resolves.toBe(false);
    expect(api.getChatMember).not.toHaveBeenCalled();
  });

  it("rejects anonymous senders before checking admin permissions", async () => {
    const { api, handle } = setup();

    await handle(
      groupMessage("/verify_help", { sender_chat: { id: GROUP_ID, type: "supergroup" } }),
    );

    expect(api.getChatMember).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("匿名管理员") }),
    );
  });

  it("requires the sender to be an owner or an admin allowed to invite users", async () => {
    const { api, handle } = setup({
      member: { status: "administrator", can_invite_users: false },
    });

    await handle(groupMessage("/verify_help"));

    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("邀请成员权限") }),
    );
  });

  it("accepts a group owner even when Telegram omits administrator rights", async () => {
    const { api, handle } = setup({ member: { status: "creator" } });

    await handle(groupMessage("/verify_help"));

    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("/verify_status") }),
    );
  });

  it("shows only group id and content versions in status, never private content", async () => {
    const { api, handle } = setup();

    await handle(groupMessage("/verify_status"));

    const status = api.sendMessage.mock.calls[0][0].text;
    expect(status).toContain(String(GROUP_ID));
    expect(status).toContain("test-1");
    expect(status).toContain("rules-test-1");
    expect(status).toContain("blocklist-test-1");
    expect(status).not.toContain("banned phrase");
    expect(status).not.toContain("question 1");
    expect(status).not.toContain("TEST ONLY: synthetic test rules");
    expect(status).not.toContain("TEST ONLY: answer one");
  });

  it("refuses to enable if the configured private pack is missing", async () => {
    const { api, repository, handle } = setup({ config: { contentId: "not-present" } });

    await handle(groupMessage("/verify_enable"));

    expect(repository.saveConfig).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("没有有效的私有题目和规则包"),
      }),
    );
  });

  it("requires the bot to be able to receive and approve join requests before enabling", async () => {
    const { api, repository, handle } = setup({
      botMember: { status: "administrator", can_invite_users: false },
    });

    await handle(groupMessage("/verify_enable"));

    expect(repository.saveConfig).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("邀请成员权限"),
      }),
    );
  });

  it("enables verification only after validating the private pack and bot permission", async () => {
    const { api, repository, handle } = setup();

    await handle(groupMessage("/verify_enable"));

    expect(repository.saveConfig).toHaveBeenCalledWith(
      GROUP_ID,
      expect.objectContaining({ enabled: true, contentId: "default" }),
    );
    expect(api.getChatMember).toHaveBeenCalledWith({ chat_id: GROUP_ID, user_id: BOT_ID });
  });

  it("updates only language and bounded duration settings", async () => {
    const { repository, handle } = setup();

    await handle(groupMessage("/verify_config language=en timeoutSeconds=180 cooldownSeconds=900"));

    expect(repository.saveConfig).toHaveBeenCalledWith(
      GROUP_ID,
      expect.objectContaining({
        language: "en",
        timeoutSeconds: 180,
        cooldownSeconds: 900,
        enabled: false,
        contentId: "default",
      }),
    );
  });

  it("toggles join-message deletion and warns when the bot cannot delete messages", async () => {
    const { api, repository, handle } = setup({
      botMember: { status: "administrator", can_invite_users: true },
    });

    await handle(groupMessage("/verify_config deleteJoinMessages=on"));

    expect(repository.saveConfig).toHaveBeenCalledWith(
      GROUP_ID,
      expect.objectContaining({ deleteJoinMessages: true }),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("删除消息权限") }),
    );
  });

  it("does not warn when the bot can delete messages or the option is turned off", async () => {
    const { api, repository, handle } = setup({
      botMember: { status: "administrator", can_invite_users: true, can_delete_messages: true },
    });

    await handle(groupMessage("/verify_config deleteJoinMessages=on"));
    await handle(groupMessage("/verify_config deleteJoinMessages=off"));

    expect(repository.saveConfig).toHaveBeenLastCalledWith(
      GROUP_ID,
      expect.objectContaining({ deleteJoinMessages: false }),
    );
    expect(api.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("删除消息权限") }),
    );
  });

  it("shows the Worker default and lets deleteJoinMessages=default clear a group override", async () => {
    const { api, repository, handle } = setup({
      config: { language: "en", deleteJoinMessages: false },
      defaultDeleteJoinMessages: true,
      botMember: { status: "administrator", can_invite_users: true, can_delete_messages: true },
    });

    await handle(groupMessage("/verify_config"));
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/Delete join messages: Off\n/) }),
    );

    await handle(groupMessage("/verify_config deleteJoinMessages=default"));
    const saved = repository.saveConfig.mock.calls[0][1];
    expect(Object.hasOwn(saved, "deleteJoinMessages")).toBe(false);
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Delete join messages: On (global default)"),
      }),
    );
  });

  it("configures the advertising filter and lists missing bot permissions", async () => {
    const { api, repository, handle } = setup({
      botMember: { status: "administrator", can_invite_users: true, can_delete_messages: true },
    });

    await handle(
      groupMessage("/verify_config spamMode=new spamFirstMessages=5 spamBan=on spamCas=off"),
    );

    expect(repository.saveConfig).toHaveBeenCalledWith(
      GROUP_ID,
      expect.objectContaining({
        spamMode: "new",
        spamFirstMessages: 5,
        spamBan: true,
        spamCas: false,
      }),
    );
    const reply = api.sendMessage.mock.calls[0][0].text;
    expect(reply).toContain("仅检查新成员前 5 条消息");
    expect(reply).toContain("封禁成员");
    expect(reply).not.toContain("删除消息、");
  });

  it("does not ask for ban rights when the filter only deletes", async () => {
    const { api, handle } = setup({
      botMember: { status: "administrator", can_invite_users: true, can_delete_messages: true },
    });

    await handle(groupMessage("/verify_config spamMode=all spamBan=off"));

    expect(api.sendMessage.mock.calls[0][0].text).not.toContain("缺少以下权限");
  });

  it.each(["spamMode=on", "spamFirstMessages=0", "spamFirstMessages=101", "spamCas=yes"])(
    "rejects invalid advertising filter option %s",
    async (option) => {
      const { repository, handle } = setup();

      await handle(groupMessage(`/verify_config ${option}`));

      expect(repository.saveConfig).not.toHaveBeenCalled();
    },
  );

  it("rejects non on/off join-message deletion values", async () => {
    const { repository, handle } = setup();

    await handle(groupMessage("/verify_config deleteJoinMessages=true"));

    expect(repository.saveConfig).not.toHaveBeenCalled();
  });

  it("rejects invalid durations without saving", async () => {
    const { api, repository, handle } = setup();

    await handle(groupMessage("/verify_config timeoutSeconds=0"));

    expect(repository.saveConfig).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("配置无效") }),
    );
  });

  it("does not provide any command for reading or changing private content", async () => {
    const { api, repository, handle } = setup();

    await expect(handle(groupMessage("/verify_content default"))).resolves.toBe(false);
    await expect(handle(privateMessage("/verify_questions -100123 []"))).resolves.toBe(false);

    expect(api.getChatMember).not.toHaveBeenCalled();
    expect(repository.saveConfig).not.toHaveBeenCalled();
  });

  it("sends group invite setup commands to private chat and never creates a link in a group", async () => {
    const { api, handle } = setup();

    await handle(groupMessage("/verify_invite"));

    expect(api.createChatInviteLink).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: GROUP_ID,
        text: expect.stringContaining(`/verify_invite ${GROUP_ID}`),
      }),
    );
  });

  it("creates a join-request link in a private chat after validating target admin and bot rights", async () => {
    const { api, handle } = setup({ config: { enabled: true } });

    await handle(privateMessage(`/verify_invite ${GROUP_ID}`));

    expect(api.getChat).toHaveBeenCalledWith({ chat_id: GROUP_ID });
    expect(api.createChatInviteLink).toHaveBeenCalledWith({
      chat_id: GROUP_ID,
      name: "verification requests",
      creates_join_request: true,
    });
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: ADMIN_ID,
        text: expect.stringContaining("https://t.me/+TEST_PRIVATE_LINK"),
      }),
    );
    expect(api.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: GROUP_ID,
        text: expect.stringContaining("https://t.me/"),
      }),
    );
  });

  it("refuses invite links when disabled or the bot cannot invite", async () => {
    const disabled = setup();
    await disabled.handle(privateMessage(`/verify_invite ${GROUP_ID}`));
    expect(disabled.api.createChatInviteLink).not.toHaveBeenCalled();

    const noBotRight = setup({
      config: { enabled: true },
      botMember: { status: "administrator", can_invite_users: false },
    });
    await noBotRight.handle(privateMessage(`/verify_invite ${GROUP_ID}`));
    expect(noBotRight.api.createChatInviteLink).not.toHaveBeenCalled();
  });

  it("checks the private command sender's admin role in the target group", async () => {
    const { api, handle } = setup({
      member: { status: "member" },
      config: { enabled: true },
    });

    await handle(privateMessage(`/verify_invite ${GROUP_ID}`));

    expect(api.createChatInviteLink).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Only the group owner") }),
    );
  });

  it("uses the requester's language for private invite setup and group language for settings", async () => {
    const { api, handle } = setup({ config: { enabled: false, language: "cn" } });

    await handle(
      privateMessage(`/verify_invite ${GROUP_ID}`, { from: { id: ADMIN_ID, language_code: "en" } }),
    );
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Configure a valid private content pack"),
      }),
    );

    const englishGroup = setup({ config: { language: "en" } });
    await englishGroup.handle(
      privateMessage(`/verify_config ${GROUP_ID}`, { from: { id: ADMIN_ID, language_code: "zh" } }),
    );
    expect(englishGroup.api.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Language: en") }),
    );
  });
});
