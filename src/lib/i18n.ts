import type { Language } from "../types.js";

export const messages = {
  en: {
    approved: "{title}\nYour join request has been approved.",
    declined:
      "{title}: verification failed or expired. Submit a new join request after the cooldown.",
    pending: "{title}: your request is being processed. Send /start to retry.",
    invalidButton: "This button is invalid or has expired.",
    updatedButton: "This button was updated. Send /start to resume verification.",
    staleButton: "This action is no longer current.",
    recorded: "Your response has been recorded.",
    startHelp:
      "To join, request to join the group through its invite link, then complete the private verification before the deadline. Send /start to resume without resetting your progress.",
    startAdmin:
      "To manage a group, add this bot as an administrator with permission to invite users. Then send /verify_groups to choose the group and /verify_config to open the settings panel.",
    startManaging:
      "You are managing {title}. Send /verify_config for the settings panel, /verify_status for its status, or /verify_groups to switch group.",
    startNotAdmin:
      "That group link is not valid for you: you are not an administrator there, or the bot is not in the group.",
    startRecentlyApproved: "{title}: your join request was approved recently. Welcome!",
    question:
      "{title}\n\nGroup rules (version {version}):\n{rules}\n\nVerification question (candidate {current}/{total})\n{prompt}\n{choices}\n\nAnswer one question correctly to join. Choosing an answer accepts these rules; a wrong answer declines your request. You may skip up to two questions; skipping does not record agreement.\nFinish before {deadline} (UTC).",
    choice: "{letter}. {option}",
    answerButton: "Agree to rules and choose {letter}",
    refreshButton: "Skip question ({remaining} left)",
    cooldown: "You can try again in {seconds} seconds.",
    processing: "Your request is being processed. Please wait.",
  },
  cn: {
    approved: "{title}：入群申请已通过。",
    declined: "{title}：验证失败或已超时，请在冷却结束后重新申请入群。",
    pending: "{title}：入群申请正在处理中，可发送 /start 重试。",
    invalidButton: "此按钮无效或已过期。",
    updatedButton: "按钮已更新，请发送 /start 恢复验证。",
    staleButton: "此操作已不是当前步骤。",
    recorded: "操作已记录。",
    startHelp:
      "请先通过群组邀请链接提交入群申请，再在截止时间前完成私聊验证。发送 /start 可恢复验证，进度和时限不会重置。",
    startAdmin:
      "如需管理群组，请先将本机器人设为群管理员并授予邀请成员权限，然后发送 /verify_groups 选择群组，再发送 /verify_config 打开设置面板。",
    startManaging:
      "你正在管理 {title}。发送 /verify_config 打开设置面板，发送 /verify_status 查看状态，或发送 /verify_groups 切换群组。",
    startNotAdmin: "该群组链接对你无效：你不是该群组的管理员，或机器人不在该群组中。",
    startRecentlyApproved: "{title}：你的入群申请近期已通过。欢迎加入！",
    question:
      "{title}\n\n群规（版本 {version}）：\n{rules}\n\n验证题（候选 {current}/{total}）\n{prompt}\n{choices}\n\n答对一题即可入群。点击答案即同意以上群规，答错将拒绝申请；最多换题两次，换题不代表同意。\n请在 {deadline}（UTC）前完成。",
    choice: "{letter}. {option}",
    answerButton: "同意群规并选择 {letter}",
    refreshButton: "跳过此题（还可用 {remaining} 次）",
    cooldown: "请等待 {seconds} 秒后再试。",
    processing: "正在处理你的申请，请稍候。",
  },
} as const;

export type CoreKey = keyof typeof messages.en;

/** Fill `{name}` placeholders; unknown placeholders stay visible. */
export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (token, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : token,
  );
}

export function t(
  language: Language,
  key: CoreKey,
  values: Record<string, string | number> = {},
): string {
  return interpolate(messages[language][key], values);
}

export function detectLanguage(languageCode?: string | null): Language {
  return /^en(?:[-_]|$)/i.test(languageCode?.trim() ?? "") ? "en" : "cn";
}
