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
  estimateTokens,
  formatContextForInjection,
  type ContextOptions,
} from "../context/inject.js";
import { getRecentChat, type ChatCoverageState, type ChatSourceSummary } from "./recent-chat.js";
import { classifyContinuityState, describeContinuityState } from "./project-memory-index.js";

export interface SessionContextInput {
  cwd?: string;
  token_budget?: number;
  scope?: ContextOptions["scope"];
  user_id?: string;
  current_device_id?: string;
}

export interface SessionContextResult {
  project_name: string;
  canonical_id: string;
  continuity_state: "fresh" | "thin" | "cold";
  continuity_summary: string;
  session_count: number;
  total_active: number;
  recent_requests: number;
  recent_tools: number;
  recent_sessions: number;
  recent_handoffs: number;
  rolling_handoff_drafts: number;
  saved_handoffs: number;
  latest_handoff_title: string | null;
  recent_chat_messages: number;
  recent_chat_sessions: number;
  chat_source_summary: ChatSourceSummary;
  chat_coverage_state: ChatCoverageState;
  recent_outcomes: string[];
  hot_files: Array<{ path: string; count: number }>;
  capture_state: "rich" | "partial" | "summary-only";
  raw_capture_active: boolean;
  estimated_read_tokens: number;
  suggested_tools: string[];
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
    currentDeviceId: input.current_device_id,
  });

  if (!context) return null;

  const preview = formatContextForInjection(context);

  const recentRequests = context.recentPrompts?.length ?? 0;
  const recentTools = context.recentToolEvents?.length ?? 0;
  const recentHandoffs = context.recentHandoffs?.length ?? 0;
  const rollingHandoffDrafts = (context.recentHandoffs ?? []).filter((handoff) => handoff.title.startsWith("Handoff Draft:")).length;
  const savedHandoffs = recentHandoffs - rollingHandoffDrafts;
  const latestHandoffTitle = context.recentHandoffs?.[0]?.title ?? null;
  const recentChat = getRecentChat(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 8,
  });
  const recentChatMessages = recentChat.messages.length;
  const captureState: SessionContextResult["capture_state"] =
    recentRequests > 0 && recentTools > 0
      ? "rich"
      : recentRequests > 0 || recentTools > 0
        ? "partial"
        : "summary-only";
  const hotFiles = buildHotFiles(context);
  const continuityState = classifyContinuityState(
    recentRequests,
    recentTools,
    recentHandoffs,
    recentChatMessages,
    context.recentSessions ?? [],
    (context.recentOutcomes ?? []).length
  );

  return {
    project_name: context.project_name,
    canonical_id: context.canonical_id,
    continuity_state: continuityState,
    continuity_summary: describeContinuityState(continuityState),
    session_count: context.session_count,
    total_active: context.total_active,
    recent_requests: recentRequests,
    recent_tools: recentTools,
    recent_sessions: context.recentSessions?.length ?? 0,
    recent_handoffs: recentHandoffs,
    rolling_handoff_drafts: rollingHandoffDrafts,
    saved_handoffs: savedHandoffs,
    latest_handoff_title: latestHandoffTitle,
    recent_chat_messages: recentChatMessages,
    recent_chat_sessions: recentChat.session_count,
    chat_source_summary: recentChat.source_summary,
    chat_coverage_state: recentChat.coverage_state,
    recent_outcomes: context.recentOutcomes ?? [],
    hot_files: hotFiles,
    capture_state: captureState,
    raw_capture_active: recentRequests > 0 || recentTools > 0,
    estimated_read_tokens: estimateTokens(preview),
    suggested_tools: buildSuggestedTools(context, recentChat.coverage_state),
    preview,
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

function buildSuggestedTools(
  context: NonNullable<ReturnType<typeof buildSessionContext>>,
  chatCoverageState: ChatCoverageState
): string[] {
  const tools: string[] = [];
  if ((context.recentSessions?.length ?? 0) > 0) {
    tools.push("recent_sessions");
  }
  if ((context.recentPrompts?.length ?? 0) > 0 || (context.recentToolEvents?.length ?? 0) > 0) {
    tools.push("activity_feed");
  }
  if (
    (context.recentPrompts?.length ?? 0) > 0 ||
    (context.recentChatMessages?.length ?? 0) > 0 ||
    context.observations.length > 0
  ) {
    tools.push("resume_thread");
    tools.push("search_recall");
  }
  if (
    ((context.recentSessions?.length ?? 0) > 0 || (context.recentChatMessages?.length ?? 0) > 0)
    && chatCoverageState !== "transcript-backed"
  ) {
    tools.push("repair_recall");
  }
  if (context.observations.length > 0) {
    tools.push("tool_memory_index", "capture_git_worktree");
  }
  if ((context.recentSessions?.length ?? 0) > 0) {
    tools.push("create_handoff", "recent_handoffs");
  }
  if ((context.recentHandoffs?.length ?? 0) > 0) {
    tools.push("load_handoff");
  }
  if ((context.recentChatMessages?.length ?? 0) > 0 && chatCoverageState !== "transcript-backed") {
    tools.push("refresh_chat_recall");
  }
  if ((context.recentChatMessages?.length ?? 0) > 0) {
    tools.push("recent_chat", "search_chat");
  }
  return Array.from(new Set(tools)).slice(0, 5);
}
