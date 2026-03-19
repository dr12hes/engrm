import { describe, expect, test } from "bun:test";
import { mergeResults } from "./search.js";
import type { FtsMatchRow, VecMatchRow } from "../storage/sqlite.js";
import { computeSearchRank } from "../intelligence/observation-priority.js";

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

describe("computeSearchRank", () => {
  const NOW = Math.floor(Date.now() / 1000);

  test("rewards exact title matches", () => {
    const exact = {
      id: 1,
      project_id: 1,
      source_session_id: null,
      type: "change",
      title: "OAuth token refresh fix",
      narrative: null,
      facts: null,
      concepts: null,
      files_modified: null,
      quality: 0.5,
      sensitivity: "team",
      lifecycle: "active",
      superseded_by: null,
      supersedes: null,
      user_id: "david",
      device_id: "laptop",
      created_at: "2026-03-19T10:00:00Z",
      created_at_epoch: NOW - 3600,
      updated_at: "2026-03-19T10:00:00Z",
      embedding_id: null,
    } as any;

    const vague = {
      ...exact,
      id: 2,
      title: "Updated auth flow",
    } as any;

    expect(computeSearchRank(exact, 0.02, "OAuth token refresh", NOW)).toBeGreaterThan(
      computeSearchRank(vague, 0.02, "OAuth token refresh", NOW)
    );
  });

  test("prefers structured memory objects when retrieval score is similar", () => {
    const base = {
      id: 1,
      project_id: 1,
      source_session_id: null,
      title: "API auth notes",
      narrative: "Captured findings about auth decisions",
      facts: "[\"Bearer token expires after 15 minutes\"]",
      concepts: null,
      files_modified: null,
      quality: 0.6,
      sensitivity: "team",
      lifecycle: "active",
      superseded_by: null,
      supersedes: null,
      user_id: "david",
      device_id: "laptop",
      created_at: "2026-03-19T10:00:00Z",
      created_at_epoch: NOW - 86400,
      updated_at: "2026-03-19T10:00:00Z",
      embedding_id: null,
    };

    const decision = {
      ...base,
      type: "decision",
    } as any;

    const change = {
      ...base,
      id: 2,
      type: "change",
    } as any;

    expect(computeSearchRank(decision, 0.02, "auth token", NOW)).toBeGreaterThan(
      computeSearchRank(change, 0.02, "auth token", NOW)
    );
  });
});
