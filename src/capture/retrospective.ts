/**
 * Session retrospective extraction (heuristic, client-side).
 *
 * Groups session observations by type to generate a structured summary
 * of what was requested, investigated, learned, completed, and what's next.
 * No LLM needed — works entirely from observation metadata.
 */

import type { ObservationRow } from "../storage/sqlite.js";
import type { InsertSessionSummary } from "../storage/sqlite.js";

/**
 * Extract a retrospective summary from a session's observations.
 * Returns null if there are no observations to summarize.
 */
export function extractRetrospective(
  observations: ObservationRow[],
  sessionId: string,
  projectId: number | null,
  userId: string
): InsertSessionSummary | null {
  if (observations.length === 0) return null;

  const request = extractRequest(observations);
  const investigated = extractInvestigated(observations);
  const learned = extractLearned(observations);
  const completed = extractCompleted(observations);
  const nextSteps = extractNextSteps(observations);

  // Don't create empty summaries
  if (!request && !investigated && !learned && !completed && !nextSteps) {
    return null;
  }

  return {
    session_id: sessionId,
    project_id: projectId,
    user_id: userId,
    request,
    investigated,
    learned,
    completed,
    next_steps: nextSteps,
  };
}

/**
 * Derive the session request from the first observation's context.
 */
function extractRequest(observations: ObservationRow[]): string | null {
  const first = observations[0];
  if (!first) return null;
  return first.title;
}

/**
 * Summarize what was investigated (discovery-type observations).
 * Includes facts when available for richer context.
 */
function extractInvestigated(observations: ObservationRow[]): string | null {
  const discoveries = observations.filter((o) => o.type === "discovery");
  if (discoveries.length === 0) return null;

  return discoveries
    .slice(0, 5)
    .map((o) => {
      const facts = extractTopFacts(o, 2);
      return facts ? `- ${o.title}\n${facts}` : `- ${o.title}`;
    })
    .join("\n");
}

/**
 * Summarize what was learned (bugfix, decision, pattern observations).
 * Includes key facts so "lessons learned" is actually useful.
 */
function extractLearned(observations: ObservationRow[]): string | null {
  const learnTypes = new Set(["bugfix", "decision", "pattern"]);
  const learned = observations.filter((o) => learnTypes.has(o.type));
  if (learned.length === 0) return null;

  return learned
    .slice(0, 5)
    .map((o) => {
      const facts = extractTopFacts(o, 2);
      return facts ? `- ${o.title}\n${facts}` : `- ${o.title}`;
    })
    .join("\n");
}

/**
 * Summarize what was completed (change, feature, refactor observations).
 */
function extractCompleted(observations: ObservationRow[]): string | null {
  const completeTypes = new Set(["change", "feature", "refactor"]);
  const completed = observations.filter((o) => completeTypes.has(o.type));
  if (completed.length === 0) return null;

  // For completed items, include file context when available
  return completed
    .slice(0, 5)
    .map((o) => {
      const files = o.files_modified ? parseJsonArray(o.files_modified) : [];
      const fileCtx =
        files.length > 0
          ? ` (${files.slice(0, 2).map((f) => f.split("/").pop()).join(", ")})`
          : "";
      return `- ${o.title}${fileCtx}`;
    })
    .join("\n");
}

/**
 * Extract next steps from error observations without resolution.
 * Bugfix observations that appear late in the session (last 25%)
 * and reference errors suggest unfinished work.
 */
function extractNextSteps(observations: ObservationRow[]): string | null {
  if (observations.length < 2) return null;

  const lastQuarterStart = Math.floor(observations.length * 0.75);
  const lastQuarter = observations.slice(lastQuarterStart);

  const unresolved = lastQuarter.filter(
    (o) =>
      o.type === "bugfix" &&
      o.narrative &&
      /error|fail|exception/i.test(o.narrative)
  );

  if (unresolved.length === 0) return null;

  return unresolved
    .map((o) => `- Investigate: ${o.title}`)
    .slice(0, 3)
    .join("\n");
}

/**
 * Extract top N facts from an observation's JSON facts array.
 * Returns indented bullet points or null.
 */
function extractTopFacts(obs: ObservationRow, n: number): string | null {
  const facts = parseJsonArray(obs.facts);
  if (facts.length === 0) return null;
  return facts
    .slice(0, n)
    .map((f) => `    ${f}`)
    .join("\n");
}

/**
 * Parse a JSON array string, returning empty array on failure.
 */
function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter((f) => typeof f === "string" && f.length > 0);
    }
  } catch {
    // Not valid JSON
  }
  return [];
}
