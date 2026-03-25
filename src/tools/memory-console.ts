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
import { getRecentChat, type ChatCoverageState, type ChatSourceSummary } from "./recent-chat.js";
import { getRecentHandoffs, isDraftHandoff } from "./handoffs.js";
import { classifyContinuityState, collectActiveAgents, describeContinuityState } from "./project-memory-index.js";
import { listRecallItems, type RecallIndexItem } from "./list-recall-items.js";
import type { RecentObservationRow } from "./recent.js";

export interface MemoryConsoleInput {
  cwd?: string;
  project_scoped?: boolean;
  user_id?: string;
}

export interface MemoryConsoleResult {
  project?: string;
  active_agents: string[];
  cross_agent_active: boolean;
  capture_mode: "rich" | "observations-only";
  continuity_state: "fresh" | "thin" | "cold";
  continuity_summary: string;
  recall_mode: "direct" | "indexed";
  recall_items_ready: number;
  recall_index_preview: Array<Pick<RecallIndexItem, "key" | "kind" | "freshness" | "title" | "source_agent">>;
  best_recall_key: string | null;
  best_recall_title: string | null;
  best_recall_kind: "handoff" | "thread" | "chat" | "memory" | null;
  best_agent_resume_agent: string | null;
  resume_freshness: "live" | "recent" | "stale";
  resume_source_session_id: string | null;
  resume_source_device_id: string | null;
  resume_next_actions: string[];
  capture_summary?: ReturnType<typeof getProjectMemoryIndex>["capture_summary"];
  sessions: ReturnType<typeof getRecentSessions>["sessions"];
  requests: ReturnType<typeof getRecentRequests>["prompts"];
  tools: ReturnType<typeof getRecentTools>["tool_events"];
  recent_handoffs: ReturnType<typeof getRecentHandoffs>["handoffs"];
  rolling_handoff_drafts: number;
  saved_handoffs: number;
  recent_inbox_notes: Array<Pick<RecentObservationRow, "id" | "title" | "created_at_epoch">>;
  latest_inbox_note_title: string | null;
  recent_chat: ReturnType<typeof getRecentChat>["messages"];
  recent_chat_sessions: number;
  chat_source_summary: ChatSourceSummary;
  chat_coverage_state: ChatCoverageState;
  observations: ReturnType<typeof getRecentActivity>["observations"];
  recent_outcomes: string[];
  hot_files: Array<{ path: string; count: number }>;
  provenance_summary: Array<{ tool: string; count: number }>;
  provenance_type_mix: Array<{
    tool: string;
    count: number;
    top_types: Array<{ type: string; count: number }>;
  }>;
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
  const recentInboxNotes = observations
    .filter((obs) => obs.message_kind === "inbox-note")
    .slice(0, 3)
    .map((obs) => ({ id: obs.id, title: obs.title, created_at_epoch: obs.created_at_epoch }));
  const recentChat = getRecentChat(db, {
      cwd,
      project_scoped: projectScoped,
      user_id: input.user_id,
      limit: 6,
    });
  const recallIndex = listRecallItems(db, {
    cwd,
    project_scoped: projectScoped,
    user_id: input.user_id,
    limit: 10,
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
  const activeAgents = projectIndex?.active_agents ?? collectActiveAgents(sessions);

  return {
    project: project?.name,
    active_agents: activeAgents,
    cross_agent_active: projectIndex?.cross_agent_active ?? activeAgents.length > 1,
    capture_mode: requests.length > 0 || tools.length > 0 ? "rich" : "observations-only",
    continuity_state: continuityState,
    continuity_summary: projectIndex?.continuity_summary ?? describeContinuityState(continuityState),
    recall_mode: projectIndex?.recall_mode ?? recallIndex.continuity_mode,
    recall_items_ready: projectIndex?.recall_items_ready ?? recallIndex.items.length,
    recall_index_preview: projectIndex?.recall_index_preview ?? recallIndex.items.slice(0, 3).map((item) => ({
      key: item.key,
      kind: item.kind,
      freshness: item.freshness,
      title: item.title,
      source_agent: item.source_agent,
    })),
    best_recall_key: projectIndex?.best_recall_key ?? (recallIndex.items.find((item) => item.kind !== "memory") ?? recallIndex.items[0] ?? null)?.key ?? null,
    best_recall_title: projectIndex?.best_recall_title ?? (recallIndex.items.find((item) => item.kind !== "memory") ?? recallIndex.items[0] ?? null)?.title ?? null,
    best_recall_kind: projectIndex?.best_recall_kind ?? (recallIndex.items.find((item) => item.kind !== "memory") ?? recallIndex.items[0] ?? null)?.kind ?? null,
    best_agent_resume_agent: projectIndex?.best_agent_resume_agent ?? (activeAgents.length > 1 ? sessions[0]?.agent ?? null : null),
    resume_freshness: projectIndex?.resume_freshness ?? "stale",
    resume_source_session_id: projectIndex?.resume_source_session_id ?? sessions[0]?.session_id ?? null,
    resume_source_device_id: projectIndex?.resume_source_device_id ?? sessions[0]?.device_id ?? null,
    resume_next_actions: projectIndex?.resume_next_actions ?? [],
    sessions,
    requests,
    tools,
    recent_handoffs: recentHandoffs,
    rolling_handoff_drafts: rollingHandoffDrafts,
    saved_handoffs: savedHandoffs,
    recent_inbox_notes: recentInboxNotes,
    latest_inbox_note_title: recentInboxNotes[0]?.title ?? null,
    recent_chat: recentChat.messages,
    recent_chat_sessions: projectIndex?.recent_chat_sessions ?? recentChat.session_count,
    chat_source_summary: projectIndex?.chat_source_summary ?? recentChat.source_summary,
    chat_coverage_state: projectIndex?.chat_coverage_state ?? recentChat.coverage_state,
    observations,
    capture_summary: projectIndex?.capture_summary,
    recent_outcomes: projectIndex?.recent_outcomes ?? [],
    hot_files: projectIndex?.hot_files ?? [],
    provenance_summary: projectIndex?.provenance_summary ?? [],
    provenance_type_mix: collectProvenanceTypeMix(observations),
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
      recentChat.messages.length,
      recentChat.coverage_state,
      activeAgents.length
    ),
  };
}

function collectProvenanceTypeMix(
  observations: ReturnType<typeof getRecentActivity>["observations"]
): Array<{
  tool: string;
  count: number;
  top_types: Array<{ type: string; count: number }>;
}> {
  const grouped = new Map<string, Map<string, number>>();

  for (const observation of observations) {
    if (!observation.source_tool) continue;
    const typeCounts = grouped.get(observation.source_tool) ?? new Map<string, number>();
    typeCounts.set(observation.type, (typeCounts.get(observation.type) ?? 0) + 1);
    grouped.set(observation.source_tool, typeCounts);
  }

  return Array.from(grouped.entries())
    .map(([tool, typeCounts]) => {
      const topTypes = Array.from(typeCounts.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
        .slice(0, 4);
      return {
        tool,
        count: topTypes.reduce((sum, item) => sum + item.count, 0),
        top_types: topTypes,
      };
    })
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    .slice(0, 6);
}

function buildFallbackSuggestedTools(
  sessionCount: number,
  requestCount: number,
  toolCount: number,
  observationCount: number,
  handoffCount: number,
  chatCount: number,
  chatCoverageState: ChatCoverageState,
  activeAgentCount: number
): string[] {
  const suggested: string[] = [];
  if (sessionCount > 0) suggested.push("recent_sessions");
  if (activeAgentCount > 1) suggested.push("agent_memory_index");
  if (requestCount > 0 || toolCount > 0) suggested.push("activity_feed");
  if (requestCount > 0 || chatCount > 0 || observationCount > 0) suggested.push("load_recall_item", "resume_thread", "search_recall");
  if (requestCount > 0 || chatCount > 0 || observationCount > 0) suggested.unshift("list_recall_items");
  if ((sessionCount > 0 || chatCount > 0) && chatCoverageState !== "transcript-backed") suggested.push("repair_recall");
  if (observationCount > 0) suggested.push("tool_memory_index", "capture_git_worktree");
  if (sessionCount > 0) suggested.push("create_handoff", "recent_handoffs");
  if (handoffCount > 0) suggested.push("load_handoff");
  if (chatCount > 0 && chatCoverageState !== "transcript-backed") suggested.push("refresh_chat_recall");
  if (chatCount > 0) suggested.push("recent_chat", "search_chat");
  return Array.from(new Set(suggested)).slice(0, 6);
}
