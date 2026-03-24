import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getAgentMemoryIndex } from "./agent-memory-index.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-agent-memory-index-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getAgentMemoryIndex", () => {
  test("compares continuity and capture across agents for one project", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.upsertSession("claude-sess", project.id, "david", "laptop", "claude-code");
    db.insertSessionSummary({
      session_id: "claude-sess",
      project_id: project.id,
      user_id: "david",
      request: "Finish auth retry cleanup",
      investigated: null,
      learned: null,
      completed: "Retry headers now propagate correctly",
      next_steps: "Verify session handoff on desktop.",
      current_thread: "Finish auth retry cleanup",
    });
    db.insertUserPrompt({
      session_id: "claude-sess",
      project_id: project.id,
      prompt: "Finish auth retry cleanup",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
    });
    db.insertToolEvent({
      session_id: "claude-sess",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "src/auth.ts",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
    });
    db.insertObservation({
      session_id: "claude-sess",
      project_id: project.id,
      type: "message",
      title: "Handoff: Resume auth retry cleanup · 2026-03-24 22:10Z",
      narrative: "Current thread: Finish auth retry cleanup",
      concepts: JSON.stringify(["handoff", "session-handoff"]),
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
      agent: "engrm-handoff",
      source_tool: "create_handoff",
    });
    db.insertChatMessage({
      session_id: "claude-sess",
      project_id: project.id,
      role: "assistant",
      content: "The auth retry cleanup is ready to resume.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
    });

    db.upsertSession("codex-sess", project.id, "david", "desktop", "codex-cli");
    db.insertSessionSummary({
      session_id: "codex-sess",
      project_id: project.id,
      user_id: "david",
      request: "Audit notification routing assumptions",
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      current_thread: "Audit notification routing assumptions",
    });
    db.insertUserPrompt({
      session_id: "codex-sess",
      project_id: project.id,
      prompt: "Audit notification routing assumptions",
      user_id: "david",
      device_id: "desktop",
      agent: "codex-cli",
    });
    db.insertChatMessage({
      session_id: "codex-sess",
      project_id: project.id,
      role: "assistant",
      content: "We still need to verify the notification routing assumptions.",
      user_id: "david",
      device_id: "desktop",
      agent: "codex-cli",
      source_kind: "hook",
      remote_source_id: "history:codex-sess:1:abc",
    });

    const result = getAgentMemoryIndex(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.project).toBe("repo");
    expect(result.agents).toHaveLength(2);

    const claude = result.agents.find((item) => item.agent === "claude-code");
    const codex = result.agents.find((item) => item.agent === "codex-cli");

    expect(claude).toBeTruthy();
    expect(claude?.capture_state).toBe("rich");
    expect(claude?.continuity_state).toBe("fresh");
    expect(claude?.prompt_count).toBe(1);
    expect(claude?.tool_event_count).toBe(1);
    expect(claude?.handoff_count).toBe(1);
    expect(claude?.chat_coverage_state).toBe("transcript-backed");
    expect(claude?.latest_session_id).toBe("claude-sess");
    expect(claude?.devices).toEqual(["laptop"]);

    expect(codex).toBeTruthy();
    expect(codex?.capture_state).toBe("partial");
    expect(codex?.continuity_state).toBe("fresh");
    expect(codex?.prompt_count).toBe(1);
    expect(codex?.tool_event_count).toBe(0);
    expect(codex?.chat_coverage_state).toBe("history-backed");
    expect(codex?.latest_session_id).toBe("codex-sess");
    expect(codex?.devices).toEqual(["desktop"]);

    expect(result.suggested_tools).toContain("recent_sessions");
    expect(result.suggested_tools).toContain("capture_quality");
  });
});
