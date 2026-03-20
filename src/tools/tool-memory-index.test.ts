import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getToolMemoryIndex } from "./tool-memory-index.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-tool-memory-index-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getToolMemoryIndex", () => {
  test("summarizes durable memory by source tool", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.upsertSession("sess-1", project.id, "david", "laptop", "claude-code");
    db.upsertSession("sess-2", project.id, "david", "laptop", "claude-code");

    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "bugfix",
      title: "Fixed auth redirect after cookie expiry",
      quality: 0.82,
      user_id: "david",
      device_id: "laptop",
      source_tool: "Edit",
      source_prompt_number: 1,
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "change",
      title: "Adjusted auth retry thresholds",
      quality: 0.74,
      user_id: "david",
      device_id: "laptop",
      source_tool: "Edit",
      source_prompt_number: 2,
    });
    db.insertObservation({
      session_id: "sess-2",
      project_id: project.id,
      type: "decision",
      title: "Use staging rollout before production enablement",
      quality: 0.76,
      user_id: "david",
      device_id: "laptop",
      source_tool: "assistant-stop",
      source_prompt_number: 4,
    });

    const result = getToolMemoryIndex(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.project).toBe("repo");
    expect(result.tools[0]?.tool).toBe("Edit");
    expect(result.tools[0]?.observation_count).toBe(2);
    expect(result.tools[0]?.session_count).toBe(1);
    expect(result.tools[0]?.latest_prompt_number).toBe(2);
    expect(result.tools[0]?.top_types).toEqual([
      { type: "bugfix", count: 1 },
      { type: "change", count: 1 },
    ]);
    expect(result.tools[0]?.sample_titles[0]).toContain("Adjusted auth retry thresholds");
    expect(result.tools[1]?.tool).toBe("assistant-stop");
    expect(result.tools[1]?.top_types).toEqual([{ type: "decision", count: 1 }]);
  });
});
