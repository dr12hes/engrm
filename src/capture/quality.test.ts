import { describe, expect, test } from "bun:test";
import {
  scoreQuality,
  meetsQualityThreshold,
  QUALITY_THRESHOLD,
  type QualityInput,
} from "./quality.js";

describe("scoreQuality", () => {
  test("bugfix type scores 0.3", () => {
    const score = scoreQuality({ type: "bugfix", title: "fix" });
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  test("decision type scores 0.3", () => {
    const score = scoreQuality({ type: "decision", title: "choose db" });
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  test("change type scores lowest (0.05)", () => {
    const score = scoreQuality({ type: "change", title: "update" });
    expect(score).toBe(0.05);
  });

  test("unknown type scores 0", () => {
    const score = scoreQuality({ type: "unknown", title: "test" });
    expect(score).toBe(0.0);
  });

  test("narrative longer than 50 chars adds 0.15", () => {
    const withNarrative = scoreQuality({
      type: "change",
      title: "test",
      narrative: "a".repeat(51),
    });
    const without = scoreQuality({ type: "change", title: "test" });
    expect(withNarrative - without).toBeCloseTo(0.15, 5);
  });

  test("short narrative adds nothing", () => {
    const withShort = scoreQuality({
      type: "change",
      title: "test",
      narrative: "short",
    });
    const without = scoreQuality({ type: "change", title: "test" });
    expect(withShort).toBe(without);
  });

  test("2+ facts add 0.15", () => {
    const score = scoreQuality({
      type: "change",
      title: "test",
      facts: JSON.stringify(["fact one", "fact two"]),
    });
    expect(score).toBe(0.05 + 0.15);
  });

  test("1 fact adds 0.05", () => {
    const score = scoreQuality({
      type: "change",
      title: "test",
      facts: JSON.stringify(["one fact"]),
    });
    expect(score).toBe(0.05 + 0.05);
  });

  test("concepts add 0.1", () => {
    const score = scoreQuality({
      type: "change",
      title: "test",
      concepts: JSON.stringify(["auth"]),
    });
    expect(score).toBe(0.05 + 0.1);
  });

  test("3+ files modified adds 0.2", () => {
    const score = scoreQuality({
      type: "change",
      title: "test",
      filesModified: ["a.ts", "b.ts", "c.ts"],
    });
    expect(score).toBe(0.05 + 0.2);
  });

  test("1-2 files modified adds 0.1", () => {
    const score = scoreQuality({
      type: "change",
      title: "test",
      filesModified: ["a.ts"],
    });
    expect(score).toBe(0.05 + 0.1);
  });

  test("duplicate penalty subtracts 0.3", () => {
    const normal = scoreQuality({ type: "bugfix", title: "fix" });
    const dupe = scoreQuality({
      type: "bugfix",
      title: "fix",
      isDuplicate: true,
    });
    expect(normal - dupe).toBeCloseTo(0.3, 5);
  });

  test("score clamped to 0.0 minimum", () => {
    const score = scoreQuality({
      type: "unknown",
      title: "x",
      isDuplicate: true,
    });
    expect(score).toBe(0.0);
  });

  test("score clamped to 1.0 maximum", () => {
    const score = scoreQuality({
      type: "bugfix",
      title: "big fix",
      narrative: "a".repeat(100),
      facts: JSON.stringify(["a", "b", "c"]),
      concepts: JSON.stringify(["x", "y"]),
      filesModified: ["a.ts", "b.ts", "c.ts"],
    });
    expect(score).toBeLessThanOrEqual(1.0);
  });

  test("rich bugfix observation scores high", () => {
    const score = scoreQuality({
      type: "bugfix",
      title: "Fix OAuth token refresh race condition",
      narrative:
        "The OAuth token was being refreshed by multiple concurrent requests, causing 401 errors. Added a mutex lock around the refresh logic.",
      facts: JSON.stringify([
        "Race condition in token refresh",
        "Multiple concurrent requests triggered simultaneous refreshes",
        "Fixed with mutex lock",
      ]),
      concepts: JSON.stringify(["oauth", "concurrency", "race-condition"]),
      filesModified: ["src/auth/oauth.ts", "src/auth/mutex.ts"],
    });
    expect(score).toBeGreaterThanOrEqual(0.7);
  });
});

describe("meetsQualityThreshold", () => {
  test("threshold is 0.1", () => {
    expect(QUALITY_THRESHOLD).toBe(0.1);
  });

  test("bugfix meets threshold", () => {
    expect(meetsQualityThreshold({ type: "bugfix", title: "fix" })).toBe(true);
  });

  test("unknown type with duplicate does not meet threshold", () => {
    expect(
      meetsQualityThreshold({
        type: "unknown",
        title: "x",
        isDuplicate: true,
      })
    ).toBe(false);
  });

  test("bare change type does not meet threshold (0.05 < 0.1)", () => {
    expect(
      meetsQualityThreshold({ type: "change", title: "minor edit" })
    ).toBe(false);
  });
});
