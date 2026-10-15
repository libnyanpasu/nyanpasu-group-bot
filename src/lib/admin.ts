import type {
  BotApi,
  Config,
  ContentPack,
  Language,
  Member,
  Message,
  Repository,
  User,
} from "../types.js";
import { adminMessage, type AdminMessageKey } from "./admin-i18n.js";
import { DEFAULT_CONFIG, validateConfig, validateContentPack } from "./quiz.js";
import {
  DEFAULT_BLOCKLIST_ID,
  DEFAULT_SPAM_SETTINGS,
  type SpamSettings,
  spamSettings,
  validateBlocklist,
} from "./spam.js";

/** Commands the admin module handles; grammY's `bot.command` routes them and parses arguments. */
export const ADMIN_COMMANDS = [
  "verify_help",
  "verify_status",
  "verify_enable",
  "verify_disable",
  "verify_config",
  "verify_invite",
] as const;
const CONFIG_KEYS = new Set(["timeoutSeconds", "cooldownSeconds", "spamFirstMessages"]);
const SPAM_KEYS = ["spamMode", "spamFirstMessages", "spamBan", "spamCas"] as const;

/** A routed admin command: its name without the slash and the trimmed text after it. */
export interface AdminCommand {
  name: (typeof ADMIN_COMMANDS)[number];
  args: string;
}

type AdminApi = Pick<
  BotApi,
  "sendMessage" | "getMe" | "getChat" | "getChatMember" | "createChatInviteLink"
>;
interface AdminOptions {
  api: AdminApi;
  repository: Pick<Repository, "getConfig" | "saveConfig" | "getContentPack" | "getBlocklist">;
  /** Used for groups that have not set deleteJoinMessages themselves. */
  defaultDeleteJoinMessages?: boolean;
  /** Spam filter settings for groups that have not set their own. */
  spamDefaults?: SpamSettings;
}

function userLanguage(user: User | undefined, fallback: Language): Language {
  const code = user?.language_code?.toLowerCase() ?? "";
  if (code.startsWith("en")) return "en";
  if (code.startsWith("zh")) return "cn";
  return fallback;
}

function groupLanguage(config: Config | null): Language {
  return config?.language === "en" ? "en" : "cn";
}

function isAdmin(status: string, canInviteUsers?: boolean): boolean {
  return status === "creator" || (status === "administrator" && canInviteUsers === true);
}

function canDeleteMessages(member: Member): boolean {
  return (
    member.status === "creator" ||
    (member.status === "administrator" && member.can_delete_messages === true)
  );
}

function canRestrictMembers(member: Member): boolean {
  return (
    member.status === "creator" ||
    (member.status === "administrator" && member.can_restrict_members === true)
  );
}

function configText(
  config: Config,
  language: Language,
  defaultDelete: boolean,
  spamDefaults: SpamSettings,
): string {
  // Values a group has not set itself are marked as following the Worker-wide default.
  const shown = (value: string, inherited: boolean) =>
    inherited ? adminMessage(language, "globalDefault", { value }) : value;
  const toggle = (on: boolean) => adminMessage(language, on ? "on" : "off");
  const spam = spamSettings(config, spamDefaults);
  return adminMessage(language, "config", {
    language: config.language,
    timeoutSeconds: config.timeoutSeconds,
    cooldownSeconds: config.cooldownSeconds,
    deleteJoinMessages: shown(
      toggle(config.deleteJoinMessages ?? defaultDelete),
      config.deleteJoinMessages === undefined,
    ),
    spamMode: shown(
      spam.mode === "new"
        ? adminMessage(language, "spamModeNew", { count: spam.firstMessages })
        : adminMessage(language, spam.mode === "all" ? "spamModeAll" : "off"),
      config.spamMode === undefined ||
        (spam.mode === "new" && config.spamFirstMessages === undefined),
    ),
    spamBan: shown(toggle(spam.ban), config.spamBan === undefined),
    spamCas: shown(toggle(spam.cas), config.spamCas === undefined),
  });
}

function send(
  api: AdminApi,
  chatId: number,
  language: Language,
  key: AdminMessageKey,
  values?: Record<string, string | number>,
) {
  return api.sendMessage({ chat_id: chatId, text: adminMessage(language, key, values) });
}

function packIsUsable(pack: ContentPack | null | undefined): pack is ContentPack {
  return pack != null && validateContentPack(pack) === null;
}

