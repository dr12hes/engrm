import { describe, expect, test } from "bun:test";
import { mergeResults } from "./search.js";
import type { FtsMatchRow, VecMatchRow } from "../storage/sqlite.js";

describe("mergeResults (RRF)", () => {
  test("merges FTS-only results", () => {
    const fts: FtsMatchRow[] = [
      { id: 1, rank: -5.0 },
      { id: 2, rank: -3.0 },
      { id: 3, rank: -1.0 },
    ];
    const vec: VecMatchRow[] = [];

    const merged = mergeResults(fts, vec, 10);
    expect(merged.length).toBe(3);
    expect(merged[0]!.id).toBe(1); // rank 0 in FTS = highest RRF
    expect(merged[1]!.id).toBe(2);
    expect(merged[2]!.id).toBe(3);
  });

  test("merges vec-only results", () => {
    const fts: FtsMatchRow[] = [];
    const vec: VecMatchRow[] = [
      { observation_id: 10, distance: 0.1 },
      { observation_id: 20, distance: 0.5 },
    ];

    const merged = mergeResults(fts, vec, 10);
    expect(merged.length).toBe(2);
    expect(merged[0]!.id).toBe(10);
    expect(merged[1]!.id).toBe(20);
  });

  test("boosts items appearing in both lists", () => {
    const fts: FtsMatchRow[] = [
      { id: 1, rank: -5.0 },
      { id: 2, rank: -3.0 },
    ];
    const vec: VecMatchRow[] = [
      { observation_id: 2, distance: 0.1 },
      { observation_id: 3, distance: 0.2 },
    ];

    const merged = mergeResults(fts, vec, 10);
    // ID 2 appears in both — should be boosted to top
    expect(merged[0]!.id).toBe(2);
    expect(merged[0]!.score).toBeGreaterThan(merged[1]!.score);
  });

  test("respects limit", () => {
    const fts: FtsMatchRow[] = [
      { id: 1, rank: -5 },
      { id: 2, rank: -4 },
      { id: 3, rank: -3 },
    ];
    const vec: VecMatchRow[] = [
      { observation_id: 4, distance: 0.1 },
      { observation_id: 5, distance: 0.2 },
    ];

    const merged = mergeResults(fts, vec, 3);
    expect(merged.length).toBe(3);
  });

  test("handles empty inputs", () => {
    const merged = mergeResults([], [], 10);
    expect(merged.length).toBe(0);
  });
});
