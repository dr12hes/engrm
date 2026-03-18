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

  return formatObservationGroup(discoveries, {
    limit: 4,
    factsPerItem: 2,
  });
}

/**
 * Summarize what was learned (bugfix, decision, pattern observations).
 * Includes key facts so "lessons learned" is actually useful.
 */
function extractLearned(observations: ObservationRow[]): string | null {
  const learnTypes = new Set(["bugfix", "decision", "pattern"]);
  const learned = observations.filter((o) => learnTypes.has(o.type));
  if (learned.length === 0) return null;

  return formatObservationGroup(learned, {
    limit: 4,
    factsPerItem: 2,
  });
}

/**
 * Summarize what was completed (change, feature, refactor observations).
 */
function extractCompleted(observations: ObservationRow[]): string | null {
  const completeTypes = new Set(["change", "feature", "refactor"]);
  const completed = observations.filter((o) => completeTypes.has(o.type));
  if (completed.length === 0) return null;

  const prioritized = dedupeObservationsByTitle(completed)
    .sort((a, b) => scoreCompletedObservation(b) - scoreCompletedObservation(a))
    .slice(0, 4);

  const lines = prioritized.map((o) => {
    const title = normalizeCompletedTitle(o.title, o.files_modified);
    const facts = extractTopFacts(o, 1);
    return facts ? `- ${title}\n${facts}` : `- ${title}`;
  });

  return dedupeBulletLines(lines).join("\n");
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

function formatObservationGroup(
  observations: ObservationRow[],
  options: { limit: number; factsPerItem: number }
): string | null {
  const lines = dedupeObservationsByTitle(observations)
    .slice(0, options.limit)
    .map((o) => {
      const facts = extractTopFacts(o, options.factsPerItem);
      return facts ? `- ${o.title}\n${facts}` : `- ${o.title}`;
    });
  const deduped = dedupeBulletLines(lines);
  return deduped.length ? deduped.join("\n") : null;
}

function dedupeBulletLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    const normalized = line
      .toLowerCase()
      .replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(line);
  }
  return deduped;
}

function dedupeObservationsByTitle(observations: ObservationRow[]): ObservationRow[] {
  const seen = new Set<string>();
  const deduped: ObservationRow[] = [];
  for (const obs of observations) {
    const normalized = normalizeObservationKey(obs.title);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(obs);
  }
  return deduped;
}

function scoreCompletedObservation(obs: ObservationRow): number {
  let score = obs.quality || 0;
  if (obs.type === "feature") score += 0.5;
  if (obs.type === "refactor") score += 0.2;
  if (hasMeaningfulFacts(obs)) score += 0.4;
  if (looksLikeFileOperation(obs.title)) score -= 0.6;
  if (obs.narrative && obs.narrative.length > 80) score += 0.2;
  return score;
}

function hasMeaningfulFacts(obs: ObservationRow): boolean {
  return parseJsonArray(obs.facts).some((fact) => fact.trim().length > 20);
}

function looksLikeFileOperation(title: string): boolean {
  return /^(modified|updated|edited|touched|changed)\s+[A-Za-z0-9_.\-\/]+$/i.test(title.trim());
}

function normalizeCompletedTitle(title: string, filesModified: string | null): string {
  const trimmed = title.trim();
  if (!trimmed) return "Completed work";
  if (!looksLikeFileOperation(trimmed)) return trimmed;

  const files = parseJsonArray(filesModified);
  const filename = files[0]?.split("/").pop();
  if (filename) {
    return `Updated implementation in ${filename}`;
  }
  return trimmed;
}

/**
 * Extract top N facts from an observation's JSON facts array.
 * Returns indented bullet points or null.
 */
function extractTopFacts(obs: ObservationRow, n: number): string | null {
  const facts = parseJsonArray(obs.facts)
    .filter((fact) => isUsefulFact(fact, obs.title))
    .slice(0, n);
  if (facts.length === 0) return null;
  return facts
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

function isUsefulFact(fact: string, title: string): boolean {
  const cleaned = fact.trim();
  if (!cleaned) return false;

  const normalizedFact = normalizeObservationKey(cleaned);
  const normalizedTitle = normalizeObservationKey(title);
  if (normalizedFact && normalizedFact === normalizedTitle) return false;

  if (/^[A-Za-z0-9_.\-\/]+\.[A-Za-z0-9]+$/.test(cleaned)) return false;
  if (/^\(?[A-Za-z0-9_.\-\/]+\.[A-Za-z0-9]+\)?$/.test(cleaned)) return false;

  return cleaned.length > 16 || /[:;]/.test(cleaned);
}

function normalizeObservationKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\b(modified|updated|edited|touched|changed)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
