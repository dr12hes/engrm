/**
 * session_story MCP tool.
 *
 * Returns the full local memory story for a session: prompts, tools,
 * observations, summary, and metrics.
 */

import type { ChatMessageRow, MemDatabase, ObservationRow, SessionRow, SessionSummaryRow, ToolEventRow, UserPromptRow } from "../storage/sqlite.js";
import { isDraftHandoff, looksLikeHandoff } from "./handoffs.js";
import {
  getChatCoverageState,
  summarizeChatSources,
  type ChatCoverageState,
  type ChatSourceSummary,
} from "./recent-chat.js";

export interface SessionStoryInput {
  session_id: string;
}

export interface SessionStoryResult {
  session: SessionRow | null;
  project_name: string | null;
  summary: SessionSummaryRow | null;
  prompts: UserPromptRow[];
  chat_messages: ChatMessageRow[];
  chat_source_summary: ChatSourceSummary;
  chat_coverage_state: ChatCoverageState;
  tool_events: ToolEventRow[];
  observations: ObservationRow[];
  handoffs: ObservationRow[];
  saved_handoffs: ObservationRow[];
  rolling_handoff_drafts: ObservationRow[];
  metrics: (SessionRow & {
    files_touched_count: number;
    searches_performed: number;
    tool_calls_count: number;
  }) | null;
  capture_state: "rich" | "partial" | "summary-only" | "legacy";
  capture_gaps: string[];
  latest_request: string | null;
  recent_outcomes: string[];
  hot_files: Array<{ path: string; count: number }>;
  provenance_summary: Array<{ tool: string; count: number }>;
}

export function getSessionStory(
  db: MemDatabase,
  input: SessionStoryInput
): SessionStoryResult {
  const session = db.getSessionById(input.session_id);
  const summary = db.getSessionSummary(input.session_id);
  const prompts = db.getSessionUserPrompts(input.session_id, 50);
  const chatMessages = db.getSessionChatMessages(input.session_id, 50);
  const toolEvents = db.getSessionToolEvents(input.session_id, 100);
  const allObservations = db.getObservationsBySession(input.session_id);
  const handoffs = allObservations.filter((obs) => looksLikeHandoff(obs));
  const rollingHandoffDrafts = handoffs.filter((obs) => isDraftHandoff(obs));
  const savedHandoffs = handoffs.filter((obs) => !isDraftHandoff(obs));
  const observations = allObservations.filter((obs) => !looksLikeHandoff(obs));
  const metrics = db.getSessionMetrics(input.session_id);
  const projectName =
    session?.project_id !== null && session?.project_id !== undefined
      ? db.getProjectById(session.project_id)?.name ?? null
      : null;
  const latestRequest = prompts[prompts.length - 1]?.prompt?.trim()
    || summary?.request?.trim()
    || null;

  return {
    session,
    project_name: projectName,
    summary,
    prompts,
    chat_messages: chatMessages,
    chat_source_summary: summarizeChatSources(chatMessages),
    chat_coverage_state: getChatCoverageState(chatMessages),
    tool_events: toolEvents,
    observations,
    handoffs,
    saved_handoffs: savedHandoffs,
    rolling_handoff_drafts: rollingHandoffDrafts,
    metrics,
    capture_state: classifyCaptureState({
      hasSummary: Boolean(summary?.request || summary?.completed),
      promptCount: prompts.length,
      toolEventCount: toolEvents.length,
    }),
    capture_gaps: buildCaptureGaps({
      promptCount: prompts.length,
      toolEventCount: toolEvents.length,
      toolCallsCount: metrics?.tool_calls_count ?? 0,
        observationCount: observations.length,
      hasSummary: Boolean(summary?.request || summary?.completed),
    }),
    latest_request: latestRequest,
    recent_outcomes: collectRecentOutcomes(observations),
    hot_files: collectHotFiles(observations),
    provenance_summary: collectProvenanceSummary(observations),
  };
}

function classifyCaptureState(input: {
  hasSummary: boolean;
  promptCount: number;
  toolEventCount: number;
}): SessionStoryResult["capture_state"] {
  if (input.promptCount > 0 && input.toolEventCount > 0) return "rich";
  if (input.promptCount > 0 || input.toolEventCount > 0) return "partial";
  if (input.hasSummary) return "summary-only";
  return "legacy";
}

function buildCaptureGaps(input: {
  promptCount: number;
  toolEventCount: number;
  toolCallsCount: number;
  observationCount: number;
  hasSummary: boolean;
}): string[] {
  const gaps: string[] = [];
  if (input.promptCount === 0) gaps.push("missing prompts");
  if (input.toolCallsCount > 0 && input.toolEventCount === 0) {
    gaps.push("missing raw tool chronology");
  } else if (input.toolEventCount === 0) {
    gaps.push("no tool events");
  }
  if (input.observationCount === 0 && input.hasSummary) {
    gaps.push("summary without reusable observations");
  }
  return gaps;
}

function collectRecentOutcomes(observations: ObservationRow[]): string[] {
  const seen = new Set<string>();
  const outcomes: string[] = [];
  for (const obs of observations) {
    if (!["bugfix", "feature", "refactor", "change", "decision"].includes(obs.type)) continue;
    const title = obs.title.trim();
    if (!title || looksLikeFileOperationTitle(title)) continue;
    const normalized = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    outcomes.push(title);
    if (outcomes.length >= 6) break;
  }
  return outcomes;
}

function collectHotFiles(observations: ObservationRow[]): Array<{ path: string; count: number }> {
  const counts = new Map<string, number>();
  for (const obs of observations) {
    for (const path of [...parseJsonArray(obs.files_modified), ...parseJsonArray(obs.files_read)]) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, 8);
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

function looksLikeFileOperationTitle(value: string): boolean {
  return /^(modified|updated|edited|touched|changed|extended|refactored|redesigned)\s+[A-Za-z0-9_.\-\/]+(?:\s*\([^)]*\))?$/i.test(
    value.trim()
  );
}

function collectProvenanceSummary(observations: ObservationRow[]): Array<{ tool: string; count: number }> {
  const counts = new Map<string, number>();
  for (const obs of observations) {
    if (!obs.source_tool) continue;
    counts.set(obs.source_tool, (counts.get(obs.source_tool) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    .slice(0, 6);
}
