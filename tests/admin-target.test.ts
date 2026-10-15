import { describe, expect, it } from "vitest";

import { ADMIN_TARGET_TTL_MS, decodeGroupRef, encodeGroupRef } from "../src/lib/admin-target.js";

/** Group IDs whose encoded tokens fit the 13-digit limit enforced by `decodeGroupRef`. */
const ROUND_TRIP_IDS = [
  -1, // smallest basic group
  -123456, // typical basic group
  -987654321,
  -9999999999999, // largest 13-digit basic group
  -1000000000000, // boundary: magnitude equals the supergroup base, so it stays a basic group
  -1000000000001, // first supergroup
  -1001234567890,
  -1009999999999, // large supergroup, 10-digit channel part
];

describe("group refs", () => {
  it("encodes supergroups as the channel part of their ID with an s prefix", () => {
    expect(encodeGroupRef(-1001234567890)).toBe("s1234567890");
    expect(encodeGroupRef(-1009999999999)).toBe("s9999999999");
    expect(encodeGroupRef(-1000000000001)).toBe("s1");
  });

  it("encodes basic groups by their magnitude with a g prefix", () => {
    expect(encodeGroupRef(-123456)).toBe("g123456");
    expect(encodeGroupRef(-1)).toBe("g1");
    expect(encodeGroupRef(-1000000000000)).toBe("g1000000000000");
  });

  it("decodes canonical tokens back to the Bot API chat IDs", () => {
    expect(decodeGroupRef("s1234567890")).toBe(-1001234567890);
    expect(decodeGroupRef("g123456")).toBe(-123456);
    expect(decodeGroupRef("g1000000000000")).toBe(-1000000000000);
  });

  it("round-trips group IDs through encode and decode", () => {
    for (const chatId of ROUND_TRIP_IDS) {
      const ref = encodeGroupRef(chatId);
      expect(ref).not.toBeNull();
      expect(decodeGroupRef(ref ?? "")).toBe(chatId);
    }
  });

  it("encodes only negative safe integers", () => {
    expect(encodeGroupRef(0)).toBeNull();
    expect(encodeGroupRef(42)).toBeNull();
    expect(encodeGroupRef(1001234567890)).toBeNull();
    expect(encodeGroupRef(Number.NaN)).toBeNull();
    expect(encodeGroupRef(Number.POSITIVE_INFINITY)).toBeNull();
    expect(encodeGroupRef(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(encodeGroupRef(-1.5)).toBeNull();
    expect(encodeGroupRef(-(2 ** 53))).toBeNull();
  });

  it("rejects anything that is not a canonical token", () => {
    const invalid = [
      "",
      "s0",
      "g0",
      "s01", // leading zero
      "g00",
      "x12", // unknown prefix
      "s-5", // sign
      "s12a", // trailing letter
      "S12", // prefixes are case-sensitive
      "s12345678901234", // 14 digits
      "g12345678901234",
      " s12", // whitespace
      "s12 ",
      "s 12",
      "s12\n",
    ];
    for (const ref of invalid) {
      expect(decodeGroupRef(ref), JSON.stringify(ref)).toBeNull();
    }
  });

  it("produces short tokens of the allowed alphabet", () => {
    const pattern = /^[A-Za-z0-9_-]+$/;
    for (const chatId of ROUND_TRIP_IDS) {
      const ref = encodeGroupRef(chatId) ?? "";
      expect(ref.length).toBeLessThanOrEqual(16);
      expect(ref).toMatch(pattern);
    }
  });

  it("keeps the saved group selection for one day", () => {
    expect(ADMIN_TARGET_TTL_MS).toBe(86_400_000);
  });
});

describe("group ref range", () => {
  it("does not encode IDs the decoder would reject", () => {
    expect(encodeGroupRef(-9007199254740991)).toBeNull();
  });
});
