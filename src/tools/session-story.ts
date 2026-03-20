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
}

export function getSessionStory(
  db: MemDatabase,
  input: SessionStoryInput
): SessionStoryResult {
  return {
    session: db.getSessionById(input.session_id),
    summary: db.getSessionSummary(input.session_id),
    prompts: db.getSessionUserPrompts(input.session_id, 50),
    tool_events: db.getSessionToolEvents(input.session_id, 100),
    observations: db.getObservationsBySession(input.session_id),
    metrics: db.getSessionMetrics(input.session_id),
  };
}
