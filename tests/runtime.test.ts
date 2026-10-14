import { describe, expect, it } from "vitest";
import { envFlag } from "../src/lib/runtime.js";

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
