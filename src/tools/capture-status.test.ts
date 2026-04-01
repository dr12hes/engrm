import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getCaptureStatus } from "./capture-status.js";
import { saveConfig } from "../config.js";

let db: MemDatabase;
let tmpDir: string;
let fakeHome: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-capture-status-test-"));
  fakeHome = join(tmpDir, "home");
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  mkdirSync(join(fakeHome, ".codex"), { recursive: true });
  mkdirSync(join(fakeHome, ".openclaw", "extensions", "engrm"), { recursive: true });
  mkdirSync(join(fakeHome, ".config", "opencode", "plugins"), { recursive: true });
  process.env.HOME = fakeHome;
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getCaptureStatus", () => {
  test("reports registration and recent raw chronology capture", () => {
    saveConfig({
      candengo_url: "https://engrm.dev",
      candengo_api_key: "cvk_org",
      site_id: "site-1",
      namespace: "org-ns",
      user_id: "david",
      user_email: "david@example.com",
      device_id: "laptop-1",
      teams: [],
      sync: { enabled: true, interval_seconds: 30, batch_size: 50 },
      search: { default_limit: 10, local_boost: 1.2, scope: "all" },
      scrubbing: { enabled: true, custom_patterns: [], default_sensitivity: "shared" },
      sentinel: { enabled: false, mode: "advisory", provider: "openai", model: "gpt-4o-mini", api_key: "", base_url: "", skip_patterns: [], daily_limit: 100, tier: "free" },
      observer: { enabled: true, mode: "per_event", model: "sonnet" },
      transcript_analysis: { enabled: false },
      http: { enabled: true, port: 3767, bearer_tokens: ["token-1", "token-2"] },
      fleet: { project_name: "shared-experience", namespace: "fleet-ns", api_key: "cvk_fleet" },
    });

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
    writeFileSync(join(fakeHome, ".openclaw", "openclaw.json"), JSON.stringify({
      mcp: {
        servers: {
          engrm: {
            url: "http://127.0.0.1:3767/mcp",
            headers: { Authorization: "Bearer token-1" },
          },
        },
      },
      plugins: {
        allow: ["engrm"],
      },
    }));
    writeFileSync(join(fakeHome, ".openclaw", "extensions", "engrm", "openclaw.plugin.json"), JSON.stringify({
      id: "engrm",
      name: "Engrm",
    }));
    writeFileSync(join(fakeHome, ".config", "opencode", "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        engrm: {
          type: "local",
          command: ["engrm", "serve"],
          enabled: true,
          timeout: 5000,
        },
      },
    }));
    writeFileSync(join(fakeHome, ".config", "opencode", "plugins", "engrm.js"), "export default async () => ({})\n");

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
    expect(result.http_enabled).toBe(true);
    expect(result.http_port).toBe(3767);
    expect(result.http_bearer_token_count).toBe(2);
    expect(result.fleet_project_name).toBe("shared-experience");
    expect(result.fleet_configured).toBe(true);
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
    expect(result.openclaw_mcp_registered).toBe(true);
    expect(result.openclaw_plugin_registered).toBe(true);
    expect(result.opencode_mcp_registered).toBe(true);
    expect(result.opencode_plugin_registered).toBe(true);
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
