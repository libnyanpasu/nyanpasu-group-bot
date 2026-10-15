/**
 * The commands Telegram shows in its "/" menu. This file is the single source for both the
 * `pnpm commands:set` script and the per-administrator menu the Worker sets when a group is chosen,
 * so it must stay free of Worker-only imports. Menus are display-only: every command still checks
 * the caller's rights itself.
 */
export interface CommandSpec {
  command: string;
  en: string;
  zh: string;
}

/** Telegram shows the default (no `language_code`) list to everyone without a matching language. */
export const COMMAND_LANGUAGES = [
  { code: undefined, key: "en" },
  { code: "zh", key: "zh" },
] as const satisfies readonly { code: "zh" | undefined; key: "en" | "zh" }[];

const START: CommandSpec = {
  command: "start",
  en: "Resume join verification or get started",
  zh: "继续入群验证，或查看使用说明",
};
const HELP: CommandSpec = {
  command: "help",
  en: "How to join a group or manage one",
  zh: "查看入群与群管理说明",
};
const GROUPS: CommandSpec = {
  command: "verify_groups",
  en: "Choose the group to manage",
  zh: "选择要管理的群组",
};
const VERIFY_HELP: CommandSpec = {
  command: "verify_help",
  en: "List the admin commands",
  zh: "查看管理命令列表",
};
const STATUS: CommandSpec = {
  command: "verify_status",
  en: "Show the verification status and next steps",
  zh: "查看入群验证状态和下一步",
};
const CONFIG: CommandSpec = {
  command: "verify_config",
  en: "Open the settings panel or change options",
  zh: "打开设置面板或修改参数",
};
const ENABLE: CommandSpec = {
  command: "verify_enable",
  en: "Turn on join verification",
  zh: "开启入群验证",
};
const DISABLE: CommandSpec = {
  command: "verify_disable",
  en: "Turn off join verification",
  zh: "关闭入群验证",
};
const INVITE: CommandSpec = {
  command: "verify_invite",
  en: "Get an approval invite link (private chat only)",
  zh: "获取审批邀请链接（仅限私聊）",
};

const MANAGEMENT = [STATUS, CONFIG, ENABLE, DISABLE, INVITE, VERIFY_HELP];

/** Everyone in a private chat with the bot. */
export const PRIVATE_COMMANDS: readonly CommandSpec[] = [START, HELP, GROUPS];
/** Administrators inside a group. */
export const GROUP_ADMIN_COMMANDS: readonly CommandSpec[] = [
  VERIFY_HELP,
  ...MANAGEMENT.slice(0, 5),
];
/** One person's private chat once they have chosen a group to manage. */
export const MANAGER_COMMANDS: readonly CommandSpec[] = [...PRIVATE_COMMANDS, ...MANAGEMENT];

/** Menus registered for everyone by `pnpm commands:set`. */
export const COMMAND_SCOPES = [
  { scope: { type: "all_private_chats" }, commands: PRIVATE_COMMANDS },
  { scope: { type: "all_chat_administrators" }, commands: GROUP_ADMIN_COMMANDS },
] as const;

/** The `commands` payload of `setMyCommands` in one language. */
export function botCommands(
  commands: readonly CommandSpec[],
  key: "en" | "zh",
): { command: string; description: string }[] {
  return commands.map((spec) => ({ command: spec.command, description: spec[key] }));
}
