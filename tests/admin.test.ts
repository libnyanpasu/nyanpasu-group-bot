import { describe, expect, it, vi } from "vitest";
import type { BotApi, Config, ContentPack, Member, Message, Repository } from "../src/types.js";

import { ADMIN_COMMANDS, createAdmin, type AdminCommand } from "../src/lib/admin.ts";
import { DEFAULT_CONFIG } from "../src/lib/quiz.ts";
import type { SpamSettings } from "../src/lib/spam.ts";

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
  | "getConfig"
  | "saveConfig"
  | "getContentPack"
  | "getBlocklist"
  | "getAdminTarget"
  | "setAdminTarget"
  | "clearAdminTarget"
>;

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface SetupOptions {
  config?: Partial<Config> | null;
  member?: Member;
  botMember?: Member;
  pack?: ContentPack | null;
  defaultDeleteJoinMessages?: boolean;
  spamDefaults?: SpamSettings;
  /** A group the user already selected, and when it was last used. */
  selected?: { groupId: number; at?: number };
}

function setup({
  config = null,
  member,
  botMember,
  pack = TEST_PACK,
  defaultDeleteJoinMessages,
  spamDefaults,
  selected,
}: SetupOptions = {}) {
  const targets = new Map<number, { groupId: number; at: number }>();
  if (selected) targets.set(ADMIN_ID, { groupId: selected.groupId, at: selected.at ?? NOW });
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
    getAdminTarget: vi
      .fn<Repository["getAdminTarget"]>()
      .mockImplementation(async (userId, notBefore) => {
        const target = targets.get(userId);
        return target && target.at >= notBefore ? target.groupId : null;
      }),
    setAdminTarget: vi
      .fn<Repository["setAdminTarget"]>()
      .mockImplementation(async (userId, groupId, at) => {
        targets.set(userId, { groupId, at });
      }),
    clearAdminTarget: vi.fn<Repository["clearAdminTarget"]>().mockImplementation(async (userId) => {
      targets.delete(userId);
    }),
  } satisfies AdminRepository;
  const admin = createAdmin({
    api,
    repository,
    now: () => NOW,
    defaultDeleteJoinMessages,
    spamDefaults,
  });
  /** Mimic grammY's command routing (covered in worker.test.ts): true when a command ran. */
  const handle = async (message: Message): Promise<boolean> => {
    const match = /^\/([a-z_]+)(?:\s+([\s\S]*))?$/.exec(message.text ?? "");
    const name = ADMIN_COMMANDS.find((command) => command === match?.[1]);
    if (!match || !name) return false;
    await admin.handle(message, { name, args: match[2]?.trim() ?? "" } satisfies AdminCommand);
    return true;
  };
  return { api, repository, handle, admin, targets };
}

