import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getSessionToolMemory } from "./session-tool-memory.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-session-tool-memory-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getSessionToolMemory", () => {
  test("shows which tools in a session produced durable memory", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });
    db.upsertSession("sess-1", project.id, "david", "laptop", "claude-code");

    db.insertToolEvent({
      session_id: "sess-1",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "src/auth.ts",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertToolEvent({
      session_id: "sess-1",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "src/login.ts",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertToolEvent({
      session_id: "sess-1",
      project_id: project.id,
      tool_name: "Bash",
      command: "npm test",
      user_id: "david",
      device_id: "laptop",
    });

    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "bugfix",
      title: "Fixed auth redirect after cookie expiry",
      quality: 0.81,
      user_id: "david",
      device_id: "laptop",
      source_tool: "Edit",
      source_prompt_number: 3,
      concepts: JSON.stringify(["plugin:engrm.git-diff"]),
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
      source_prompt_number: 4,
      concepts: JSON.stringify(["plugin:engrm.git-diff"]),
    });

    const result = getSessionToolMemory(db, {
      session_id: "sess-1",
    });

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toEqual({
      tool: "Edit",
      tool_event_count: 2,
      observation_count: 2,
      top_types: [
        { type: "bugfix", count: 1 },
        { type: "change", count: 1 },
      ],
      top_plugins: [
        { plugin: "engrm.git-diff", count: 2 },
      ],
      sample_titles: [
        "Adjusted auth retry thresholds",
        "Fixed auth redirect after cookie expiry",
      ],
      latest_prompt_number: 4,
    });
    expect(result.tools_without_memory).toEqual([
      { tool: "Bash", tool_event_count: 1 },
    ]);
  });
});
