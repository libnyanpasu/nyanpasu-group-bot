import { describe, expect, it, vi } from "vitest";
import { envFlag, timerFor } from "../src/lib/runtime.js";
import type { Bindings } from "../src/types.js";

describe("envFlag", () => {
  it("only treats true and 1 as enabled", () => {
    expect(envFlag("true")).toBe(true);
    expect(envFlag(" TRUE ")).toBe(true);
    expect(envFlag("1")).toBe(true);
    expect(envFlag(undefined)).toBe(false);
    expect(envFlag("")).toBe(false);
    expect(envFlag("false")).toBe(false);
    expect(envFlag("yes")).toBe(false);
  });
});

describe("timerFor", () => {
  it("is absent without the Durable Object binding", () => {
    expect(timerFor({} as Bindings)).toBeNull();
  });

  it("arms the timer addressed by the session key", async () => {
    const schedule = vi.fn(async () => {});
    const id = { name: "-100:1" };
    const idFromName = vi.fn(() => id);
    const get = vi.fn(() => ({ schedule }));
    const timer = timerFor({ SESSION_TIMER: { idFromName, get } } as unknown as Bindings);

    await timer?.("-100:1", 42);

    expect(idFromName).toHaveBeenCalledWith("-100:1");
    expect(get).toHaveBeenCalledWith(id);
    expect(schedule).toHaveBeenCalledWith("-100:1", 42);
  });
});
