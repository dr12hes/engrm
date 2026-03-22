/**
 * memory_console MCP tool.
 *
 * High-signal local overview for testing what Engrm currently knows about
 * a project: sessions, requests, tools, observations, and summary cues.
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase } from "../storage/sqlite.js";
import { getRecentActivity } from "./recent.js";
import { getRecentRequests } from "./recent-prompts.js";
import { getRecentTools } from "./recent-tools.js";
import { getRecentSessions } from "./recent-sessions.js";
import { getProjectMemoryIndex } from "./project-memory-index.js";
import { getRecentChat } from "./recent-chat.js";
import { getRecentHandoffs, isDraftHandoff } from "./handoffs.js";
import { classifyContinuityState, describeContinuityState } from "./project-memory-index.js";

export interface MemoryConsoleInput {
  cwd?: string;
  project_scoped?: boolean;
  user_id?: string;
}

export interface MemoryConsoleResult {
  project?: string;
  capture_mode: "rich" | "observations-only";
  continuity_state: "fresh" | "thin" | "cold";
  continuity_summary: string;
  capture_summary?: ReturnType<typeof getProjectMemoryIndex>["capture_summary"];
  sessions: ReturnType<typeof getRecentSessions>["sessions"];
  requests: ReturnType<typeof getRecentRequests>["prompts"];
  tools: ReturnType<typeof getRecentTools>["tool_events"];
  recent_handoffs: ReturnType<typeof getRecentHandoffs>["handoffs"];
  rolling_handoff_drafts: number;
  saved_handoffs: number;
  recent_chat: ReturnType<typeof getRecentChat>["messages"];
  recent_chat_sessions: number;
  chat_source_summary: {
    transcript: number;
    hook: number;
  };
  chat_coverage_state: "transcript-backed" | "hook-only" | "none";
  observations: ReturnType<typeof getRecentActivity>["observations"];
  recent_outcomes: string[];
  hot_files: Array<{ path: string; count: number }>;
  provenance_summary: Array<{ tool: string; count: number }>;
  assistant_checkpoint_count?: number;
  assistant_checkpoint_types: Array<{ type: string; count: number }>;
  top_types: Array<{ type: string; count: number }>;
  estimated_read_tokens?: number;
  suggested_tools: string[];
}

export function getMemoryConsole(
  db: MemDatabase,
  input: MemoryConsoleInput
): MemoryConsoleResult {
  const cwd = input.cwd ?? process.cwd();
  const projectScoped = input.project_scoped !== false;
  const detected = projectScoped ? detectProject(cwd) : null;
  const project = detected ? db.getProjectByCanonicalId(detected.canonical_id) : null;

  const sessions = getRecentSessions(db, {
      cwd,
      project_scoped: projectScoped,
      user_id: input.user_id,
      limit: 6,
    }).sessions;
  const requests = getRecentRequests(db, {
      cwd,
      project_scoped: projectScoped,
      user_id: input.user_id,
      limit: 6,
    }).prompts;
  const tools = getRecentTools(db, {
      cwd,
      project_scoped: projectScoped,
      user_id: input.user_id,
      limit: 8,
    }).tool_events;
  const observations = getRecentActivity(db, {
      cwd,
      project_scoped: projectScoped,
      user_id: input.user_id,
      limit: 8,
    }).observations;
  const recentHandoffs = getRecentHandoffs(db, {
      cwd,
      project_scoped: projectScoped,
      user_id: input.user_id,
      limit: 4,
    }).handoffs;
  const rollingHandoffDrafts = recentHandoffs.filter((handoff) => isDraftHandoff(handoff)).length;
  const savedHandoffs = recentHandoffs.length - rollingHandoffDrafts;
  const recentChat = getRecentChat(db, {
      cwd,
      project_scoped: projectScoped,
      user_id: input.user_id,
      limit: 6,
    });
  const projectIndex = projectScoped
    ? getProjectMemoryIndex(db, {
        cwd,
        user_id: input.user_id,
      })
    : null;
  const continuityState = projectIndex?.continuity_state ?? classifyContinuityState(
    requests.length,
    tools.length,
    recentHandoffs.length,
    recentChat.messages.length,
    sessions,
    (projectIndex?.recent_outcomes ?? []).length
  );

  return {
    project: project?.name,
    capture_mode: requests.length > 0 || tools.length > 0 ? "rich" : "observations-only",
    continuity_state: continuityState,
    continuity_summary: projectIndex?.continuity_summary ?? describeContinuityState(continuityState),
    sessions,
    requests,
    tools,
    recent_handoffs: recentHandoffs,
    rolling_handoff_drafts: rollingHandoffDrafts,
    saved_handoffs: savedHandoffs,
    recent_chat: recentChat.messages,
    recent_chat_sessions: projectIndex?.recent_chat_sessions ?? recentChat.session_count,
    chat_source_summary: projectIndex?.chat_source_summary ?? recentChat.source_summary,
    chat_coverage_state: projectIndex?.chat_coverage_state ?? (
      recentChat.transcript_backed
        ? "transcript-backed"
        : recentChat.messages.length > 0
          ? "hook-only"
          : "none"
    ),
    observations,
    capture_summary: projectIndex?.capture_summary,
    recent_outcomes: projectIndex?.recent_outcomes ?? [],
    hot_files: projectIndex?.hot_files ?? [],
    provenance_summary: projectIndex?.provenance_summary ?? [],
    assistant_checkpoint_count: projectIndex?.assistant_checkpoint_count,
    assistant_checkpoint_types: projectIndex?.assistant_checkpoint_types ?? [],
    top_types: projectIndex?.top_types ?? [],
    estimated_read_tokens: projectIndex?.estimated_read_tokens,
    suggested_tools: projectIndex?.suggested_tools ?? buildFallbackSuggestedTools(
      sessions.length,
      requests.length,
      tools.length,
      observations.length,
      recentHandoffs.length,
      recentChat.messages.length
    ),
  };
}

function buildFallbackSuggestedTools(
  sessionCount: number,
  requestCount: number,
  toolCount: number,
  observationCount: number,
  handoffCount: number,
  chatCount: number
): string[] {
  const suggested: string[] = [];
  if (sessionCount > 0) suggested.push("recent_sessions");
  if (requestCount > 0 || toolCount > 0) suggested.push("activity_feed");
  if (observationCount > 0) suggested.push("tool_memory_index", "capture_git_worktree");
  if (sessionCount > 0) suggested.push("create_handoff", "recent_handoffs");
  if (handoffCount > 0) suggested.push("load_handoff");
  if (chatCount > 0) suggested.push("recent_chat");
  return Array.from(new Set(suggested)).slice(0, 4);
}
