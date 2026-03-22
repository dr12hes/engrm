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
    const projectC = db.upsertProject({
      canonical_id: "local/repo-c",
      name: "repo-c",
      local_path: "/tmp/repo-c",
    });

    db.upsertSession("sess-a", projectA.id, "david", "laptop", "claude-code");
    db.upsertSession("sess-b", projectB.id, "david", "laptop", "claude-code");
    db.upsertSession("sess-c", projectC.id, "david", "laptop", "claude-code");
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
    db.insertChatMessage({
      session_id: "sess-a",
      project_id: projectA.id,
      role: "assistant",
      content: "Transcript-backed auth thread is available.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
    });
    db.insertChatMessage({
      session_id: "sess-b",
      project_id: projectB.id,
      role: "assistant",
      content: "Recovered history-backed chat exists for the UI filter thread.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "hook",
      remote_source_id: "history:sess-b:1234:abcd",
    });
    db.insertChatMessage({
      session_id: "sess-c",
      project_id: projectC.id,
      role: "assistant",
      content: "Only hook chat exists for the deployment thread.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "hook",
    });

    const result = getCaptureQuality(db, { user_id: "david" });
    expect(result.totals.projects).toBe(3);
    expect(result.totals.assistant_checkpoints).toBe(1);
    expect(result.totals.chat_messages).toBe(3);
    expect(result.session_states.rich).toBe(1);
    expect(result.session_states.summary_only).toBe(1);
    expect(result.chat_coverage).toEqual({
      transcript_backed_sessions: 1,
      history_backed_sessions: 1,
      hook_only_sessions: 1,
    });
    expect(result.projects_with_raw_capture).toBe(1);
    expect(result.provenance_summary).toEqual([
      { tool: "Edit", count: 1 },
      { tool: "assistant-stop", count: 1 },
    ]);
    expect(result.provenance_type_mix).toEqual([
      {
        tool: "assistant-stop",
        count: 1,
        top_types: [{ type: "change", count: 1 }],
      },
      {
        tool: "Edit",
        count: 1,
        top_types: [{ type: "bugfix", count: 1 }],
      },
    ]);
    expect(result.assistant_checkpoint_types).toEqual([
      { type: "change", count: 1 },
    ]);
    const repoA = result.top_projects.find((project) => project.name === "repo-a");
    const repoB = result.top_projects.find((project) => project.name === "repo-b");
    const repoC = result.top_projects.find((project) => project.name === "repo-c");
    expect(repoA?.raw_capture_state).toBe("rich");
    expect(repoA?.chat_coverage_state).toBe("transcript-backed");
    expect(repoB?.chat_coverage_state).toBe("history-backed");
    expect(repoC?.chat_coverage_state).toBe("hook-only");
  });
});
