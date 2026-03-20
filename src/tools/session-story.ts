/**
 * session_story MCP tool.
 *
 * Returns the full local memory story for a session: prompts, tools,
 * observations, summary, and metrics.
 */

import type { MemDatabase, ObservationRow, SessionRow, SessionSummaryRow, ToolEventRow, UserPromptRow } from "../storage/sqlite.js";

export interface SessionStoryInput {
  session_id: string;
}

export interface SessionStoryResult {
  session: SessionRow | null;
  summary: SessionSummaryRow | null;
  prompts: UserPromptRow[];
  tool_events: ToolEventRow[];
  observations: ObservationRow[];
  metrics: (SessionRow & {
    files_touched_count: number;
    searches_performed: number;
    tool_calls_count: number;
  }) | null;
  capture_state: "rich" | "partial" | "summary-only" | "legacy";
  capture_gaps: string[];
}

export function getSessionStory(
  db: MemDatabase,
  input: SessionStoryInput
): SessionStoryResult {
  const session = db.getSessionById(input.session_id);
  const summary = db.getSessionSummary(input.session_id);
  const prompts = db.getSessionUserPrompts(input.session_id, 50);
  const toolEvents = db.getSessionToolEvents(input.session_id, 100);
  const observations = db.getObservationsBySession(input.session_id);
  const metrics = db.getSessionMetrics(input.session_id);

  return {
    session,
    summary,
    prompts,
    tool_events: toolEvents,
    observations,
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
