/**
 * session_context MCP tool.
 *
 * Preview the same project memory context Engrm would inject at session start,
 * without having to restart the client. This makes startup/context iteration
 * much easier to test locally.
 */

import type { MemDatabase } from "../storage/sqlite.js";
import {
  buildSessionContext,
  formatContextForInjection,
  type ContextOptions,
} from "../context/inject.js";

export interface SessionContextInput {
  cwd?: string;
  token_budget?: number;
  scope?: ContextOptions["scope"];
  user_id?: string;
}

export interface SessionContextResult {
  project_name: string;
  canonical_id: string;
  session_count: number;
  total_active: number;
  recent_requests: number;
  recent_tools: number;
  recent_sessions: number;
  recent_outcomes: string[];
  hot_files: Array<{ path: string; count: number }>;
  capture_state: "rich" | "partial" | "summary-only";
  raw_capture_active: boolean;
  preview: string;
}

export function getSessionContext(
  db: MemDatabase,
  input: SessionContextInput
): SessionContextResult | null {
  const cwd = input.cwd ?? process.cwd();
  const context = buildSessionContext(db, cwd, {
    tokenBudget: input.token_budget,
    scope: input.scope,
    userId: input.user_id,
  });

  if (!context) return null;

  const recentRequests = context.recentPrompts?.length ?? 0;
  const recentTools = context.recentToolEvents?.length ?? 0;
  const captureState: SessionContextResult["capture_state"] =
    recentRequests > 0 && recentTools > 0
      ? "rich"
      : recentRequests > 0 || recentTools > 0
        ? "partial"
        : "summary-only";
  const hotFiles = buildHotFiles(context);

  return {
    project_name: context.project_name,
    canonical_id: context.canonical_id,
    session_count: context.session_count,
    total_active: context.total_active,
    recent_requests: recentRequests,
    recent_tools: recentTools,
    recent_sessions: context.recentSessions?.length ?? 0,
    recent_outcomes: context.recentOutcomes ?? [],
    hot_files: hotFiles,
    capture_state: captureState,
    raw_capture_active: recentRequests > 0 || recentTools > 0,
    preview: formatContextForInjection(context),
  };
}

function buildHotFiles(context: NonNullable<ReturnType<typeof buildSessionContext>>): Array<{ path: string; count: number }> {
  const counts = new Map<string, number>();
  for (const obs of context.observations) {
    for (const path of [...parseJsonArray(obs.files_read), ...parseJsonArray(obs.files_modified)]) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, 6);
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}
