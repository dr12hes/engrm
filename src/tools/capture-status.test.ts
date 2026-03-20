import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getCaptureStatus } from "./capture-status.js";

let db: MemDatabase;
let tmpDir: string;
let fakeHome: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-capture-status-test-"));
  fakeHome = join(tmpDir, "home");
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  mkdirSync(join(fakeHome, ".codex"), { recursive: true });
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getCaptureStatus", () => {
  test("reports registration and recent raw chronology capture", () => {
    writeFileSync(join(fakeHome, ".claude.json"), JSON.stringify({
      mcpServers: { engrm: { type: "stdio", command: "node", args: ["server.js"] } },
    }));
    writeFileSync(join(fakeHome, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ command: "engrm session-start" }] }],
        UserPromptSubmit: [{ hooks: [{ command: "engrm user-prompt-submit" }] }],
        PostToolUse: [{ hooks: [{ command: "engrm post-tool-use" }] }],
      },
    }));
    writeFileSync(join(fakeHome, ".codex", "config.toml"), `[mcp_servers.engrm]\nenabled = true\n`);
    writeFileSync(join(fakeHome, ".codex", "hooks.json"), JSON.stringify({
      hooks: { SessionStart: [], Stop: [] },
    }));

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

    const result = getCaptureStatus(db, {
      user_id: "david",
      home_dir: fakeHome,
      lookback_hours: 24,
    });

    expect(result.schema_current).toBe(true);
    expect(result.claude_mcp_registered).toBe(true);
    expect(result.claude_hooks_registered).toBe(true);
    expect(result.claude_hook_count).toBeGreaterThanOrEqual(3);
    expect(result.claude_session_start_hook).toBe(true);
    expect(result.claude_user_prompt_hook).toBe(true);
    expect(result.claude_post_tool_hook).toBe(true);
    expect(result.claude_stop_hook).toBe(false);
    expect(result.codex_mcp_registered).toBe(true);
    expect(result.codex_hooks_registered).toBe(true);
    expect(result.codex_session_start_hook).toBe(true);
    expect(result.codex_stop_hook).toBe(true);
    expect(result.codex_raw_chronology_supported).toBe(false);
    expect(result.recent_user_prompts).toBe(1);
    expect(result.recent_tool_events).toBe(1);
    expect(result.recent_sessions_with_raw_capture).toBe(1);
    expect(result.recent_sessions_with_partial_capture).toBe(0);
    expect(result.raw_capture_active).toBe(true);
  });

  test("flags partial chronology when session metrics exist without raw tool events", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });
    db.upsertSession("sess-legacy", project.id, "david", "laptop", "claude-code");
    db.incrementSessionMetrics("sess-legacy", { toolCalls: 3 });
    db.insertUserPrompt({
      session_id: "sess-legacy",
      project_id: project.id,
      prompt: "Fix auth flow",
      user_id: "david",
      device_id: "laptop",
    });

    const result = getCaptureStatus(db, {
      user_id: "david",
      home_dir: fakeHome,
      lookback_hours: 24,
    });

    expect(result.recent_sessions_with_partial_capture).toBe(1);
  });
});