describe("createAdmin", () => {
  it("ignores messages that are not admin commands", async () => {
    const { api, handle } = setup();

    await expect(handle(groupMessage("hello"))).resolves.toBe(false);
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

  it("configures the spam filter and lists missing bot permissions", async () => {
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

  it("marks inherited spam settings and clears group overrides with =default", async () => {
    const { api, repository, handle } = setup({
      config: { language: "en", spamMode: "off", spamCas: false },
      spamDefaults: { mode: "new", firstMessages: 5, ban: false, cas: true },
      botMember: { status: "administrator", can_invite_users: true, can_delete_messages: true },
    });

    await handle(groupMessage("/verify_config"));
    const before = api.sendMessage.mock.calls[0][0].text;
    expect(before).toContain("Spam filter: Off\n");
    expect(before).toContain("Ban on ban-list matches: Off (global default)");
    expect(before).toMatch(/CAS ban list: Off$/);

    await handle(groupMessage("/verify_config spamMode=default spamCas=default"));
    const saved = repository.saveConfig.mock.calls[0][1];
    expect(Object.hasOwn(saved, "spamMode")).toBe(false);
    expect(Object.hasOwn(saved, "spamCas")).toBe(false);
    const after = api.sendMessage.mock.calls[1][0].text;
    expect(after).toContain("first 5 messages of new members (global default)");
    expect(after).toContain("CAS ban list: On (global default)");
    expect(after).not.toContain("cannot fully work");
  });

  it("does not ask for ban rights when the filter only deletes", async () => {
    const { api, handle } = setup({
      botMember: { status: "administrator", can_invite_users: true, can_delete_messages: true },
    });

    await handle(groupMessage("/verify_config spamMode=all spamBan=off"));

    expect(api.sendMessage.mock.calls[0][0].text).not.toContain("缺少以下权限");
  });

  it.each([
    "spamMode=on",
    "spamFirstMessages=0",
    "spamFirstMessages=101",
    "spamCas=yes",
    "spamBan=default=on",
  ])("rejects invalid spam filter option %s", async (option) => {
    const { repository, handle } = setup();

    await handle(groupMessage(`/verify_config ${option}`));

    expect(repository.saveConfig).not.toHaveBeenCalled();
  });

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
        text: expect.stringContaining("/verify_invite"),
        reply_markup: {
          inline_keyboard: [
            [expect.objectContaining({ url: "https://t.me/verify_bot?start=g100123" })],
          ],
        },
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

  describe("group selection from a private chat", () => {
    const telegramError = (code: number) => Object.assign(new Error("telegram"), { code });
    const sharedMessage = (chatId = GROUP_ID, extra: Partial<Message> = {}) =>
      privateMessage("", {
        text: undefined,
        chat_shared: { request_id: 1, chat_id: chatId, title: "Test group" },
        ...extra,
      });
    const lastText = (api: ReturnType<typeof setup>["api"]) =>
      api.sendMessage.mock.lastCall![0].text;

    it("offers Telegram's group picker limited to groups the user can invite to", async () => {
      const { api, handle } = setup();

      await handle(privateMessage("/verify_groups"));

      expect(api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: ADMIN_ID,
          reply_markup: {
            keyboard: [
              [
                {
                  text: "Choose a group",
                  request_chat: {
                    request_id: 1,
                    chat_is_channel: false,
                    bot_is_member: true,
                    user_administrator_rights: { can_invite_users: true },
                  },
                },
              ],
            ],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }),
      );
      expect(lastText(api)).not.toContain("Currently managing");
    });

    it("names the current selection and clears it on request", async () => {
      const { api, handle, targets } = setup({ selected: { groupId: GROUP_ID } });

      await handle(privateMessage("/verify_groups"));
      expect(lastText(api)).toContain(`Currently managing: Test group (${GROUP_ID})`);

      await handle(privateMessage("/verify_groups clear"));
      expect(targets.has(ADMIN_ID)).toBe(false);
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "Group selection cleared.",
          reply_markup: { remove_keyboard: true },
        }),
      );
    });

    it("sends /verify_groups from a group to the private chat with a deep link", async () => {
      const { api, handle } = setup();

      await handle(groupMessage("/verify_groups"));

      expect(api.getChatMember).not.toHaveBeenCalled();
      const [call] = api.sendMessage.mock.calls[0];
      expect(call.chat_id).toBe(GROUP_ID);
      expect(call.reply_markup).toEqual({
        inline_keyboard: [
          [expect.objectContaining({ url: "https://t.me/verify_bot?start=g100123" })],
        ],
      });
    });

    it("saves a picked group only after verifying the user and the group", async () => {
      const { api, admin, targets } = setup();

      await admin.chatShared(sharedMessage());

      expect(api.getChatMember).toHaveBeenCalledWith({ chat_id: GROUP_ID, user_id: ADMIN_ID });
      expect(targets.get(ADMIN_ID)).toEqual({ groupId: GROUP_ID, at: NOW });
      expect(api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: ADMIN_ID,
          text: expect.stringContaining(`Now managing Test group (${GROUP_ID})`),
          reply_markup: { remove_keyboard: true },
        }),
      );
    });

    it("rejects a picked group the user cannot manage or the bot cannot see", async () => {
      const forbidden = setup({ member: { status: "member" } });
      await forbidden.admin.chatShared(sharedMessage());
      expect(forbidden.targets.size).toBe(0);
      expect(forbidden.api.sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("could not be selected"),
          reply_markup: { remove_keyboard: true },
        }),
      );

      const unreachable = setup();
      unreachable.api.getChatMember.mockRejectedValue(telegramError(400));
      await unreachable.admin.chatShared(sharedMessage());
      expect(unreachable.targets.size).toBe(0);
      expect(lastText(unreachable.api)).toContain("could not be selected");

      const channel = setup();
      channel.api.getChat.mockResolvedValue({ id: GROUP_ID, type: "channel" });
      await channel.admin.chatShared(sharedMessage());
      expect(channel.targets.size).toBe(0);
    });

    it("ignores shares that are not ours or not in a private chat", async () => {
      const { api, admin, targets } = setup();

      await admin.chatShared(
        privateMessage("", { chat_shared: { request_id: 2, chat_id: GROUP_ID } }),
      );
      await admin.chatShared(
        groupMessage("", { chat_shared: { request_id: 1, chat_id: GROUP_ID } }),
      );

      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(targets.size).toBe(0);
    });

    it("runs commands on the selected group without a group ID", async () => {
      const { api, repository, handle } = setup({
        config: { language: "en" },
        selected: { groupId: GROUP_ID, at: NOW - 60_000 },
      });

      await handle(privateMessage("/verify_config timeoutSeconds=60"));

      expect(api.getChatMember).toHaveBeenCalledWith({ chat_id: GROUP_ID, user_id: ADMIN_ID });
      expect(repository.saveConfig).toHaveBeenCalledWith(
        GROUP_ID,
        expect.objectContaining({ timeoutSeconds: 60 }),
      );
      // Every use slides the 24 hour window.
      expect(repository.setAdminTarget).toHaveBeenCalledWith(ADMIN_ID, GROUP_ID, NOW);
    });

    it("asks for /verify_groups when nothing is selected or the selection expired", async () => {
      const none = setup();
      await none.handle(privateMessage("/verify_status"));
      expect(lastText(none.api)).toContain("/verify_groups");
      expect(none.api.getChatMember).not.toHaveBeenCalled();

      const expired = setup({ selected: { groupId: GROUP_ID, at: NOW - DAY - 1 } });
      await expired.handle(privateMessage("/verify_status"));
      expect(lastText(expired.api)).toContain("/verify_groups");
      expect(expired.api.getChatMember).not.toHaveBeenCalled();

      const edge = setup({ selected: { groupId: GROUP_ID, at: NOW - DAY } });
      await edge.handle(privateMessage("/verify_status"));
      expect(lastText(edge.api)).toContain(String(GROUP_ID));
    });

    it("drops a selection whose group is gone and hides why", async () => {
      const { api, handle, targets } = setup({ selected: { groupId: GROUP_ID } });
      api.getChatMember.mockRejectedValue(telegramError(403));

      await handle(privateMessage("/verify_status"));

      expect(targets.has(ADMIN_ID)).toBe(false);
      expect(lastText(api)).toContain("was not found");
    });

    it("keeps the selection when the user lost their admin rights", async () => {
      const { api, repository, handle } = setup({
        selected: { groupId: GROUP_ID },
        member: { status: "member" },
        config: { language: "en" },
      });

      await handle(privateMessage("/verify_enable"));

      expect(repository.saveConfig).not.toHaveBeenCalled();
      expect(repository.setAdminTarget).not.toHaveBeenCalled();
      expect(lastText(api)).toContain("Only the group owner");
    });

    it("rethrows Telegram failures it cannot attribute to the target", async () => {
      const { api, handle } = setup({ selected: { groupId: GROUP_ID } });
      api.getChatMember.mockRejectedValue(telegramError(500));

      await expect(handle(privateMessage("/verify_status"))).rejects.toThrow("telegram");
    });

    it("remembers a group given explicitly", async () => {
      const { handle, targets } = setup();

      await handle(privateMessage(`/verify_status ${GROUP_ID}`));

      expect(targets.get(ADMIN_ID)).toEqual({ groupId: GROUP_ID, at: NOW });
    });

    it("does not remember a group the user does not manage", async () => {
      const { api, handle, targets } = setup({
        member: { status: "member" },
        config: { language: "en" },
      });

      await handle(privateMessage(`/verify_status ${GROUP_ID}`));

      expect(targets.size).toBe(0);
      expect(lastText(api)).toContain("Only the group owner");
    });

    it("tells a user whose target is not a group", async () => {
      const { api, handle, targets } = setup();
      api.getChat.mockResolvedValue({ id: GROUP_ID, type: "channel" });

      await handle(privateMessage(`/verify_status ${GROUP_ID}`));

      expect(targets.size).toBe(0);
      expect(lastText(api)).toContain("group or supergroup");
    });

    it("opens a group from a deep link only for its administrators", async () => {
      const allowed = setup();
      await expect(allowed.admin.open(privateMessage("/start g100123"), "g100123")).resolves.toBe(
        true,
      );
      expect(allowed.targets.get(ADMIN_ID)).toEqual({ groupId: GROUP_ID, at: NOW });
      expect(lastText(allowed.api)).toContain("Now managing");

      const denied = setup({ member: { status: "member" } });
      await expect(denied.admin.open(privateMessage("/start g100123"), "g100123")).resolves.toBe(
        true,
      );
      expect(denied.targets.size).toBe(0);
      expect(lastText(denied.api)).toContain("not an administrator");
    });

    it("leaves unrelated /start payloads and group chats alone", async () => {
      const { api, admin } = setup();

      await expect(admin.open(privateMessage("/start hello"), "hello")).resolves.toBe(false);
      await expect(admin.open(privateMessage("/start s0"), "s0")).resolves.toBe(false);
      await expect(admin.open(groupMessage("/start g100123"), "g100123")).resolves.toBe(false);

      expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("gives anonymous admins and group help a button to the private chat", async () => {
      const { api, handle } = setup();

      await handle(
        groupMessage("/verify_status", { sender_chat: { id: GROUP_ID, type: "supergroup" } }),
      );
      await handle(groupMessage("/verify_help"));
      await handle(groupMessage("/verify_config"));
      await handle(groupMessage("/verify_status"));

      for (const [call] of api.sendMessage.mock.calls) {
        expect(call.reply_markup).toEqual({
          inline_keyboard: [
            [expect.objectContaining({ url: "https://t.me/verify_bot?start=g100123" })],
          ],
        });
      }
      expect(api.sendMessage).toHaveBeenCalledTimes(4);
    });
  });
});
