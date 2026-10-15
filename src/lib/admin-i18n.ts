import type { Language } from "../types.js";
import { interpolate } from "./i18n.js";

const messages = {
  cn: {
    unsupportedChat: "此命令只能在群组中，或在与机器人的私聊中使用。",
    privateHelp: [
      "入群验证管理命令：",
      "/verify_groups 选择要管理的群组",
      "/verify_status 查看所选群组的状态",
      "/verify_config 打开设置面板；也可直接设置参数，例如 /verify_config timeoutSeconds=300 cooldownSeconds=1800 deleteJoinMessages=on",
      "/verify_enable 开启所选群组的验证",
      "/verify_disable 关闭所选群组的验证",
      "/verify_invite 获取所选群组的私密审批邀请链接",
      "以上命令作用于已选择的群组；也可在命令后直接加群组 ID，例如 /verify_status -1001234567890。",
      "题目和规则由项目维护者通过私有内容仓库提供，不能通过 Telegram 命令查看或修改。",
    ].join("\n"),
    targetRequired:
      "尚未选择群组，请发送 /verify_groups 选择群组，或在命令后添加群组 ID，例如 /verify_status -1001234567890。",
    targetNotGroup: "目标必须是群组或超级群组。",
    anonymousAdmin:
      "机器人无法识别匿名管理员的身份。请点击下方按钮（或使用个人账号），在私聊中管理此群组。",
    senderUnknown: "无法识别发送者，命令未执行。",
    adminRequired: "只有目标群的群主，或拥有邀请成员权限的管理员，才能使用此命令。",
    targetUnavailable:
      "未找到该群组，机器人不在该群组中，或你不是其群主或拥有邀请成员权限的管理员。",
    help: [
      "入群验证管理命令：",
      "/verify_status 查看群组 ID、验证状态及题库/规则版本",
      "/verify_enable 开启验证（需先配置机器人和私有内容包）",
      "/verify_disable 关闭新申请验证",
      "/verify_config 查看或设置语言、时限及是否删除入群提示，例如 /verify_config language=cn timeoutSeconds=300 cooldownSeconds=1800 deleteJoinMessages=on",
      "/verify_config spamMode=new spamFirstMessages=3 spamBan=on spamCas=on 开启垃圾消息过滤：spamMode=off|new|all 分别为关闭、只查新成员前 N 条消息、检查所有消息；设为 default 则跟随全局默认",
      "/verify_invite 获取私密审批邀请链接；邀请链接只在私聊中提供，请点击 /verify_help 下方的按钮，或私聊机器人并发送 /verify_groups 选择群组。",
      "题目和规则由项目维护者通过私有内容仓库提供，不能通过 Telegram 命令查看或修改。",
    ].join("\n"),
    invitePrivateOnly:
      "为避免邀请链接公开，请点击下方按钮打开与机器人的私聊，选择此群组后在私聊中发送 /verify_invite。",
    status:
      "群组 ID：{chatId}\n入群验证：{enabled}\n机器人可处理入群申请：{botPermission}\n题库版本：{packVersion}\n规则版本：{rulesVersion}\n垃圾消息词库版本：{blocklistVersion}\n{config}",
    enabled: "已开启",
    disabled: "已关闭",
    botCanApprove: "是",
    botCannotApprove: "否（需授予邀请成员权限）",
    config:
      "语言：{language}\n答题时限：{timeoutSeconds} 秒\n失败冷却：{cooldownSeconds} 秒\n删除入群提示：{deleteJoinMessages}\n垃圾消息过滤：{spamMode}\n命中封禁词时封禁：{spamBan}\nCAS 联合封禁库：{spamCas}",
    spamModeNew: "仅检查新成员前 {count} 条消息",
    spamModeAll: "检查所有消息",
    botNeedsSpamPermissions: "注意：机器人缺少以下权限，垃圾消息过滤无法完全生效：{permissions}。",
    permissionDelete: "删除消息",
    permissionRestrict: "封禁成员",
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
      "参数格式错误：{token}\n可设置：language=en|cn, timeoutSeconds, cooldownSeconds, deleteJoinMessages=on|off|default, spamMode=off|new|all, spamFirstMessages, spamBan=on|off, spamCas=on|off（均可设为 default）\n示例：/verify_config timeoutSeconds=300 deleteJoinMessages=on",
    integerRequired: "{key} 必须是非负整数。",
    invalidConfigUpdate: "配置无效：{error}",
    configUpdated: "验证参数已更新。\n{config}",
    inviteNeedsEnabled: "请先为该群配置有效内容包并使用 /verify_enable 开启验证。",
    inviteCreated: "已创建仅供入群申请使用的邀请链接：\n{inviteLink}\n请只在私聊中转发此链接。",
    groupsPrompt: "请点击下方按钮，选择你管理的群组。机器人必须已经在该群组中。",
    groupsCurrent:
      "当前管理：{title}（{groupId}）。点击按钮可切换，或发送 /verify_groups clear 停止管理。",
    groupsButton: "选择群组",
    groupsCleared: "已清除群组选择。",
    groupsPrivateOnly: "请在与机器人的私聊中选择要管理的群组，点击下方按钮即可前往。",
    groupSelected:
      "现在管理：{title}（{groupId}）。之后的命令无需再提供群组 ID；若 24 小时内没有任何操作，此选择将被清除。",
    groupSelectFailed:
      "无法选择该群组：你必须是其群主或拥有邀请成员权限的管理员，且机器人必须已是群成员。",
    manageButton: "在私聊中管理",
    panel: "正在管理：{title}（{groupId}）\n入群验证：{enabled}\n{config}{hints}",
    hintsHeader: "下一步：",
    hintEnable: "发送 /verify_enable（或点击按钮）开启入群申请验证。",
    hintInvite:
      "在此私聊中发送 /verify_invite（或点击按钮）获取审批邀请链接，并且只在私聊中分享；旧的普通邀请链接会绕过验证。",
    hintBotAdmin: "将机器人设为群管理员，并授予邀请成员权限。",
    hintDeletePermission: "授予机器人删除消息权限，以便删除入群提示或垃圾消息。",
    hintRestrictPermission: "授予机器人封禁成员权限，以便封禁垃圾消息发送者。",
    hintContent: "当前没有有效的题目和规则包，请联系机器人维护者推送。",
    buttonEnable: "开启验证",
    buttonDisable: "关闭验证",
    buttonLanguage: "语言：{value}",
    buttonDeleteJoin: "删除入群提示：{value}",
    buttonSpamMode: "垃圾消息过滤：{value}",
    buttonSpamBan: "命中封禁词时封禁：{value}",
    buttonSpamCas: "CAS 联合封禁库：{value}",
    buttonTimeout: "答题时限：{value}",
    buttonCooldown: "失败冷却：{value}",
    buttonInvite: "获取邀请链接",
    buttonRefresh: "刷新",
    valueDefault: "默认",
    valueSeconds: "{count} 秒",
    valueSpamNew: "前 {count} 条",
    valueSpamAll: "所有消息",
    toastUpdated: "已更新。",
    toastDenied: "你已不再是此群组的管理员。",
    toastStale: "此面板已过期，请发送 /verify_config 打开新面板。",
    toastInvalid: "此按钮无效。",
    toastFailed: "无法更改：{error}",
    toastInviteSent: "邀请链接已作为新消息发送。",
  },
  en: {
    unsupportedChat: "Use this command in a group, or in a private chat with the bot.",
    privateHelp: [
      "Group verification commands:",
      "/verify_groups — choose the group to manage",
      "/verify_status — show the selected group's status",
      "/verify_config — open the settings panel; text options also work, e.g. /verify_config timeoutSeconds=300 cooldownSeconds=1800 deleteJoinMessages=on",
      "/verify_enable — enable verification for the selected group",
      "/verify_disable — disable verification for the selected group",
      "/verify_invite — get the selected group's private approval invite link",
      "These commands act on the selected group; or add a group ID right after the command, e.g. /verify_status -1001234567890.",
      "Questions and rules are supplied by maintainers through the private content repository and cannot be viewed or edited with Telegram commands.",
    ].join("\n"),
    targetRequired:
      "No group selected yet. Send /verify_groups to choose one, or add the group ID after the command, for example /verify_status -1001234567890.",
    targetNotGroup: "The target must be a group or supergroup.",
    anonymousAdmin:
      "The bot cannot tell who an anonymous admin is. Tap the button below (or use a personal account) to manage the group in a private chat.",
    senderUnknown: "Could not identify the sender. The command was not applied.",
    adminRequired:
      "Only the group owner or an administrator with permission to invite users can use this command.",
    targetUnavailable:
      "The group was not found, the bot is not in it, or you are not its owner or an administrator with permission to invite users.",
    help: [
      "Group verification commands:",
      "/verify_status — show group ID, verification state, and content/rules versions",
      "/verify_enable — enable verification (the bot and private content pack must be configured first)",
      "/verify_disable — stop verifying new requests",
      "/verify_config — view or set language, timeouts and join-message deletion, e.g. /verify_config language=en timeoutSeconds=300 cooldownSeconds=1800 deleteJoinMessages=on",
      "/verify_config spamMode=new spamFirstMessages=3 spamBan=on spamCas=on — enable the spam filter; spamMode=off|new|all means off, only a new member's first N messages, or every message; default follows the global default",
      "/verify_invite — get an approval invite link. Links are only given in a private chat: tap the button under /verify_help, or open the bot privately and send /verify_groups.",
      "Questions and rules are supplied by maintainers through the private content repository and cannot be viewed or edited with Telegram commands.",
    ].join("\n"),
    invitePrivateOnly:
      "To keep the invite link private, open a private chat with the bot (button below), choose this group and send /verify_invite there.",
    status:
      "Group ID: {chatId}\nJoin verification: {enabled}\nBot can process join requests: {botPermission}\nQuestion pack version: {packVersion}\nRules version: {rulesVersion}\nSpam blocklist version: {blocklistVersion}\n{config}",
    enabled: "Enabled",
    disabled: "Disabled",
    botCanApprove: "Yes",
    botCannotApprove: "No (grant the bot permission to invite users)",
    config:
      "Language: {language}\nQuiz time limit: {timeoutSeconds} seconds\nFailure cooldown: {cooldownSeconds} seconds\nDelete join messages: {deleteJoinMessages}\nSpam filter: {spamMode}\nBan on ban-list matches: {spamBan}\nCAS ban list: {spamCas}",
    spamModeNew: "first {count} messages of new members",
    spamModeAll: "every message",
    botNeedsSpamPermissions:
      "Note: the spam filter cannot fully work until the bot has these permissions: {permissions}.",
    permissionDelete: "delete messages",
    permissionRestrict: "ban users",
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
      "Invalid option: {token}\nSupported options: language=en|cn, timeoutSeconds, cooldownSeconds, deleteJoinMessages=on|off|default, spamMode=off|new|all, spamFirstMessages, spamBan=on|off, spamCas=on|off (each also accepts default)\nExample: /verify_config timeoutSeconds=300 deleteJoinMessages=on",
    integerRequired: "{key} must be a non-negative integer.",
    invalidConfigUpdate: "Invalid configuration: {error}",
    configUpdated: "Verification settings updated.\n{config}",
    inviteNeedsEnabled:
      "Configure a valid private content pack and run /verify_enable for this group first.",
    inviteCreated:
      "Created an invite link that requires an approval request:\n{inviteLink}\nShare this link only in private.",
    groupsPrompt:
      "Tap the button below to choose a group you manage. The bot must already be in the group.",
    groupsCurrent:
      "Currently managing: {title} ({groupId}). Tap the button to switch, or send /verify_groups clear to stop.",
    groupsButton: "Choose a group",
    groupsCleared: "Group selection cleared.",
    groupsPrivateOnly:
      "Choose which group to manage in a private chat with the bot. Tap the button below to open it.",
    groupSelected:
      "Now managing {title} ({groupId}). Commands no longer need a group ID. The selection is kept for 24 hours of inactivity.",
    groupSelectFailed:
      "This group could not be selected. You must be its owner or an administrator who can invite users, and the bot must be a member.",
    manageButton: "Manage in private chat",
    panel: "Managing: {title} ({groupId})\nJoin verification: {enabled}\n{config}{hints}",
    hintsHeader: "Next steps:",
    hintEnable: "Run /verify_enable (or tap Enable) to start verifying join requests.",
    hintInvite:
      "Get the approval invite link with /verify_invite in this chat (or tap the button) and share it only in private; old regular invite links bypass verification.",
    hintBotAdmin: "Make the bot a group administrator with permission to invite users.",
    hintDeletePermission:
      "Grant the bot the delete-messages permission so join notices and spam can be removed.",
    hintRestrictPermission: "Grant the bot the ban-users permission so spam senders can be banned.",
    hintContent: "No valid question pack is configured; ask the bot maintainer to push one.",
    buttonEnable: "Enable verification",
    buttonDisable: "Disable verification",
    buttonLanguage: "Language: {value}",
    buttonDeleteJoin: "Join notices deleted: {value}",
    buttonSpamMode: "Spam filter: {value}",
    buttonSpamBan: "Ban on match: {value}",
    buttonSpamCas: "CAS ban list: {value}",
    buttonTimeout: "Time limit: {value}",
    buttonCooldown: "Cooldown: {value}",
    buttonInvite: "Get invite link",
    buttonRefresh: "Refresh",
    valueDefault: "default",
    valueSeconds: "{count}s",
    valueSpamNew: "first {count} msgs",
    valueSpamAll: "all messages",
    toastUpdated: "Updated.",
    toastDenied: "You are no longer an administrator of this group.",
    toastStale: "This panel is out of date, send /verify_config to open a new one.",
    toastInvalid: "This button is not valid.",
    toastFailed: "Cannot change: {error}",
    toastInviteSent: "The invite link was sent as a new message.",
  },
} satisfies Record<Language, Record<string, string>>;

export type AdminMessageKey = keyof typeof messages.cn;

export function adminMessage(
  language: Language,
  key: AdminMessageKey,
  values: Record<string, string | number> = {},
): string {
  return interpolate(messages[language][key], values);
}
