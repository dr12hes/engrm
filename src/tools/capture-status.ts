/**
 * capture_status MCP tool.
 *
 * Shows whether local hook registration appears correct and whether recent raw
 * chronology capture (prompts/tools) is actually happening on this machine.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configExists, loadConfig } from "../config.js";
import { getSchemaVersion, LATEST_SCHEMA_VERSION } from "../storage/migrations.js";
import type { MemDatabase } from "../storage/sqlite.js";

const LEGACY_CODEX_SERVER_NAME = `candengo-${"mem"}`;

export interface CaptureStatusInput {
  lookback_hours?: number;
  user_id?: string;
  home_dir?: string;
}

export interface CaptureStatusResult {
  schema_version: number;
  schema_current: boolean;
  http_enabled: boolean;
  http_port: number | null;
  http_bearer_token_count: number;
  fleet_project_name: string | null;
  fleet_configured: boolean;
  claude_mcp_registered: boolean;
  claude_hooks_registered: boolean;
  claude_hook_count: number;
  claude_session_start_hook: boolean;
  claude_user_prompt_hook: boolean;
  claude_post_tool_hook: boolean;
  claude_stop_hook: boolean;
  codex_mcp_registered: boolean;
  codex_hooks_registered: boolean;
  codex_session_start_hook: boolean;
  codex_stop_hook: boolean;
  codex_raw_chronology_supported: boolean;
  openclaw_mcp_registered: boolean;
  openclaw_plugin_registered: boolean;
  opencode_mcp_registered: boolean;
  opencode_plugin_registered: boolean;
  recent_user_prompts: number;
  recent_tool_events: number;
  recent_sessions_with_raw_capture: number;
  recent_sessions_with_partial_capture: number;
  latest_prompt_epoch: number | null;
  latest_tool_event_epoch: number | null;
  latest_post_tool_hook_epoch: number | null;
  latest_post_tool_parse_status: string | null;
  latest_post_tool_name: string | null;
  raw_capture_active: boolean;
}

export function getCaptureStatus(
  db: MemDatabase,
  input: CaptureStatusInput = {}
): CaptureStatusResult {
  const hours = Math.max(1, Math.min(input.lookback_hours ?? 24, 24 * 30));
  const sinceEpoch = Math.floor(Date.now() / 1000) - hours * 3600;
  const home = input.home_dir ?? homedir();

  const claudeJson = join(home, ".claude.json");
  const claudeSettings = join(home, ".claude", "settings.json");
  const codexConfig = join(home, ".codex", "config.toml");
  const codexHooks = join(home, ".codex", "hooks.json");
  const opencodeConfig = join(home, ".config", "opencode", "opencode.json");
  const opencodePlugin = join(home, ".config", "opencode", "plugins", "engrm.js");
  const openclawConfig = join(home, ".openclaw", "openclaw.json");
  const openclawPlugin = join(home, ".openclaw", "extensions", "engrm", "openclaw.plugin.json");
  const config = configExists() ? loadConfig() : null;

  const claudeJsonContent = existsSync(claudeJson) ? readFileSync(claudeJson, "utf-8") : "";
  const claudeSettingsContent = existsSync(claudeSettings) ? readFileSync(claudeSettings, "utf-8") : "";
  const codexConfigContent = existsSync(codexConfig) ? readFileSync(codexConfig, "utf-8") : "";
  const codexHooksContent = existsSync(codexHooks) ? readFileSync(codexHooks, "utf-8") : "";
  const opencodeConfigContent = existsSync(opencodeConfig) ? readFileSync(opencodeConfig, "utf-8") : "";
  const openclawConfigContent = existsSync(openclawConfig) ? readFileSync(openclawConfig, "utf-8") : "";

  const claudeMcpRegistered = claudeJsonContent.includes('"engrm"');
  const claudeHooksRegistered =
    claudeSettingsContent.includes("engrm") ||
    claudeSettingsContent.includes("session-start") ||
    claudeSettingsContent.includes("user-prompt-submit");
  const codexMcpRegistered =
    codexConfigContent.includes("[mcp_servers.engrm]") ||
    codexConfigContent.includes(`[mcp_servers.${LEGACY_CODEX_SERVER_NAME}]`);
  const codexHooksRegistered =
    codexHooksContent.includes("\"SessionStart\"") &&
    codexHooksContent.includes("\"Stop\"");
  const opencodeMcpRegistered =
    opencodeConfigContent.includes('"engrm"') &&
    opencodeConfigContent.includes('"type"') &&
    opencodeConfigContent.includes('"local"');
  const opencodePluginRegistered = existsSync(opencodePlugin);
  const openclawMcpRegistered = hasOpenClawMcpRegistration(openclawConfigContent);
  const openclawPluginRegistered = existsSync(openclawPlugin);

  let claudeHookCount = 0;
  let claudeSessionStartHook = false;
  let claudeUserPromptHook = false;
  let claudePostToolHook = false;
  let claudeStopHook = false;
  if (claudeHooksRegistered) {
    try {
      const settings = JSON.parse(claudeSettingsContent);
      const hooks = settings?.hooks ?? {};
      claudeSessionStartHook = Array.isArray(hooks["SessionStart"]);
      claudeUserPromptHook = Array.isArray(hooks["UserPromptSubmit"]);
      claudePostToolHook = Array.isArray(hooks["PostToolUse"]);
      claudeStopHook = Array.isArray(hooks["Stop"]);
      for (const entries of Object.values(hooks)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const e = entry as { hooks?: { command?: string }[] };
          if (
            e.hooks?.some((h) =>
              h.command?.includes("engrm") ||
              h.command?.includes("session-start") ||
              h.command?.includes("user-prompt-submit") ||
              h.command?.includes("sentinel") ||
              h.command?.includes("post-tool-use") ||
              h.command?.includes("pre-compact") ||
              h.command?.includes("stop") ||
              h.command?.includes("elicitation")
            )
          ) {
            claudeHookCount++;
          }
        }
      }
    } catch {
      // Best-effort only
    }
  }

  let codexSessionStartHook = false;
  let codexStopHook = false;
  try {
    const hooks = codexHooksContent ? JSON.parse(codexHooksContent)?.hooks ?? {} : {};
    codexSessionStartHook = Array.isArray(hooks["SessionStart"]);
    codexStopHook = Array.isArray(hooks["Stop"]);
  } catch {
    // Best-effort only
  }

  const visibilityClause = input.user_id ? " AND user_id = ?" : "";
  const params = input.user_id ? [sinceEpoch, input.user_id] : [sinceEpoch];

  const recentUserPrompts = db.db
    .query<{ count: number }, (number | string)[]>(
      `SELECT COUNT(*) as count FROM user_prompts
       WHERE created_at_epoch >= ?${visibilityClause}`
    )
    .get(...params)?.count ?? 0;

  const recentToolEvents = db.db
    .query<{ count: number }, (number | string)[]>(
      `SELECT COUNT(*) as count FROM tool_events
       WHERE created_at_epoch >= ?${visibilityClause}`
    )
    .get(...params)?.count ?? 0;

  const recentSessionsWithRawCapture = db.db
    .query<{ count: number }, (number | string)[]>(
      `SELECT COUNT(*) as count
       FROM sessions s
       WHERE COALESCE(s.completed_at_epoch, s.started_at_epoch, 0) >= ?
         ${input.user_id ? "AND s.user_id = ?" : ""}
         AND (
           EXISTS (SELECT 1 FROM user_prompts up WHERE up.session_id = s.session_id)
           OR EXISTS (SELECT 1 FROM tool_events te WHERE te.session_id = s.session_id)
         )`
    )
    .get(...params)?.count ?? 0;

  const recentSessionsWithPartialCapture = db.db
    .query<{ count: number }, (number | string)[]>(
      `SELECT COUNT(*) as count
       FROM sessions s
       WHERE COALESCE(s.completed_at_epoch, s.started_at_epoch, 0) >= ?
         ${input.user_id ? "AND s.user_id = ?" : ""}
         AND (
           (s.tool_calls_count > 0 AND NOT EXISTS (SELECT 1 FROM tool_events te WHERE te.session_id = s.session_id))
           OR (
             EXISTS (SELECT 1 FROM user_prompts up WHERE up.session_id = s.session_id)
             AND NOT EXISTS (SELECT 1 FROM tool_events te WHERE te.session_id = s.session_id)
           )
         )`
    )
    .get(...params)?.count ?? 0;

  const latestPromptEpoch = db.db
    .query<{ created_at_epoch: number }, (string | number)[]>(
      `SELECT created_at_epoch FROM user_prompts
       WHERE 1 = 1${input.user_id ? " AND user_id = ?" : ""}
       ORDER BY created_at_epoch DESC, prompt_number DESC
       LIMIT 1`
    )
    .get(...(input.user_id ? [input.user_id] : []))?.created_at_epoch ?? null;

  const latestToolEventEpoch = db.db
    .query<{ created_at_epoch: number }, (string | number)[]>(
      `SELECT created_at_epoch FROM tool_events
       WHERE 1 = 1${input.user_id ? " AND user_id = ?" : ""}
       ORDER BY created_at_epoch DESC, id DESC
       LIMIT 1`
    )
    .get(...(input.user_id ? [input.user_id] : []))?.created_at_epoch ?? null;

  const latestPostToolHookEpoch = parseNullableInt(
    db.getSyncState("hook_post_tool_last_seen_epoch")
  );
  const latestPostToolParseStatus =
    db.getSyncState("hook_post_tool_last_parse_status");
  const latestPostToolName =
    db.getSyncState("hook_post_tool_last_tool_name");

  const schemaVersion = getSchemaVersion(db.db);

  return {
    schema_version: schemaVersion,
    schema_current: schemaVersion >= LATEST_SCHEMA_VERSION,
    http_enabled: Boolean(config?.http?.enabled || process.env.ENGRM_HTTP_PORT),
    http_port: config?.http?.port ?? (process.env.ENGRM_HTTP_PORT ? Number(process.env.ENGRM_HTTP_PORT) : null),
    http_bearer_token_count: config?.http?.bearer_tokens?.length ?? 0,
    fleet_project_name: config?.fleet?.project_name ?? null,
    fleet_configured: Boolean(config?.fleet?.namespace && config?.fleet?.api_key),
    claude_mcp_registered: claudeMcpRegistered,
    claude_hooks_registered: claudeHooksRegistered,
    claude_hook_count: claudeHookCount,
    claude_session_start_hook: claudeSessionStartHook,
    claude_user_prompt_hook: claudeUserPromptHook,
    claude_post_tool_hook: claudePostToolHook,
    claude_stop_hook: claudeStopHook,
    codex_mcp_registered: codexMcpRegistered,
    codex_hooks_registered: codexHooksRegistered,
    codex_session_start_hook: codexSessionStartHook,
    codex_stop_hook: codexStopHook,
    codex_raw_chronology_supported: false,
    openclaw_mcp_registered: openclawMcpRegistered,
    openclaw_plugin_registered: openclawPluginRegistered,
    opencode_mcp_registered: opencodeMcpRegistered,
    opencode_plugin_registered: opencodePluginRegistered,
    recent_user_prompts: recentUserPrompts,
    recent_tool_events: recentToolEvents,
    recent_sessions_with_raw_capture: recentSessionsWithRawCapture,
    recent_sessions_with_partial_capture: recentSessionsWithPartialCapture,
    latest_prompt_epoch: latestPromptEpoch,
    latest_tool_event_epoch: latestToolEventEpoch,
    latest_post_tool_hook_epoch: latestPostToolHookEpoch,
    latest_post_tool_parse_status: latestPostToolParseStatus,
    latest_post_tool_name: latestPostToolName,
    raw_capture_active:
      recentUserPrompts > 0 ||
      recentToolEvents > 0 ||
      recentSessionsWithRawCapture > 0,
  };
}

function parseNullableInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasOpenClawMcpRegistration(content: string): boolean {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content) as {
      mcp?: { servers?: Record<string, unknown> };
    };
    return Boolean(parsed.mcp?.servers?.engrm);
  } catch {
    return content.includes('"mcp"') && content.includes('"servers"') && content.includes('"engrm"');
  }
}
