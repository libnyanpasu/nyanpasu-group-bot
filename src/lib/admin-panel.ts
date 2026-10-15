import type { Config, InlineKeyboardButton, Language } from "../types.js";
import { adminMessage, type AdminMessageKey } from "./admin-i18n.js";
import { type SpamSettings, spamSettings } from "./spam.js";

/** Panel buttons: `c:<groupRef>:<action>` stays far below Telegram's 64-byte callback_data limit. */
const PANEL_CALLBACK = /^c:([sg]\d{1,13}):([a-z]{2})$/;
export const PANEL_ACTIONS = ["en", "lg", "dj", "sm", "sb", "sc", "to", "cd", "iv", "rf"] as const;
export type PanelAction = (typeof PANEL_ACTIONS)[number];

export const TIMEOUT_PRESETS = [120, 300, 600] as const;
export const COOLDOWN_PRESETS = [600, 1800, 3600] as const;

export function panelCallbackData(groupRef: string, action: PanelAction): string {
  return `c:${groupRef}:${action}`;
}

/** Parse button data; null for anything that is not a well-formed panel action. */
export function parsePanelCallback(data: string | undefined): {
  groupRef: string;
  action: PanelAction;
} | null {
  const match = data === undefined ? null : PANEL_CALLBACK.exec(data);
  const action = match?.[2] as PanelAction | undefined;
  return match && action && PANEL_ACTIONS.includes(action) ? { groupRef: match[1], action } : null;
}

/** Step through `values`, wrapping at the end; an unknown current value starts at the first. */
function next<T>(values: readonly T[], current: T): T {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length];
}

/**
 * Apply one setting button to a config. `on → off → default` cycles clear the override (undefined)
 * last; `en` and `iv` need Telegram checks and are handled by the caller.
 */
export function cycleSetting(config: Config, action: PanelAction): Config {
  const updated: Config = { ...config };
  const tri = (value: boolean | undefined) =>
    next<boolean | undefined>([true, false, undefined], value);
  switch (action) {
    case "lg":
      updated.language = config.language === "en" ? "cn" : "en";
      break;
    case "dj":
      updated.deleteJoinMessages = tri(config.deleteJoinMessages);
      break;
    case "sm":
      updated.spamMode = next<Config["spamMode"]>(
        ["off", "new", "all", undefined],
        config.spamMode,
      );
      break;
    case "sb":
      updated.spamBan = tri(config.spamBan);
      break;
    case "sc":
      updated.spamCas = tri(config.spamCas);
      break;
    case "to":
      updated.timeoutSeconds = next<number>(TIMEOUT_PRESETS, config.timeoutSeconds);
      break;
    case "cd":
      updated.cooldownSeconds = next<number>(COOLDOWN_PRESETS, config.cooldownSeconds);
      break;
    default:
      break;
  }
  // An unset override is stored as an absent field, never as `undefined`.
  for (const key of ["deleteJoinMessages", "spamMode", "spamBan", "spamCas"] as const)
    if (updated[key] === undefined) delete updated[key];
  return updated;
}

/** What the bot may do in the group, for deciding which hints still apply. */
export interface BotPermissions {
  canApprove: boolean;
  canDelete: boolean;
  canRestrict: boolean;
}

const MAX_HINTS = 3;

/** The next things an administrator should do, most blocking first, at most three. */
export function nextSteps(input: {
  config: Config;
  bot: BotPermissions;
  packUsable: boolean;
  /** `/verify_invite` only works in a private chat, so group replies leave that hint out. */
  privateChat: boolean;
  defaultDeleteJoinMessages: boolean;
  spamDefaults: SpamSettings;
}): AdminMessageKey[] {
  const { config, bot, packUsable, privateChat } = input;
  const spam = spamSettings(config, input.spamDefaults);
  const deletes =
    (config.deleteJoinMessages ?? input.defaultDeleteJoinMessages) || spam.mode !== "off";
  const hints: AdminMessageKey[] = [];
  if (!packUsable) hints.push("hintContent");
  if (!bot.canApprove) hints.push("hintBotAdmin");
  if (packUsable && bot.canApprove && !config.enabled) hints.push("hintEnable");
  if (packUsable && bot.canApprove && config.enabled && privateChat) hints.push("hintInvite");
  if (deletes && !bot.canDelete) hints.push("hintDeletePermission");
  if (spam.mode !== "off" && spam.ban && !bot.canRestrict) hints.push("hintRestrictPermission");
  return hints.slice(0, MAX_HINTS);
}

/** The "Next steps" block, with its leading blank line; empty when nothing is left to do. */
export function hintsText(language: Language, hints: AdminMessageKey[]): string {
  if (hints.length === 0) return "";
  return `\n\n${adminMessage(language, "hintsHeader")}\n${hints
    .map((key) => `- ${adminMessage(language, key)}`)
    .join("\n")}`;
}

/** The inline keyboard under the settings panel, with values shown in the viewer's language. */
export function panelKeyboard(input: {
  language: Language;
  config: Config;
  groupRef: string;
  defaultDeleteJoinMessages: boolean;
  spamDefaults: SpamSettings;
}): InlineKeyboardButton[][] {
  const { language, config, groupRef } = input;
  const spam = spamSettings(config, input.spamDefaults);
  const toggle = (on: boolean) => adminMessage(language, on ? "on" : "off");
  const inherited = (value: string, isDefault: boolean) =>
    isDefault ? `${value} (${adminMessage(language, "valueDefault")})` : value;
  const button = (
    action: PanelAction,
    key: AdminMessageKey,
    value?: string,
  ): InlineKeyboardButton => ({
    text: adminMessage(language, key, value === undefined ? {} : { value }),
    callback_data: panelCallbackData(groupRef, action),
  });
  const seconds = (count: number) => adminMessage(language, "valueSeconds", { count });
  const spamMode =
    spam.mode === "new"
      ? adminMessage(language, "valueSpamNew", { count: spam.firstMessages })
      : spam.mode === "all"
        ? adminMessage(language, "valueSpamAll")
        : adminMessage(language, "off");

  return [
    [button("en", config.enabled ? "buttonDisable" : "buttonEnable")],
    [
      button("lg", "buttonLanguage", config.language === "en" ? "English" : "简体中文"),
      button(
        "dj",
        "buttonDeleteJoin",
        inherited(
          toggle(config.deleteJoinMessages ?? input.defaultDeleteJoinMessages),
          config.deleteJoinMessages === undefined,
        ),
      ),
    ],
    [button("sm", "buttonSpamMode", inherited(spamMode, config.spamMode === undefined))],
    [
      button("sb", "buttonSpamBan", inherited(toggle(spam.ban), config.spamBan === undefined)),
      button("sc", "buttonSpamCas", inherited(toggle(spam.cas), config.spamCas === undefined)),
    ],
    [
      button("to", "buttonTimeout", seconds(config.timeoutSeconds)),
      button("cd", "buttonCooldown", seconds(config.cooldownSeconds)),
    ],
    [button("iv", "buttonInvite"), button("rf", "buttonRefresh")],
  ];
}