export function createAdmin({
  api,
  repository,
  defaultDeleteJoinMessages = false,
  spamDefaults = DEFAULT_SPAM_SETTINGS,
}: AdminOptions) {
  /** List bot permissions the spam filter needs but lacks, in the reply language. */
  async function missingSpamPermissions(chatId: number, ban: boolean, language: Language) {
    const me = await api.getMe();
    const botMember = await api.getChatMember({ chat_id: chatId, user_id: me.id });
    const missing: AdminMessageKey[] = [];
    if (!canDeleteMessages(botMember)) missing.push("permissionDelete");
    if (ban && !canRestrictMembers(botMember)) missing.push("permissionRestrict");
    return missing.map((key) => adminMessage(language, key));
  }

  return async function handle(message: Message, command: AdminCommand): Promise<void> {
    const sourceChatId = message.chat.id;
    const privateChat = message.chat.type === "private";
    const groupChat = message.chat.type === "group" || message.chat.type === "supergroup";
    if (!privateChat && !groupChat) {
      await send(api, sourceChatId, userLanguage(message.from, "cn"), "unsupportedChat");
      return;
    }

    if (privateChat && command.name === "verify_help" && !command.args) {
      await send(api, sourceChatId, userLanguage(message.from, "cn"), "privateHelp");
      return;
    }

    if (groupChat && command.name === "verify_invite") {
      if (message.sender_chat) {
        await send(api, sourceChatId, "cn", "anonymousAdmin");
        return;
      }
      const senderId = message.from?.id;
      if (senderId == null) {
        await send(api, sourceChatId, "cn", "senderUnknown");
        return;
      }
      const groupMember = await api.getChatMember({ chat_id: sourceChatId, user_id: senderId });
      const storedConfig = await repository.getConfig(sourceChatId);
      const language = groupLanguage(storedConfig);
      if (!isAdmin(groupMember.status, groupMember.can_invite_users)) {
        await send(api, sourceChatId, language, "adminRequired");
        return;
      }
      await send(api, sourceChatId, language, "invitePrivateOnly", { groupId: sourceChatId });
      return;
    }

    let chatId = sourceChatId;
    let args = command.args;
    if (privateChat) {
      const target = /^(-?\d+)(?:\s+([\s\S]*))?$/.exec(args);
      const targetId = target ? Number(target[1]) : Number.NaN;
      if (!target || !Number.isSafeInteger(targetId)) {
        await send(api, sourceChatId, userLanguage(message.from, "cn"), "targetRequired");
        return;
      }
      const targetChat = await api.getChat({ chat_id: targetId });
      if (targetChat.type !== "group" && targetChat.type !== "supergroup") {
        await send(api, sourceChatId, userLanguage(message.from, "cn"), "targetNotGroup");
        return;
      }
      chatId = targetId;
      args = target[2]?.trim() ?? "";
    }

    const storedConfig = await repository.getConfig(chatId);
    const config: Config = { ...DEFAULT_CONFIG, ...storedConfig };
    const configuredLanguage = groupLanguage(storedConfig);
    const setupCommand = command.name === "verify_invite";
    const responseLanguage =
      privateChat && setupCommand
        ? userLanguage(message.from, configuredLanguage)
        : configuredLanguage;

    if (message.sender_chat) {
      await send(api, sourceChatId, responseLanguage, "anonymousAdmin");
      return;
    }

    const senderId = message.from?.id;
    if (senderId == null) {
      await send(api, sourceChatId, responseLanguage, "senderUnknown");
      return;
    }

    const member = await api.getChatMember({ chat_id: chatId, user_id: senderId });
    if (!isAdmin(member.status, member.can_invite_users)) {
      await send(api, sourceChatId, responseLanguage, "adminRequired");
      return;
    }

    if (command.name === "verify_help") {
      await send(api, sourceChatId, responseLanguage, privateChat ? "privateHelp" : "help");
      return;
    }

    if (command.name === "verify_status") {
      const me = await api.getMe();
      const botMember = await api.getChatMember({ chat_id: chatId, user_id: me.id });
      const botCanApprove = isAdmin(botMember.status, botMember.can_invite_users);
      const pack = await repository.getContentPack(config.contentId);
      const blocklist = await repository.getBlocklist(DEFAULT_BLOCKLIST_ID);
      const text = adminMessage(responseLanguage, "status", {
        blocklistVersion:
          blocklist && !validateBlocklist(blocklist)
            ? blocklist.version
            : adminMessage(responseLanguage, "noContent"),
        enabled: adminMessage(responseLanguage, config.enabled ? "enabled" : "disabled"),
        botPermission: adminMessage(
          responseLanguage,
          botCanApprove ? "botCanApprove" : "botCannotApprove",
        ),
        chatId,
        packVersion:
          pack && packIsUsable(pack) ? pack.version : adminMessage(responseLanguage, "noContent"),
        rulesVersion:
          pack && packIsUsable(pack)
            ? pack.rules.version
            : adminMessage(responseLanguage, "noContent"),
        config: configText(config, responseLanguage, defaultDeleteJoinMessages, spamDefaults),
      });
      await api.sendMessage({ chat_id: sourceChatId, text });
      return;
    }

    if (command.name === "verify_enable") {
      const pack = await repository.getContentPack(config.contentId);
      if (!packIsUsable(pack)) {
        await send(api, sourceChatId, responseLanguage, "contentRequired");
        return;
      }
      const configError = validateConfig(config);
      if (configError) {
        await send(api, sourceChatId, responseLanguage, "invalidConfig", { error: configError });
        return;
      }
      const me = await api.getMe();
      const botMember = await api.getChatMember({ chat_id: chatId, user_id: me.id });
      if (!isAdmin(botMember.status, botMember.can_invite_users)) {
        await send(api, sourceChatId, responseLanguage, "botNeedsAdmin");
        return;
      }
      config.enabled = true;
      await repository.saveConfig(chatId, config);
      await send(api, sourceChatId, responseLanguage, "enableSuccess");
      return;
    }

    if (command.name === "verify_disable") {
      config.enabled = false;
      await repository.saveConfig(chatId, config);
      await send(api, sourceChatId, responseLanguage, "disableSuccess");
      return;
    }

    if (command.name === "verify_config") {
      if (!args) {
        await api.sendMessage({
          chat_id: sourceChatId,
          text: configText(config, responseLanguage, defaultDeleteJoinMessages, spamDefaults),
        });
        return;
      }
      const updates: Partial<Config> = {};
      for (const token of args.split(/\s+/)) {
        const [key, rawValue, ...extra] = token.split("=");
        if (key === "language") {
          if ((rawValue !== "en" && rawValue !== "cn") || extra.length) {
            await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
            return;
          }
          updates.language = rawValue;
          continue;
        }
        if (key === "deleteJoinMessages") {
          if ((rawValue !== "on" && rawValue !== "off" && rawValue !== "default") || extra.length) {
            await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
            return;
          }
          updates.deleteJoinMessages = rawValue === "default" ? undefined : rawValue === "on";
          continue;
        }
        if (SPAM_KEYS.includes(key as (typeof SPAM_KEYS)[number]) && rawValue === "default") {
          if (extra.length) {
            await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
            return;
          }
          updates[key as (typeof SPAM_KEYS)[number]] = undefined;
          continue;
        }
        if (key === "spamMode") {
          if ((rawValue !== "off" && rawValue !== "new" && rawValue !== "all") || extra.length) {
            await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
            return;
          }
          updates.spamMode = rawValue;
          continue;
        }
        if (key === "spamBan" || key === "spamCas") {
          if ((rawValue !== "on" && rawValue !== "off") || extra.length) {
            await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
            return;
          }
          updates[key] = rawValue === "on";
          continue;
        }
        if (!CONFIG_KEYS.has(key) || rawValue == null || rawValue === "" || extra.length) {
          await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
          return;
        }
        if (!/^[0-9]+$/.test(rawValue)) {
          await send(api, sourceChatId, responseLanguage, "integerRequired", { key });
          return;
        }
        (updates as Record<string, unknown>)[key] = Number(rawValue);
      }
      const next: Config = { ...config, ...updates };
      // "=default" clears a group override so the Worker-wide default applies again.
      for (const key of ["deleteJoinMessages", ...SPAM_KEYS] as const)
        if (next[key] === undefined) delete next[key];
      const error = validateConfig(next);
      if (error) {
        await send(api, sourceChatId, responseLanguage, "invalidConfigUpdate", { error });
        return;
      }
      await repository.saveConfig(chatId, next);
      const newLanguage = groupLanguage(next);
      let text = adminMessage(newLanguage, "configUpdated", {
        config: configText(next, newLanguage, defaultDeleteJoinMessages, spamDefaults),
      });
      if (
        Object.hasOwn(updates, "deleteJoinMessages") &&
        (next.deleteJoinMessages ?? defaultDeleteJoinMessages)
      ) {
        const me = await api.getMe();
        const botMember = await api.getChatMember({ chat_id: chatId, user_id: me.id });
        if (!canDeleteMessages(botMember))
          text += `\n${adminMessage(newLanguage, "botNeedsDeletePermission")}`;
      }
      const spam = spamSettings(next, spamDefaults);
      if (SPAM_KEYS.some((key) => Object.hasOwn(updates, key)) && spam.mode !== "off") {
        const missing = await missingSpamPermissions(chatId, spam.ban, newLanguage);
        if (missing.length)
          text += `\n${adminMessage(newLanguage, "botNeedsSpamPermissions", { permissions: missing.join(", ") })}`;
      }
      await api.sendMessage({ chat_id: sourceChatId, text });
      return;
    }

    if (command.name === "verify_invite") {
      if (!privateChat) {
        await send(api, sourceChatId, responseLanguage, "invitePrivateOnly", { groupId: chatId });
        return;
      }
      const pack = await repository.getContentPack(config.contentId);
      if (!config.enabled || !packIsUsable(pack)) {
        await send(api, sourceChatId, responseLanguage, "inviteNeedsEnabled");
        return;
      }
      const me = await api.getMe();
      const botMember = await api.getChatMember({ chat_id: chatId, user_id: me.id });
      if (!isAdmin(botMember.status, botMember.can_invite_users)) {
        await send(api, sourceChatId, responseLanguage, "botNeedsAdmin");
        return;
      }
      const invite = await api.createChatInviteLink({
        chat_id: chatId,
        name: "verification requests",
        creates_join_request: true,
      });
      await send(api, sourceChatId, responseLanguage, "inviteCreated", {
        inviteLink: invite.invite_link,
      });
      return;
    }
  };
}
