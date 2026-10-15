import { describe, expect, it } from "vitest";
import type { Config } from "../src/types.js";

import {
  PANEL_ACTIONS,
  cycleSetting,
  hintsText,
  nextSteps,
  parsePanelCallback,
} from "../src/lib/admin-panel.js";
import { DEFAULT_CONFIG } from "../src/lib/quiz.js";
import { DEFAULT_SPAM_SETTINGS } from "../src/lib/spam.js";

const allowed = { canApprove: true, canDelete: true, canRestrict: true };

function steps(
  config: Partial<Config> = {},
  overrides: Partial<Parameters<typeof nextSteps>[0]> = {},
) {
  return nextSteps({
    config: { ...DEFAULT_CONFIG, ...config },
    bot: allowed,
    packUsable: true,
    privateChat: true,
    defaultDeleteJoinMessages: false,
    spamDefaults: DEFAULT_SPAM_SETTINGS,
    ...overrides,
  });
}

describe("parsePanelCallback", () => {
  it("accepts every known action for supergroup and basic group references", () => {
    for (const action of PANEL_ACTIONS) {
      expect(parsePanelCallback(`c:s1234567890:${action}`)).toEqual({
        groupRef: "s1234567890",
        action,
      });
    }
    expect(parsePanelCallback("c:g100123:en")).toEqual({ groupRef: "g100123", action: "en" });
  });

  it("rejects malformed data, unknown actions and quiz buttons", () => {
    for (const data of [
      undefined,
      "",
      "q:abc:1",
      "c:x1:en",
      "c:s:en",
      "c:s1:zz",
      "c:s1:en:extra",
      "c:s12345678901234:en",
      "c:s1:EN",
    ]) {
      expect(parsePanelCallback(data), String(data)).toBeNull();
    }
  });
});

describe("cycleSetting", () => {
  const base: Config = { ...DEFAULT_CONFIG };

  it("toggles the language", () => {
    expect(cycleSetting(base, "lg").language).toBe("en");
    expect(cycleSetting({ ...base, language: "en" }, "lg").language).toBe("cn");
  });

  it("walks on → off → default for boolean overrides, never storing undefined", () => {
    let config = base;
    const seen: unknown[] = [];
    for (let i = 0; i < 4; i += 1) {
      config = cycleSetting(config, "dj");
      seen.push(config.deleteJoinMessages);
      expect(Object.hasOwn(config, "deleteJoinMessages")).toBe(
        config.deleteJoinMessages !== undefined,
      );
    }
    expect(seen).toEqual([true, false, undefined, true]);
    expect(cycleSetting(base, "sb").spamBan).toBe(true);
    expect(cycleSetting({ ...base, spamCas: false }, "sc")).not.toHaveProperty("spamCas");
  });

  it("walks the spam mode through off, new, all and back to the default", () => {
    let config = base;
    const seen: unknown[] = [];
    for (let i = 0; i < 5; i += 1) {
      config = cycleSetting(config, "sm");
      seen.push(config.spamMode);
    }
    expect(seen).toEqual(["off", "new", "all", undefined, "off"]);
  });

  it("steps through presets and restarts from the first for custom values", () => {
    expect(cycleSetting({ ...base, timeoutSeconds: 120 }, "to").timeoutSeconds).toBe(300);
    expect(cycleSetting({ ...base, timeoutSeconds: 600 }, "to").timeoutSeconds).toBe(120);
    expect(cycleSetting({ ...base, timeoutSeconds: 45 }, "to").timeoutSeconds).toBe(120);
    expect(cycleSetting({ ...base, cooldownSeconds: 3600 }, "cd").cooldownSeconds).toBe(600);
    expect(cycleSetting({ ...base, cooldownSeconds: 7 }, "cd").cooldownSeconds).toBe(600);
  });

  it("does not mutate its input and ignores non-setting actions", () => {
    const input = { ...base };
    cycleSetting(input, "lg");
    expect(input).toEqual(base);
    expect(cycleSetting(base, "rf")).toEqual(base);
  });
});

describe("nextSteps", () => {
  it("asks for content first, then bot rights, then enabling, then the invite link", () => {
    expect(steps({}, { packUsable: false, bot: { ...allowed, canApprove: false } })).toEqual([
      "hintContent",
      "hintBotAdmin",
    ]);
    expect(steps({}, { bot: { ...allowed, canApprove: false } })).toEqual(["hintBotAdmin"]);
    expect(steps({ enabled: false })).toEqual(["hintEnable"]);
    expect(steps({ enabled: true })).toEqual(["hintInvite"]);
  });

  it("omits the invite hint in group chats, where links are never given", () => {
    expect(steps({ enabled: true }, { privateChat: false })).toEqual([]);
  });

  it("asks for delete and ban permissions only for features that are on", () => {
    const noRights = { canApprove: true, canDelete: false, canRestrict: false };
    expect(steps({ enabled: true }, { bot: noRights })).toEqual(["hintInvite"]);
    expect(steps({ enabled: true, deleteJoinMessages: true }, { bot: noRights })).toEqual([
      "hintInvite",
      "hintDeletePermission",
    ]);
    expect(
      steps({ enabled: true, deleteJoinMessages: true, spamMode: "all" }, { bot: noRights }),
    ).toEqual(["hintInvite", "hintDeletePermission", "hintRestrictPermission"]);
    expect(steps({ enabled: true, spamMode: "all", spamBan: false }, { bot: noRights })).toEqual([
      "hintInvite",
      "hintDeletePermission",
    ]);
  });

  it("follows the Worker-wide default when a group has no override", () => {
    const noDelete = { ...allowed, canDelete: false };
    expect(steps({}, { defaultDeleteJoinMessages: true, bot: noDelete })).toContain(
      "hintDeletePermission",
    );
  });

  it("shows at most three hints", () => {
    const hints = steps(
      { enabled: true, deleteJoinMessages: true, spamMode: "all" },
      {
        packUsable: false,
        bot: { canApprove: false, canDelete: false, canRestrict: false },
      },
    );
    expect(hints).toHaveLength(3);
    expect(hints[0]).toBe("hintContent");
  });
});

describe("hintsText", () => {
  it("is empty without hints and otherwise a labelled bullet list", () => {
    expect(hintsText("en", [])).toBe("");
    const text = hintsText("en", ["hintEnable", "hintBotAdmin"]);
    expect(text.startsWith("\n\nNext steps:\n- ")).toBe(true);
    expect(text.split("\n- ")).toHaveLength(3);
    expect(hintsText("cn", ["hintEnable"])).toContain("下一步");
  });
});
