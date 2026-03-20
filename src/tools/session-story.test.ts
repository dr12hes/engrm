import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getSessionStory } from "./session-story.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-session-story-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getSessionStory", () => {
  test("returns prompts, tools, observations, summary, and metrics for a session", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.upsertSession("sess-1", project.id, "david", "laptop", "claude-code");
    db.insertUserPrompt({
      session_id: "sess-1",
      project_id: project.id,
      prompt: "Fix auth flow",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertToolEvent({
      session_id: "sess-1",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "src/auth.ts",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "bugfix",
      title: "Fixed auth redirect",
      files_modified: JSON.stringify(["src/auth.ts"]),
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
      source_tool: "Edit",
      source_prompt_number: 1,
    });
    db.insertSessionSummary({
      session_id: "sess-1",
      project_id: project.id,
      user_id: "david",
      request: "Fix auth flow",
      investigated: null,
      learned: "Cookie domain mismatch",
      completed: "Added cookie fix",
      next_steps: null,
    });
    db.incrementSessionMetrics("sess-1", { toolCalls: 1, files: 1 });

    const story = getSessionStory(db, { session_id: "sess-1" });
    expect(story.session?.session_id).toBe("sess-1");
    expect(story.prompts).toHaveLength(1);
    expect(story.tool_events).toHaveLength(1);
    expect(story.observations).toHaveLength(1);
    expect(story.summary?.request).toBe("Fix auth flow");
    expect(story.metrics?.tool_calls_count).toBe(1);
    expect(story.capture_state).toBe("rich");
    expect(story.capture_gaps).toEqual([]);
    expect(story.project_name).toBe("repo");
    expect(story.latest_request).toBe("Fix auth flow");
    expect(story.recent_outcomes).toContain("Fixed auth redirect");
    expect(story.hot_files).toEqual([{ path: "src/auth.ts", count: 1 }]);
    expect(story.provenance_summary).toEqual([{ tool: "Edit", count: 1 }]);
  });
});
