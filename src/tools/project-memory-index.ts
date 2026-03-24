/**
 * project_memory_index MCP tool.
 *
 * Gives a structured local overview of a project's captured memory:
 * observation types, recent sessions, prompt/tool volume, and hot files.
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase, ObservationRow, RecentSessionRow } from "../storage/sqlite.js";
import { getRecentSessions } from "./recent-sessions.js";
import { getRecentRequests } from "./recent-prompts.js";
import { getRecentTools } from "./recent-tools.js";
import { getRecentChat, type ChatCoverageState, type ChatSourceSummary } from "./recent-chat.js";
import { getRecentHandoffs, isDraftHandoff } from "./handoffs.js";
import { estimateTokens } from "../context/inject.js";
import { listRecallItems, type RecallIndexItem } from "./list-recall-items.js";

export interface CaptureSummary {
  rich_sessions: number;
  partial_sessions: number;
  summary_only_sessions: number;
  legacy_sessions: number;
}

export interface ProjectMemoryIndexInput {
  cwd?: string;
  user_id?: string;
}

export interface ProjectMemoryIndexResult {
  project: string;
  canonical_id: string;
  continuity_state: "fresh" | "thin" | "cold";
  continuity_summary: string;
  recall_mode: "direct" | "indexed";
  recall_items_ready: number;
  recall_index_preview: Array<Pick<RecallIndexItem, "key" | "kind" | "freshness" | "title">>;
  best_recall_key: string | null;
  best_recall_title: string | null;
  best_recall_kind: "handoff" | "thread" | "chat" | "memory" | null;
  resume_freshness: "live" | "recent" | "stale";
  resume_source_session_id: string | null;
  resume_source_device_id: string | null;
  resume_next_actions: string[];
  observation_counts: Record<string, number>;
  recent_sessions: RecentSessionRow[];
  recent_outcomes: string[];
  recent_requests_count: number;
  recent_tools_count: number;
  recent_handoffs_count: number;
  rolling_handoff_drafts_count: number;
  saved_handoffs_count: number;
  recent_chat_count: number;
  recent_chat_sessions: number;
  chat_source_summary: ChatSourceSummary;
  chat_coverage_state: ChatCoverageState;
  raw_capture_active: boolean;
  capture_summary: CaptureSummary;
  hot_files: Array<{ path: string; count: number }>;
  provenance_summary: Array<{ tool: string; count: number }>;
  assistant_checkpoint_count: number;
  assistant_checkpoint_types: Array<{ type: string; count: number }>;
  top_titles: Array<{ type: string; title: string; id: number }>;
  top_types: Array<{ type: string; count: number }>;
  estimated_read_tokens: number;
  suggested_tools: string[];
}

export function getProjectMemoryIndex(
  db: MemDatabase,
  input: ProjectMemoryIndexInput
): ProjectMemoryIndexResult | null {
  const cwd = input.cwd ?? process.cwd();
  const detected = detectProject(cwd);
  const project = db.getProjectByCanonicalId(detected.canonical_id);
  if (!project) return null;

  const visibilityClause = input.user_id
    ? " AND (sensitivity != 'personal' OR user_id = ?)"
    : "";
  const visibilityParams = input.user_id ? [input.user_id] : [];

  const observations = db.db
    .query<ObservationRow, (number | string)[]>(
      `SELECT * FROM observations
       WHERE project_id = ?
         AND lifecycle IN ('active', 'aging', 'pinned')
         AND superseded_by IS NULL
         ${visibilityClause}
       ORDER BY created_at_epoch DESC`
    )
    .all(project.id, ...visibilityParams);

  const counts: Record<string, number> = {};
  for (const obs of observations) {
    counts[obs.type] = (counts[obs.type] ?? 0) + 1;
  }

  const fileCounts = new Map<string, number>();
  for (const obs of observations) {
    for (const path of extractPaths(obs.files_modified)) {
      fileCounts.set(path, (fileCounts.get(path) ?? 0) + 1);
    }
  }

  const hotFiles = Array.from(fileCounts.entries())
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, 8);
  const provenanceSummary = Array.from(
    observations.reduce((acc, obs) => {
      if (!obs.source_tool) return acc;
      acc.set(obs.source_tool, (acc.get(obs.source_tool) ?? 0) + 1);
      return acc;
    }, new Map<string, number>()).entries()
  )
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    .slice(0, 6);
  const assistantCheckpointCount = observations.filter((obs) => obs.source_tool === "assistant-stop").length;
  const assistantCheckpointTypes = Array.from(
    observations
      .filter((obs) => obs.source_tool === "assistant-stop")
      .reduce((acc, obs) => {
        acc.set(obs.type, (acc.get(obs.type) ?? 0) + 1);
        return acc;
      }, new Map<string, number>())
      .entries()
  )
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
    .slice(0, 5);

  const topTitles = observations
    .slice(0, 12)
    .map((obs) => ({
      type: obs.type,
      title: obs.title,
      id: obs.id,
    }));

  const recentSessions = getRecentSessions(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 6,
  }).sessions;
  const recentRequestsCount = getRecentRequests(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 20,
  }).prompts.length;
  const recentToolsCount = getRecentTools(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 20,
  }).tool_events.length;
  const recentHandoffsCount = getRecentHandoffs(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 10,
  }).handoffs;
  const rollingHandoffDraftsCount = recentHandoffsCount.filter((handoff) => isDraftHandoff(handoff)).length;
  const savedHandoffsCount = recentHandoffsCount.length - rollingHandoffDraftsCount;
  const recentChat = getRecentChat(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 20,
  });
  const recentChatCount = recentChat.messages.length;
  const recallIndex = listRecallItems(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 10,
  });
  const latestSession = recentSessions[0] ?? null;
  const latestSummary = latestSession ? db.getSessionSummary(latestSession.session_id) : null;
  const recentOutcomes = observations
    .filter((obs) => ["bugfix", "feature", "refactor", "change", "decision"].includes(obs.type))
    .map((obs) => obs.title.trim())
    .filter((title) => title.length > 0 && !looksLikeFileOperationTitle(title))
    .slice(0, 8);
  const captureSummary = summarizeCaptureState(recentSessions);
  const topTypes = Object.entries(counts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
    .slice(0, 5);
  const suggestedTools = buildSuggestedTools(
    recentSessions,
    recentRequestsCount,
    recentToolsCount,
    observations.length,
    recentChatCount,
    recentChat.coverage_state
  );
  const estimatedReadTokens = estimateTokens(
    [
      recentOutcomes.join("\n"),
      topTitles.map((item) => `${item.type}: ${item.title}`).join("\n"),
      hotFiles.map((item) => `${item.path} (${item.count})`).join("\n"),
    ].filter(Boolean).join("\n")
  );
  const continuityState = classifyContinuityState(
    recentRequestsCount,
    recentToolsCount,
    recentHandoffsCount.length,
    recentChatCount,
    recentSessions,
    recentOutcomes.length
  );
  const sourceTimestamp = pickResumeSourceTimestamp(latestSession, recentChat.messages);
  const bestRecallItem = pickBestRecallItem(recallIndex.items);

  return {
    project: project.name,
    canonical_id: project.canonical_id,
    continuity_state: continuityState,
    continuity_summary: describeContinuityState(continuityState),
    recall_mode: recallIndex.continuity_mode,
    recall_items_ready: recallIndex.items.length,
    recall_index_preview: recallIndex.items.slice(0, 3).map((item) => ({
      key: item.key,
      kind: item.kind,
      freshness: item.freshness,
      title: item.title,
    })),
    best_recall_key: bestRecallItem?.key ?? null,
    best_recall_title: bestRecallItem?.title ?? null,
    best_recall_kind: bestRecallItem?.kind ?? null,
    resume_freshness: classifyResumeFreshness(sourceTimestamp),
    resume_source_session_id: latestSession?.session_id ?? null,
    resume_source_device_id: latestSession?.device_id ?? null,
    resume_next_actions: collectNextActions(latestSummary?.next_steps),
    observation_counts: counts,
    recent_sessions: recentSessions,
    recent_outcomes: recentOutcomes,
    recent_requests_count: recentRequestsCount,
    recent_tools_count: recentToolsCount,
    recent_handoffs_count: recentHandoffsCount.length,
    rolling_handoff_drafts_count: rollingHandoffDraftsCount,
    saved_handoffs_count: savedHandoffsCount,
    recent_chat_count: recentChatCount,
    recent_chat_sessions: recentChat.session_count,
    chat_source_summary: recentChat.source_summary,
    chat_coverage_state: recentChat.coverage_state,
    raw_capture_active: recentRequestsCount > 0 || recentToolsCount > 0,
    capture_summary: captureSummary,
    hot_files: hotFiles,
    provenance_summary: provenanceSummary,
    assistant_checkpoint_count: assistantCheckpointCount,
    assistant_checkpoint_types: assistantCheckpointTypes,
    top_titles: topTitles,
    top_types: topTypes,
    estimated_read_tokens: estimatedReadTokens,
    suggested_tools: suggestedTools,
  };
}

function pickBestRecallItem(items: RecallIndexItem[]): RecallIndexItem | null {
  return items.find((item) => item.kind !== "memory") ?? items[0] ?? null;
}

function pickResumeSourceTimestamp(
  latestSession: RecentSessionRow | null,
  messages: ReturnType<typeof getRecentChat>["messages"]
): number | null {
  const latestChatEpoch = messages.length > 0
    ? messages[messages.length - 1]?.created_at_epoch ?? null
    : null;
  return latestChatEpoch
    ?? latestSession?.completed_at_epoch
    ?? latestSession?.started_at_epoch
    ?? null;
}

export function classifyResumeFreshness(sourceTimestamp: number | null): ProjectMemoryIndexResult["resume_freshness"] {
  if (!sourceTimestamp) return "stale";
  const ageMs = Date.now() - sourceTimestamp * 1000;
  if (ageMs <= 15 * 60 * 1000) return "live";
  if (ageMs <= 3 * 24 * 60 * 60 * 1000) return "recent";
  return "stale";
}

function collectNextActions(value: string | null | undefined): string[] {
  if (!value) return [];
  const normalized = value
    .split(/\n+/)
    .map((line) => line.replace(/^[\s*-]+/, "").trim())
    .filter((line) => line.length > 0);
  if (normalized.length > 1) return normalized.slice(0, 5);
  return value
    .split(/[.;](?:\s+|$)/)
    .map((item) => item.replace(/^[\s*-]+/, "").trim())
    .filter((item) => item.length > 0)
    .slice(0, 5);
}

export function classifyContinuityState(
  recentRequestsCount: number,
  recentToolsCount: number,
  recentHandoffsCount: number,
  recentChatCount: number,
  recentSessions: RecentSessionRow[],
  recentOutcomesCount: number
): ProjectMemoryIndexResult["continuity_state"] {
  const hasRaw = recentRequestsCount > 0 || recentToolsCount > 0;
  const hasResume = recentHandoffsCount > 0 || recentChatCount > 0;
  const hasSessionThread = recentSessions.length > 0 || recentOutcomesCount > 0;

  if (hasRaw && (hasResume || hasSessionThread)) return "fresh";
  if (hasRaw || hasResume || hasSessionThread) return "thin";
  return "cold";
}

export function describeContinuityState(
  state: ProjectMemoryIndexResult["continuity_state"]
): string {
  switch (state) {
    case "fresh":
      return "Fresh repo-local continuity is available.";
    case "thin":
      return "Only partial continuity is available; recent prompts/chat are safer than older memory.";
    default:
      return "No fresh repo-local continuity yet; older memory should be treated cautiously.";
  }
}

function extractPaths(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function looksLikeFileOperationTitle(value: string): boolean {
  return /^(modified|updated|edited|touched|changed|extended|refactored|redesigned)\s+[A-Za-z0-9_.\-\/]+(?:\s*\([^)]*\))?$/i.test(
    value.trim()
  );
}

function summarizeCaptureState(sessions: Array<RecentSessionRow & { capture_state?: string }>): CaptureSummary {
  const summary: CaptureSummary = {
    rich_sessions: 0,
    partial_sessions: 0,
    summary_only_sessions: 0,
    legacy_sessions: 0,
  };
  for (const session of sessions) {
    switch (session.capture_state) {
      case "rich":
        summary.rich_sessions += 1;
        break;
      case "partial":
        summary.partial_sessions += 1;
        break;
      case "summary-only":
        summary.summary_only_sessions += 1;
        break;
      default:
        summary.legacy_sessions += 1;
        break;
    }
  }
  return summary;
}

function buildSuggestedTools(
  sessions: RecentSessionRow[],
  requestCount: number,
  toolCount: number,
  observationCount: number,
  recentChatCount: number,
  chatCoverageState: ChatCoverageState
): string[] {
  const suggested: string[] = [];
  if (sessions.length > 0) {
    suggested.push("recent_sessions");
  }
  if (requestCount > 0 || toolCount > 0) {
    suggested.push("activity_feed");
  }
  if (requestCount > 0 || recentChatCount > 0 || observationCount > 0) {
    suggested.push("list_recall_items");
    suggested.push("load_recall_item");
    suggested.push("resume_thread");
    suggested.push("search_recall");
  }
  if ((sessions.length > 0 || recentChatCount > 0) && chatCoverageState !== "transcript-backed") {
    suggested.push("repair_recall");
  }
  if (observationCount > 0) {
    suggested.push("tool_memory_index", "capture_git_worktree");
  }
  if (sessions.length > 0) {
    suggested.push("create_handoff", "recent_handoffs");
  }
  if (recentChatCount > 0 && chatCoverageState !== "transcript-backed") {
    suggested.push("refresh_chat_recall");
  }
  if (recentChatCount > 0) {
    suggested.push("recent_chat", "search_chat");
  }
  return Array.from(new Set(suggested)).slice(0, 5);
}
