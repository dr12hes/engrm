import { describe, expect, test } from "bun:test";
import {
  buildLiveSummaryUpdate,
  mergeLiveSummarySections,
} from "./live-summary.js";
import type { ObservationRow, SessionSummaryRow } from "../storage/sqlite.js";

function makeObservation(
  type: ObservationRow["type"],
  title: string
): ObservationRow {
  return {
    id: 1,
    session_id: "sess-1",
    project_id: 1,
    type,
    title,
    narrative: null,
    facts: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    quality: 0.8,
    lifecycle: "active",
    sensitivity: "shared",
    user_id: "u",
    device_id: "d",
    agent: "claude-code",
    created_at: new Date().toISOString(),
    created_at_epoch: 1,
    archived_at_epoch: null,
    compacted_into: null,
    superseded_by: null,
    remote_source_id: null,
    source_tool: "Edit",
    source_prompt_number: 1,
  };
}

describe("live summary updates", () => {
  test("maps high-signal change work into completed", () => {
    expect(
      buildLiveSummaryUpdate(
        makeObservation("feature", "Added list_datasources_tool for AI discovery")
      )
    ).toEqual({
      completed: "Added list_datasources_tool for AI discovery",
    });
  });

  test("maps discovery into investigated", () => {
    expect(
      buildLiveSummaryUpdate(
        makeObservation("discovery", "StateTracker runs every 60 seconds in background loop")
      )
    ).toEqual({
      investigated: "StateTracker runs every 60 seconds in background loop",
    });
  });

  test("skips low-signal file-op titles", () => {
    expect(
      buildLiveSummaryUpdate(
        makeObservation("change", "Modified PlaceholderPage.tsx")
      )
    ).toBeNull();
  });

  test("dedupes merged live summary items", () => {
    const existing: SessionSummaryRow = {
      id: 1,
      session_id: "sess-1",
      project_id: 1,
      user_id: "u",
      request: "foo",
      investigated: null,
      learned: null,
      completed: "Added list_datasources_tool for AI discovery",
      next_steps: null,
      created_at_epoch: 1,
    };

    expect(
      mergeLiveSummarySections(existing, {
        completed: "Added list_datasources_tool for AI discovery",
      })
    ).toEqual({
      investigated: null,
      learned: null,
      completed: "Added list_datasources_tool for AI discovery",
    });
  });

  test("appends distinct live summary items", () => {
    const existing: SessionSummaryRow = {
      id: 1,
      session_id: "sess-1",
      project_id: 1,
      user_id: "u",
      request: "foo",
      investigated: null,
      learned: null,
      completed: "Added list_datasources_tool for AI discovery",
      next_steps: null,
      created_at_epoch: 1,
    };

    expect(
      mergeLiveSummarySections(existing, {
        completed: "Created list_event_types_tool for dynamic event discovery",
      })
    ).toEqual({
      investigated: null,
      learned: null,
      completed:
        "Added list_datasources_tool for AI discovery\n- Created list_event_types_tool for dynamic event discovery",
    });
  });
});
