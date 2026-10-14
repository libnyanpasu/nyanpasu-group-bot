import type { Language } from "../types.js";

const messages = {
  cn: {
    unsupportedChat: "此命令只能在群组或私聊中使用。",
    privateHelp: [
      "入群验证管理命令：",
      "/verify_help",
      "/verify_status -100群组ID",
      "/verify_enable -100群组ID",
      "/verify_disable -100群组ID",
      "/verify_config -100群组ID language=cn timeoutSeconds=300 cooldownSeconds=1800 deleteJoinMessages=on",
      "/verify_invite -100群组ID",
      "先打开机器人的私聊并发送 /start。题目和规则由项目维护者通过私有内容仓库提供，不支持通过 Telegram 命令查看或修改。",
    ].join("\n"),
    targetRequired: "请提供群组 ID，例如 /verify_status -1001234567890。",
    targetNotGroup: "目标必须是群组或超级群组。",
    anonymousAdmin: "请用个人账号发送管理命令，匿名管理员暂不支持。",
    senderUnknown: "无法识别发送者，命令未执行。",
    adminRequired: "只有目标群的群主，或拥有邀请成员权限的管理员，才能使用此命令。",
    help: [
      "入群验证管理命令：",
      "/verify_status 查看群组 ID、验证状态及题库/规则版本",
      "/verify_enable 开启验证（需先配置机器人和私有内容包）",
      "/verify_disable 关闭新申请验证",
      "/verify_config 查看或设置语言、时限及是否删除入群提示，例如 /verify_config language=cn timeoutSeconds=300 cooldownSeconds=1800 deleteJoinMessages=on",
      "/verify_invite 获取私密审批邀请链接：先私聊机器人发送 /start，再私聊发送 /verify_invite -100群组ID",
      "题目和规则由项目维护者通过私有内容仓库提供，不能通过 Telegram 命令查看或修改。",
    ].join("\n"),
    invitePrivateOnly:
      "为避免邀请链接公开，请先私聊机器人发送 /start，然后在私聊中发送 /verify_invite {groupId}。",
    status:
      "群组 ID：{chatId}\n入群验证：{enabled}\n机器人可处理入群申请：{botPermission}\n题库版本：{packVersion}\n规则版本：{rulesVersion}\n{config}",
    enabled: "已开启",
    disabled: "已关闭",
    botCanApprove: "是",
    botCannotApprove: "否（需授予邀请成员权限）",
    config:
      "语言：{language}\n答题时限：{timeoutSeconds} 秒\n失败冷却：{cooldownSeconds} 秒\n删除入群提示：{deleteJoinMessages}",
    on: "开启",
    off: "关闭",
    globalDefault: "{value}（全局默认）",
    botNeedsDeletePermission: "注意：机器人还没有删除消息权限，入群提示不会被删除。",
    noContent: "未配置",
    contentRequired: "当前群组没有有效的私有题目和规则包，无法开启验证。",
    invalidConfig: "当前配置无效：{error}",
    botNeedsAdmin: "机器人需要先成为群管理员并获得邀请成员权限。",
    enableSuccess: "入群验证已开启。",
    disableSuccess: "入群验证已关闭；新申请不会进入验证流程。",
    argumentFormat:
      "参数格式错误：{token}\n可设置：language=en|cn, timeoutSeconds, cooldownSeconds, deleteJoinMessages=on|off|default",
    integerRequired: "{key} 必须是非负整数。",
    invalidConfigUpdate: "配置无效：{error}",
    configUpdated: "验证参数已更新。\n{config}",
    inviteNeedsEnabled: "请先为该群配置有效内容包并使用 /verify_enable 开启验证。",
    inviteCreated: "已创建仅供入群申请使用的邀请链接：\n{inviteLink}\n请只在私聊中转发此链接。",
  },
  en: {
    unsupportedChat: "Use this command in a group or in a private chat with a group ID.",
    privateHelp: [
      "Group verification commands:",
      "/verify_help",
      "/verify_status -100GROUP_ID",
      "/verify_enable -100GROUP_ID",
      "/verify_disable -100GROUP_ID",
      "/verify_config -100GROUP_ID language=en timeoutSeconds=300 cooldownSeconds=1800 deleteJoinMessages=on",
      "/verify_invite -100GROUP_ID",
      "Open the bot's private chat and send /start first. Questions and rules are supplied by maintainers through the private content repository; Telegram commands cannot view or edit them.",
    ].join("\n"),
    targetRequired: "Add a group ID, for example /verify_status -1001234567890.",
    targetNotGroup: "The target must be a group or supergroup.",
    anonymousAdmin:
      "Send admin commands from your personal account; anonymous admins are not supported.",
    senderUnknown: "Could not identify the sender. The command was not applied.",
    adminRequired:
      "Only the group owner or an administrator with permission to invite users can use this command.",
    help: [
      "Group verification commands:",
      "/verify_status — show group ID, verification state, and content/rules versions",
      "/verify_enable — enable verification (the bot and private content pack must be configured first)",
      "/verify_disable — stop verifying new requests",
      "/verify_config — view or set language, timeouts and join-message deletion, e.g. /verify_config language=en timeoutSeconds=300 cooldownSeconds=1800 deleteJoinMessages=on",
      "/verify_invite — get a private approval invite link: send /start to the bot privately, then /verify_invite -100GROUP_ID",
      "Questions and rules are supplied by maintainers through the private content repository and cannot be viewed or edited with Telegram commands.",
    ].join("\n"),
    invitePrivateOnly:
      "To keep the invite link private, start the bot in a private chat, then send /verify_invite {groupId} there.",
    status:
      "Group ID: {chatId}\nJoin verification: {enabled}\nBot can process join requests: {botPermission}\nQuestion pack version: {packVersion}\nRules version: {rulesVersion}\n{config}",
    enabled: "Enabled",
    disabled: "Disabled",
    botCanApprove: "Yes",
    botCannotApprove: "No (grant the bot permission to invite users)",
    config:
      "Language: {language}\nQuiz time limit: {timeoutSeconds} seconds\nFailure cooldown: {cooldownSeconds} seconds\nDelete join messages: {deleteJoinMessages}",
    on: "On",
    off: "Off",
    globalDefault: "{value} (global default)",
    botNeedsDeletePermission:
      "Note: the bot cannot delete messages yet, so join messages will stay. Grant it the delete-messages permission.",
    noContent: "Not configured",
    contentRequired:
      "This group has no valid private questions and rules pack, so verification cannot be enabled.",
    invalidConfig: "The current configuration is invalid: {error}",
    botNeedsAdmin:
      "Make the bot a group administrator and grant it permission to invite users first.",
    enableSuccess: "Join verification is enabled.",
    disableSuccess:
      "Join verification is disabled; new requests will not enter the verification flow.",
    argumentFormat:
      "Invalid option: {token}\nSupported options: language=en|cn, timeoutSeconds, cooldownSeconds, deleteJoinMessages=on|off|default",
    integerRequired: "{key} must be a non-negative integer.",
    invalidConfigUpdate: "Invalid configuration: {error}",
    configUpdated: "Verification settings updated.\n{config}",
    inviteNeedsEnabled:
      "Configure a valid private content pack and run /verify_enable for this group first.",
    inviteCreated:
      "Created an invite link that requires an approval request:\n{inviteLink}\nShare this link only in private.",
  },
} satisfies Record<Language, Record<string, string>>;

export type AdminMessageKey = keyof typeof messages.cn;

export function adminMessage(
  language: Language,
  key: AdminMessageKey,
  values: Record<string, string | number> = {},
): string {
  return messages[language][key].replace(/\{([A-Za-z]+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
