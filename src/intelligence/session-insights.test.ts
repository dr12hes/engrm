import { describe, expect, test } from "bun:test";
import { computeSessionInsights } from "./session-insights.js";
import type { ObservationRow, SessionSummaryRow } from "../storage/sqlite.js";

function observation(partial: Partial<ObservationRow>): ObservationRow {
  return {
    id: 1,
    session_id: "sess-1",
    project_id: 1,
    type: "change",
    title: "Updated implementation",
    narrative: null,
    facts: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    quality: 0.5,
    lifecycle: "active",
    sensitivity: "shared",
    user_id: "david",
    device_id: "laptop",
    agent: "claude-code",
    created_at: "2026-03-19T10:00:00Z",
    created_at_epoch: 1710842400,
    archived_at_epoch: null,
    compacted_into: null,
    superseded_by: null,
    remote_source_id: null,
    ...partial,
  };
}

function summary(partial: Partial<SessionSummaryRow>): SessionSummaryRow {
  return {
    id: 1,
    session_id: "sess-1",
    project_id: 1,
    user_id: "david",
    request: "Improve startup brief quality",
    investigated: "- Traced duplicate digest fallback",
    learned: "- Decisions should outrank digests",
    completed: "- Added shared observation priority model",
    next_steps: "- Follow through: wire richer summaries into sync",
    created_at_epoch: 1710842400,
    ...partial,
  };
}

describe("computeSessionInsights", () => {
  test("summarizes section coverage and recent items", () => {
    const result = computeSessionInsights(
      [
        summary({ id: 1, created_at_epoch: 20 }),
        summary({
          id: 2,
          created_at_epoch: 30,
          request: "Improve local search previews",
          learned: "- Exact title matches should boost ranking",
          completed: "- Added top-context previews to search",
          next_steps: null,
        }),
      ],
      [
        observation({ id: 10, type: "decision", title: "Prefer richer memory objects", created_at_epoch: 40 }),
        observation({ id: 11, type: "feature", title: "Added summary coverage output", created_at_epoch: 35 }),
      ]
    );

    expect(result.summary_count).toBe(2);
    expect(result.summaries_with_learned).toBe(2);
    expect(result.summaries_with_next_steps).toBe(1);
    expect(result.total_summary_sections_present).toBe(9);
    expect(result.recent_requests).toEqual([
      "Improve local search previews",
      "Improve startup brief quality",
    ]);
    expect(result.recent_lessons).toContain("Exact title matches should boost ranking");
    expect(result.recent_completed).toContain("Added top-context previews to search");
    expect(result.next_steps).toContain("Follow through: wire richer summaries into sync");
  });
});
