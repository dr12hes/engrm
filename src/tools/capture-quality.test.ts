import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getCaptureQuality } from "./capture-quality.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-capture-quality-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getCaptureQuality", () => {
  test("summarizes capture richness and provenance across projects", () => {
    const projectA = db.upsertProject({
      canonical_id: "local/repo-a",
      name: "repo-a",
      local_path: "/tmp/repo-a",
    });
    const projectB = db.upsertProject({
      canonical_id: "local/repo-b",
      name: "repo-b",
      local_path: "/tmp/repo-b",
    });

    db.upsertSession("sess-a", projectA.id, "david", "laptop", "claude-code");
    db.upsertSession("sess-b", projectB.id, "david", "laptop", "claude-code");
    db.insertSessionSummary({
      session_id: "sess-a",
      project_id: projectA.id,
      user_id: "david",
      request: "Fix auth flow",
      investigated: null,
      learned: null,
      completed: "Added retry",
      next_steps: null,
    });
    db.insertSessionSummary({
      session_id: "sess-b",
      project_id: projectB.id,
      user_id: "david",
      request: "Add UI filter",
      investigated: null,
      learned: null,
      completed: "Added filter",
      next_steps: null,
    });
    db.insertUserPrompt({
      session_id: "sess-a",
      project_id: projectA.id,
      prompt: "Fix auth flow",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertToolEvent({
      session_id: "sess-a",
      project_id: projectA.id,
      tool_name: "Edit",
      file_path: "src/auth.ts",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-a",
      project_id: projectA.id,
      type: "bugfix",
      title: "Fixed auth redirect",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
      source_tool: "Edit",
    });
    db.insertObservation({
      session_id: "sess-b",
      project_id: projectB.id,
      type: "change",
      title: "Bedford Hotel now appears inactive in site list",
      quality: 0.72,
      user_id: "david",
      device_id: "laptop",
      source_tool: "assistant-stop",
    });

    const result = getCaptureQuality(db, { user_id: "david" });
    expect(result.totals.projects).toBe(2);
    expect(result.totals.assistant_checkpoints).toBe(1);
    expect(result.session_states.rich).toBe(1);
    expect(result.session_states.summary_only).toBe(1);
    expect(result.projects_with_raw_capture).toBe(1);
    expect(result.provenance_summary).toEqual([
      { tool: "Edit", count: 1 },
      { tool: "assistant-stop", count: 1 },
    ]);
    expect(result.top_projects[0]?.raw_capture_state).toBe("rich");
  });
});
