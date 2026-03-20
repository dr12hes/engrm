import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getSessionContext } from "./session-context.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-session-context-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getSessionContext", () => {
  test("previews injected context for the current project", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.upsertSession("sess-1", project.id, "david", "laptop", "claude-code");
    db.insertUserPrompt({
      session_id: "sess-1",
      project_id: project.id,
      prompt: "Investigate why startup context still feels thin",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertToolEvent({
      session_id: "sess-1",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "src/context.ts",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "discovery",
      title: "Prompt chronology was missing from startup context",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });

    const result = getSessionContext(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result).not.toBeNull();
    expect(result?.project_name).toBe("repo");
    expect(result?.recent_requests).toBe(1);
    expect(result?.recent_tools).toBe(1);
    expect(result?.raw_capture_active).toBe(true);
    expect(result?.preview).toContain("## Recent Requests");
    expect(result?.preview).toContain("## Recent Tools");
  });
});
