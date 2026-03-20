import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getTimeline } from "./timeline.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-timeline-tool-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getTimeline", () => {
  test("includes session prompts when the anchor observation belongs to a captured session", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.upsertSession("sess-1", project.id, "david", "laptop", "claude-code");
    db.insertUserPrompt({
      session_id: "sess-1",
      project_id: project.id,
      prompt: "Investigate auth loop",
      cwd: "/tmp/repo",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertToolEvent({
      session_id: "sess-1",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "/tmp/repo/src/auth.ts",
      tool_input_json: "{\"file_path\":\"/tmp/repo/src/auth.ts\"}",
      tool_response_preview: "Successfully edited src/auth.ts",
      user_id: "david",
      device_id: "laptop",
    });

    const obs = db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "bugfix",
      title: "Fixed auth loop",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });

    const result = getTimeline(db, {
      anchor_id: obs.id,
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.observations).toHaveLength(1);
    expect(result.session_prompts?.[0]?.prompt).toContain("Investigate auth loop");
    expect(result.session_tool_events?.[0]?.tool_name).toBe("Edit");
  });
});
