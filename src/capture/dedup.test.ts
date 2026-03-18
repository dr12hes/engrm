import { describe, expect, test } from "bun:test";
import { jaccardSimilarity, findDuplicate, DEDUP_THRESHOLD } from "./dedup.js";

describe("jaccardSimilarity", () => {
  test("identical strings return 1.0", () => {
    expect(jaccardSimilarity("fix auth bug", "fix auth bug")).toBe(1.0);
  });

  test("completely different strings return 0.0", () => {
    expect(jaccardSimilarity("alpha beta gamma", "delta epsilon zeta")).toBe(
      0.0
    );
  });

  test("both empty strings return 1.0", () => {
    expect(jaccardSimilarity("", "")).toBe(1.0);
  });

  test("one empty string returns 0.0", () => {
    expect(jaccardSimilarity("hello", "")).toBe(0.0);
    expect(jaccardSimilarity("", "hello")).toBe(0.0);
  });

  test("case insensitive", () => {
    expect(jaccardSimilarity("Fix Auth Bug", "fix auth bug")).toBe(1.0);
  });

  test("punctuation stripped", () => {
    expect(
      jaccardSimilarity("fix: auth bug!", "fix auth bug")
    ).toBe(1.0);
  });

  test("partial overlap returns correct ratio", () => {
    // "fix auth" vs "fix login" → intersection={fix}, union={fix,auth,login}
    const sim = jaccardSimilarity("fix auth", "fix login");
    expect(sim).toBeCloseTo(1 / 3, 5);
  });

  test("high similarity for near-duplicates", () => {
    // "fix authentication token refresh bug" vs "fix authentication token refresh issue"
    // shared: {fix, authentication, token, refresh} = 4
    // union: {fix, authentication, token, refresh, bug, issue} = 6
    // Jaccard = 4/6 = 0.667
    const sim = jaccardSimilarity(
      "fix authentication token refresh bug",
      "fix authentication token refresh issue"
    );
    expect(sim).toBeCloseTo(4 / 6, 5);
  });

  test("whitespace-only strings treated as empty", () => {
    expect(jaccardSimilarity("   ", "   ")).toBe(1.0);
    expect(jaccardSimilarity("   ", "hello")).toBe(0.0);
  });
});

describe("findDuplicate", () => {
  const candidates = [
    { id: 1, title: "fix authentication token refresh bug" },
    { id: 2, title: "add user profile page" },
    { id: 3, title: "refactor database connection pool" },
  ];

  test("finds duplicate above threshold", () => {
    // Candidate 1: "fix authentication token refresh bug"
    // Query:       "fix authentication token refresh bug typo"
    // shared: {fix, authentication, token, refresh, bug} = 5
    // union: {fix, authentication, token, refresh, bug, typo} = 6
    // Jaccard = 5/6 = 0.833 > 0.8
    const result = findDuplicate(
      "fix authentication token refresh bug typo",
      candidates
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  test("returns null when no match above threshold", () => {
    const result = findDuplicate("completely unrelated topic", candidates);
    expect(result).toBeNull();
  });

  test("returns null for empty candidates", () => {
    const result = findDuplicate("anything", []);
    expect(result).toBeNull();
  });

  test("returns best match when multiple above threshold", () => {
    const dupes = [
      { id: 10, title: "fix auth token bug" },
      { id: 11, title: "fix auth token bug in refresh" },
    ];
    const result = findDuplicate("fix auth token bug in refresh flow", dupes);
    // Should pick the closer match
    expect(result).not.toBeNull();
    expect(result!.id).toBe(11);
  });

  test("threshold constant is 0.8", () => {
    expect(DEDUP_THRESHOLD).toBe(0.8);
  });
});
