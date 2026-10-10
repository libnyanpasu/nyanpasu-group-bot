import type { BotApi, Config, ContentPack, Language, Message, Repository, User } from "../types.js";
import { adminMessage, type AdminMessageKey } from "./admin-i18n.js";
import { DEFAULT_CONFIG, validateConfig, validateContentPack } from "./quiz.js";

const COMMANDS = new Set([
  "verify_help",
  "verify_status",
  "verify_enable",
  "verify_disable",
  "verify_config",
  "verify_invite",
]);
const CONFIG_KEYS = new Set(["timeoutSeconds", "cooldownSeconds"]);

interface ParsedCommand {
  name: string;
  addressedTo?: string;
  args: string;
}

type AdminApi = Pick<
  BotApi,
  "sendMessage" | "getMe" | "getChat" | "getChatMember" | "createChatInviteLink"
>;
interface AdminOptions {
  api: AdminApi;
  repository: Pick<Repository, "getConfig" | "saveConfig" | "getContentPack">;
}

function commandFrom(text?: string): ParsedCommand | null {
  if (typeof text !== "string") return null;
  const match = /^\/(verify_[a-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text);
  if (!match || !COMMANDS.has(match[1])) return null;
  return { name: match[1], addressedTo: match[2], args: match[3]?.trim() ?? "" };
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

function configText(config: Config, language: Language): string {
  return adminMessage(language, "config", {
    language: config.language,
    timeoutSeconds: config.timeoutSeconds,
    cooldownSeconds: config.cooldownSeconds,
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

export function createAdmin({ api, repository }: AdminOptions) {
  return async function handle(message: Message): Promise<boolean> {
    const command = commandFrom(message.text);
    if (!command) return false;

    if (command.addressedTo) {
      const me = await api.getMe();
      if (command.addressedTo.toLowerCase() !== me.username?.toLowerCase()) return false;
    }

    const sourceChatId = message.chat.id;
    const privateChat = message.chat.type === "private";
    const groupChat = message.chat.type === "group" || message.chat.type === "supergroup";
    if (!privateChat && !groupChat) {
      await send(api, sourceChatId, userLanguage(message.from, "cn"), "unsupportedChat");
      return true;
    }

    if (privateChat && command.name === "verify_help" && !command.args) {
      await send(api, sourceChatId, userLanguage(message.from, "cn"), "privateHelp");
      return true;
    }

    if (groupChat && command.name === "verify_invite") {
      if (message.sender_chat) {
        await send(api, sourceChatId, "cn", "anonymousAdmin");
        return true;
      }
      const senderId = message.from?.id;
      if (senderId == null) {
        await send(api, sourceChatId, "cn", "senderUnknown");
        return true;
      }
      const groupMember = await api.getChatMember({ chat_id: sourceChatId, user_id: senderId });
      const storedConfig = await repository.getConfig(sourceChatId);
      const language = groupLanguage(storedConfig);
      if (!isAdmin(groupMember.status, groupMember.can_invite_users)) {
        await send(api, sourceChatId, language, "adminRequired");
        return true;
      }
      await send(api, sourceChatId, language, "invitePrivateOnly", { groupId: sourceChatId });
      return true;
    }

    let chatId = sourceChatId;
    let args = command.args;
    if (privateChat) {
      const target = /^(-?\d+)(?:\s+([\s\S]*))?$/.exec(args);
      const targetId = target ? Number(target[1]) : Number.NaN;
      if (!target || !Number.isSafeInteger(targetId)) {
        await send(api, sourceChatId, userLanguage(message.from, "cn"), "targetRequired");
        return true;
      }
      const targetChat = await api.getChat({ chat_id: targetId });
      if (targetChat.type !== "group" && targetChat.type !== "supergroup") {
        await send(api, sourceChatId, userLanguage(message.from, "cn"), "targetNotGroup");
        return true;
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
      return true;
    }

    const senderId = message.from?.id;
    if (senderId == null) {
      await send(api, sourceChatId, responseLanguage, "senderUnknown");
      return true;
    }

    const member = await api.getChatMember({ chat_id: chatId, user_id: senderId });
    if (!isAdmin(member.status, member.can_invite_users)) {
      await send(api, sourceChatId, responseLanguage, "adminRequired");
      return true;
    }

    if (command.name === "verify_help") {
      await send(api, sourceChatId, responseLanguage, privateChat ? "privateHelp" : "help");
      return true;
    }

    if (command.name === "verify_status") {
      const me = await api.getMe();
      const botMember = await api.getChatMember({ chat_id: chatId, user_id: me.id });
      const botCanApprove = isAdmin(botMember.status, botMember.can_invite_users);
      const pack = await repository.getContentPack(config.contentId);
      const text = adminMessage(responseLanguage, "status", {
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
        config: configText(config, responseLanguage),
      });
      await api.sendMessage({ chat_id: sourceChatId, text });
      return true;
    }

    if (command.name === "verify_enable") {
      const pack = await repository.getContentPack(config.contentId);
      if (!packIsUsable(pack)) {
        await send(api, sourceChatId, responseLanguage, "contentRequired");
        return true;
      }
      const configError = validateConfig(config);
      if (configError) {
        await send(api, sourceChatId, responseLanguage, "invalidConfig", { error: configError });
        return true;
      }
      const me = await api.getMe();
      const botMember = await api.getChatMember({ chat_id: chatId, user_id: me.id });
      if (!isAdmin(botMember.status, botMember.can_invite_users)) {
        await send(api, sourceChatId, responseLanguage, "botNeedsAdmin");
        return true;
      }
      config.enabled = true;
      await repository.saveConfig(chatId, config);
      await send(api, sourceChatId, responseLanguage, "enableSuccess");
      return true;
    }

    if (command.name === "verify_disable") {
      config.enabled = false;
      await repository.saveConfig(chatId, config);
      await send(api, sourceChatId, responseLanguage, "disableSuccess");
      return true;
    }

    if (command.name === "verify_config") {
      if (!args) {
        await api.sendMessage({
          chat_id: sourceChatId,
          text: configText(config, responseLanguage),
        });
        return true;
      }
      const updates: Partial<Config> = {};
      for (const token of args.split(/\s+/)) {
        const [key, rawValue, ...extra] = token.split("=");
        if (key === "language") {
          if ((rawValue !== "en" && rawValue !== "cn") || extra.length) {
            await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
            return true;
          }
          updates.language = rawValue;
          continue;
        }
        if (!CONFIG_KEYS.has(key) || rawValue == null || rawValue === "" || extra.length) {
          await send(api, sourceChatId, responseLanguage, "argumentFormat", { token });
          return true;
        }
        if (!/^[0-9]+$/.test(rawValue)) {
          await send(api, sourceChatId, responseLanguage, "integerRequired", { key });
          return true;
        }
        (updates as Record<string, unknown>)[key] = Number(rawValue);
      }
      const next: Config = { ...config, ...updates };
      const error = validateConfig(next);
      if (error) {
        await send(api, sourceChatId, responseLanguage, "invalidConfigUpdate", { error });
        return true;
      }
      await repository.saveConfig(chatId, next);
      const newLanguage = groupLanguage(next);
      await api.sendMessage({
        chat_id: sourceChatId,
        text: adminMessage(newLanguage, "configUpdated", {
          config: configText(next, newLanguage),
        }),
      });
      return true;
    }

    if (command.name === "verify_invite") {
      if (!privateChat) {
        await send(api, sourceChatId, responseLanguage, "invitePrivateOnly", { groupId: chatId });
        return true;
      }
      const pack = await repository.getContentPack(config.contentId);
      if (!config.enabled || !packIsUsable(pack)) {
        await send(api, sourceChatId, responseLanguage, "inviteNeedsEnabled");
        return true;
      }
      const me = await api.getMe();
      const botMember = await api.getChatMember({ chat_id: chatId, user_id: me.id });
      if (!isAdmin(botMember.status, botMember.can_invite_users)) {
        await send(api, sourceChatId, responseLanguage, "botNeedsAdmin");
        return true;
      }
      const invite = await api.createChatInviteLink({
        chat_id: chatId,
        name: "verification requests",
        creates_join_request: true,
      });
      await send(api, sourceChatId, responseLanguage, "inviteCreated", {
        inviteLink: invite.invite_link,
      });
      return true;
    }

    return false;
  };
}
