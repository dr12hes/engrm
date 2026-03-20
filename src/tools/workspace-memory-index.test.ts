import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getWorkspaceMemoryIndex } from "./workspace-memory-index.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-workspace-memory-index-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getWorkspaceMemoryIndex", () => {
  test("returns cross-project memory totals and project rollups", () => {
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
    db.insertUserPrompt({
      session_id: "sess-a",
      project_id: projectA.id,
      prompt: "Fix auth flow",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertToolEvent({
      session_id: "sess-b",
      project_id: projectB.id,
      tool_name: "Edit",
      file_path: "src/ui.tsx",
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
      type: "feature",
      title: "Added UI filter",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
      source_tool: "assistant-stop",
    });

    const result = getWorkspaceMemoryIndex(db, { user_id: "david" });
    expect(result.projects.length).toBe(2);
    expect(result.totals.observations).toBe(2);
    expect(result.totals.sessions).toBe(2);
    expect(result.totals.prompts).toBe(1);
    expect(result.totals.tool_events).toBe(1);
    expect(result.totals.assistant_checkpoints).toBe(1);
    expect(result.projects_with_raw_capture).toBe(2);
    expect(result.provenance_summary).toEqual([
      { tool: "Edit", count: 1 },
      { tool: "assistant-stop", count: 1 },
    ]);
  });
});
