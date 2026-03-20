import type { ObservationRow, SessionSummaryRow } from "../storage/sqlite.js";
import { extractSummaryItems } from "./summary-sections.js";

export interface SessionInsightMetrics {
  summary_count: number;
  summaries_with_learned: number;
  summaries_with_completed: number;
  summaries_with_next_steps: number;
  total_summary_sections_present: number;
  recent_requests: string[];
  recent_lessons: string[];
  recent_completed: string[];
  next_steps: string[];
}

export function computeSessionInsights(
  summaries: SessionSummaryRow[],
  observations: ObservationRow[]
): SessionInsightMetrics {
  const orderedSummaries = [...summaries].sort(
    (a, b) => (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0)
  );

  const summaryCount = orderedSummaries.length;
  const summariesWithLearned = orderedSummaries.filter((s) => hasContent(s.learned)).length;
  const summariesWithCompleted = orderedSummaries.filter((s) => hasContent(s.completed)).length;
  const summariesWithNextSteps = orderedSummaries.filter((s) => hasContent(s.next_steps)).length;
  const totalSummarySectionsPresent = orderedSummaries.reduce(
    (total, summary) => total + countPresentSections(summary),
    0
  );

  const recentRequests = dedupeLines(
    orderedSummaries
      .map((summary) => summary.request?.trim() ?? "")
      .filter(Boolean)
  ).slice(0, 3);

  const recentLessons = dedupeLines([
    ...orderedSummaries.flatMap((summary) => extractSectionItems(summary.learned)),
    ...extractObservationTitles(observations, ["decision", "pattern", "bugfix"]),
  ]).slice(0, 4);

  const recentCompleted = dedupeLines([
    ...orderedSummaries.flatMap((summary) => extractSectionItems(summary.completed)),
    ...extractObservationTitles(observations, ["feature", "refactor", "change"]),
  ]).slice(0, 4);

  const nextSteps = dedupeLines([
    ...orderedSummaries.flatMap((summary) => extractSectionItems(summary.next_steps)),
    ...extractObservationTitles(observations, ["decision"]).map((title) => `Follow through: ${title}`),
  ]).slice(0, 4);

  return {
    summary_count: summaryCount,
    summaries_with_learned: summariesWithLearned,
    summaries_with_completed: summariesWithCompleted,
    summaries_with_next_steps: summariesWithNextSteps,
    total_summary_sections_present: totalSummarySectionsPresent,
    recent_requests: recentRequests,
    recent_lessons: recentLessons,
    recent_completed: recentCompleted,
    next_steps: nextSteps,
  };
}

function countPresentSections(summary: SessionSummaryRow): number {
  return [
    summary.request,
    summary.investigated,
    summary.learned,
    summary.completed,
    summary.next_steps,
  ].filter(hasContent).length;
}

function extractSectionItems(section: string | null): string[] {
  return extractSummaryItems(section);
}

function extractObservationTitles(observations: ObservationRow[], types: string[]): string[] {
  const typeSet = new Set(types);
  return observations
    .filter((obs) => typeSet.has(obs.type))
    .sort((a, b) => b.created_at_epoch - a.created_at_epoch)
    .map((obs) => obs.title.trim())
    .filter(Boolean);
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const cleaned = line.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function hasContent(value: string | null | undefined): boolean {
  return Boolean(value && value.trim());
}
