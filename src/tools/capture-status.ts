/**
 * capture_status MCP tool.
 *
 * Shows whether local hook registration appears correct and whether recent raw
 * chronology capture (prompts/tools) is actually happening on this machine.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  claude_mcp_registered: boolean;
  claude_hooks_registered: boolean;
  claude_hook_count: number;
  codex_mcp_registered: boolean;
  codex_hooks_registered: boolean;
  recent_user_prompts: number;
  recent_tool_events: number;
  recent_sessions_with_raw_capture: number;
  latest_prompt_epoch: number | null;
  latest_tool_event_epoch: number | null;
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

  const claudeJsonContent = existsSync(claudeJson) ? readFileSync(claudeJson, "utf-8") : "";
  const claudeSettingsContent = existsSync(claudeSettings) ? readFileSync(claudeSettings, "utf-8") : "";
  const codexConfigContent = existsSync(codexConfig) ? readFileSync(codexConfig, "utf-8") : "";
  const codexHooksContent = existsSync(codexHooks) ? readFileSync(codexHooks, "utf-8") : "";

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

  let claudeHookCount = 0;
  if (claudeHooksRegistered) {
    try {
      const settings = JSON.parse(claudeSettingsContent);
      const hooks = settings?.hooks ?? {};
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

  const schemaVersion = getSchemaVersion(db.db);

  return {
    schema_version: schemaVersion,
    schema_current: schemaVersion >= LATEST_SCHEMA_VERSION,
    claude_mcp_registered: claudeMcpRegistered,
    claude_hooks_registered: claudeHooksRegistered,
    claude_hook_count: claudeHookCount,
    codex_mcp_registered: codexMcpRegistered,
    codex_hooks_registered: codexHooksRegistered,
    recent_user_prompts: recentUserPrompts,
    recent_tool_events: recentToolEvents,
    recent_sessions_with_raw_capture: recentSessionsWithRawCapture,
    latest_prompt_epoch: latestPromptEpoch,
    latest_tool_event_epoch: latestToolEventEpoch,
    raw_capture_active:
      recentUserPrompts > 0 ||
      recentToolEvents > 0 ||
      recentSessionsWithRawCapture > 0,
  };
}
