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
      "First request to join the group using its invite link. Complete the private verification before the deadline. Send /start to resume without resetting your progress.",
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
      "请先通过群组邀请链接申请入群，再在截止时间前完成私聊验证。发送 /start 可恢复验证，进度和时限不会重置。",
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

export function t(
  language: Language,
  key: CoreKey,
  values: Record<string, string | number> = {},
): string {
  return messages[language][key].replace(/\{([a-zA-Z]+)\}/g, (token, name: string) => {
    return Object.hasOwn(values, name) ? String(values[name]) : token;
  });
}

export function detectLanguage(languageCode?: string | null): Language {
  return /^en(?:[-_]|$)/i.test(languageCode?.trim() ?? "") ? "en" : "cn";
}
