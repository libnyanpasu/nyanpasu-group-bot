import { describe, expect, it } from "vitest";

import { ADMIN_COMMANDS } from "../src/lib/admin.js";
import {
  COMMAND_LANGUAGES,
  COMMAND_SCOPES,
  GROUP_ADMIN_COMMANDS,
  MANAGER_COMMANDS,
  PRIVATE_COMMANDS,
  botCommands,
} from "../src/lib/commands.js";

const lists = [
  ["private", PRIVATE_COMMANDS],
  ["group admin", GROUP_ADMIN_COMMANDS],
  ["manager", MANAGER_COMMANDS],
] as const;

describe("command menus", () => {
  it.each(lists)("%s commands satisfy Telegram's limits in every language", (_name, commands) => {
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.length).toBeLessThanOrEqual(100);
    expect(new Set(commands.map((spec) => spec.command)).size).toBe(commands.length);
    for (const { key } of COMMAND_LANGUAGES) {
      for (const { command, description } of botCommands(commands, key)) {
        expect(command, command).toMatch(/^[a-z0-9_]{1,32}$/);
        expect(description.length, `${command} ${key}`).toBeGreaterThanOrEqual(3);
        expect(description.length, `${command} ${key}`).toBeLessThanOrEqual(256);
      }
    }
  });

  it("describes every admin command and the private-chat commands", () => {
    const described = new Set(MANAGER_COMMANDS.map((spec) => spec.command));
    for (const command of ADMIN_COMMANDS) expect(described, command).toContain(command);
    for (const command of ["start", "help"]) expect(described, command).toContain(command);
  });

  it("only offers invite links to the private management menu and keeps group menus to admin commands", () => {
    expect(GROUP_ADMIN_COMMANDS.map((spec) => spec.command)).not.toContain("start");
    expect(GROUP_ADMIN_COMMANDS.map((spec) => spec.command)).not.toContain("verify_groups");
    expect(PRIVATE_COMMANDS.map((spec) => spec.command)).toEqual([
      "start",
      "help",
      "verify_groups",
    ]);
  });

  it("translates every description", () => {
    for (const spec of MANAGER_COMMANDS) {
      expect(spec.zh, spec.command).not.toBe(spec.en);
      expect(spec.zh, spec.command).toMatch(/[一-鿿]/);
    }
  });

  it("registers private chats and group administrators, in English and Chinese", () => {
    expect(COMMAND_SCOPES.map(({ scope }) => scope.type)).toEqual([
      "all_private_chats",
      "all_chat_administrators",
    ]);
    expect(COMMAND_LANGUAGES.map(({ code }) => code)).toEqual([undefined, "zh"]);
  });
});
