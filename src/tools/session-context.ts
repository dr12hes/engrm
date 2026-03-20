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

  return {
    project_name: context.project_name,
    canonical_id: context.canonical_id,
    session_count: context.session_count,
    total_active: context.total_active,
    recent_requests: context.recentPrompts?.length ?? 0,
    recent_tools: context.recentToolEvents?.length ?? 0,
    recent_sessions: context.recentSessions?.length ?? 0,
    raw_capture_active:
      (context.recentPrompts?.length ?? 0) > 0 || (context.recentToolEvents?.length ?? 0) > 0,
    preview: formatContextForInjection(context),
  };
}
