/**
 * Decision follow-through detection.
 *
 * Cross-references decision observations against subsequent code changes
 * (feature, bugfix, change, refactor) to find commitments that were never
 * implemented. Surfaces stale decisions at session start so the agent
 * (and user) know what's been dropped.
 *
 * No LLM. No server call. Pure local SQLite queries + Jaccard similarity.
 *
 * "We know what we did. We don't know what we didn't."
 */

import type { MemDatabase, ObservationRow } from "../storage/sqlite.js";
import { jaccardSimilarity } from "../capture/dedup.js";

export interface StaleDecision {
  id: number;
  title: string;
  narrative: string | null;
  concepts: string[];
  created_at: string;
  days_ago: number;
  /** Best matching follow-up observation (if any partial match exists) */
  best_match_title?: string;
  best_match_similarity?: number;
}

/**
 * Similarity threshold for considering a code change as "implementing" a decision.
 * Lower than dedup (0.8) because decision titles and implementation titles
 * won't be identical — "Add rate limiting to API" vs "Implemented rate limiter middleware"
 * share concepts but not exact wording.
 */
const FOLLOW_THROUGH_THRESHOLD = 0.25;

/**
 * How many days before a decision without implementation is considered stale.
 * 3 days is aggressive enough to catch real gaps without being noisy.
 */
const STALE_AFTER_DAYS = 3;

/**
 * How far back to look for decisions (days).
 * Beyond 30 days, decisions are either done or deliberately abandoned.
 */
const DECISION_WINDOW_DAYS = 30;

/** Implementation observation types — these are what "doing the work" looks like */
const IMPLEMENTATION_TYPES = new Set([
  "feature", "bugfix", "change", "refactor",
]);

/**
 * Find decisions that have no matching implementation.
 *
 * Strategy:
 *   1. Fetch all decision observations from the last N days
 *   2. Fetch all implementation observations created AFTER each decision
 *   3. For each decision, check if any implementation matches by:
 *      a. Jaccard similarity on title (loose threshold)
 *      b. Concept overlap (shared tags)
 *   4. If no match found and decision is older than STALE_AFTER_DAYS → stale
 */
export function findStaleDecisions(
  db: MemDatabase,
  projectId: number,
  options?: {
    staleAfterDays?: number;
    windowDays?: number;
  }
): StaleDecision[] {
  const staleAfterDays = options?.staleAfterDays ?? STALE_AFTER_DAYS;
  const windowDays = options?.windowDays ?? DECISION_WINDOW_DAYS;

  const nowEpoch = Math.floor(Date.now() / 1000);
  const windowStart = nowEpoch - windowDays * 86400;
  const staleThreshold = nowEpoch - staleAfterDays * 86400;

  // 1. Fetch decisions in the window
  const decisions = db.db
    .query<ObservationRow, [number, number]>(
      `SELECT * FROM observations
       WHERE project_id = ? AND type = 'decision'
       AND lifecycle IN ('active', 'aging', 'pinned')
       AND superseded_by IS NULL
       AND created_at_epoch >= ?
       ORDER BY created_at_epoch DESC`
    )
    .all(projectId, windowStart);

  if (decisions.length === 0) return [];

  // 2. Fetch all implementation observations in the same window
  //    (we'll filter by "created after decision" per-decision below)
  const implementations = db.db
    .query<ObservationRow, [number, number]>(
      `SELECT * FROM observations
       WHERE project_id = ? AND type IN ('feature', 'bugfix', 'change', 'refactor')
       AND lifecycle IN ('active', 'aging', 'pinned')
       AND superseded_by IS NULL
       AND created_at_epoch >= ?
       ORDER BY created_at_epoch DESC`
    )
    .all(projectId, windowStart);

  // 3. Also check cross-project implementations (decisions might be
  //    implemented in a different repo — e.g., "add rate limiting" decided
  //    in Engrm, implemented in Candengo Vector)
  const crossProjectImpls = db.db
    .query<ObservationRow, [number, number]>(
      `SELECT * FROM observations
       WHERE project_id != ? AND type IN ('feature', 'bugfix', 'change', 'refactor')
       AND lifecycle IN ('active', 'aging', 'pinned')
       AND superseded_by IS NULL
       AND created_at_epoch >= ?
       ORDER BY created_at_epoch DESC
       LIMIT 200`
    )
    .all(projectId, windowStart);

  const allImpls = [...implementations, ...crossProjectImpls];

  // 4. For each decision, look for a matching implementation
  const stale: StaleDecision[] = [];

  for (const decision of decisions) {
    // Only flag decisions old enough to have been acted on
    if (decision.created_at_epoch > staleThreshold) continue;

    const daysAgo = Math.floor((nowEpoch - decision.created_at_epoch) / 86400);

    // Parse decision concepts for concept-overlap matching
    let decisionConcepts: string[] = [];
    try {
      const parsed = decision.concepts ? JSON.parse(decision.concepts) : [];
      if (Array.isArray(parsed)) decisionConcepts = parsed;
    } catch { /* ignore */ }

    // Find the best matching implementation (created AFTER the decision)
    let bestTitle = "";
    let bestScore = 0;

    for (const impl of allImpls) {
      // Only consider implementations created after this decision
      if (impl.created_at_epoch <= decision.created_at_epoch) continue;

      // Title similarity (main signal)
      const titleScore = jaccardSimilarity(decision.title, impl.title);

      // Concept overlap (secondary signal)
      let conceptBoost = 0;
      if (decisionConcepts.length > 0) {
        try {
          const implConcepts: string[] = impl.concepts
            ? JSON.parse(impl.concepts)
            : [];
          if (Array.isArray(implConcepts) && implConcepts.length > 0) {
            const decSet = new Set(decisionConcepts.map(c => c.toLowerCase()));
            const overlap = implConcepts.filter(c => decSet.has(c.toLowerCase())).length;
            conceptBoost = overlap / Math.max(decisionConcepts.length, 1) * 0.15;
          }
        } catch { /* ignore */ }
      }

      // Narrative keyword match (tertiary signal — check if implementation
      // narrative mentions the decision title keywords)
      let narrativeBoost = 0;
      if (impl.narrative) {
        const decWords = new Set(
          decision.title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3)
        );
        if (decWords.size > 0) {
          const implNarrativeLower = impl.narrative.toLowerCase();
          const hits = [...decWords].filter(w => implNarrativeLower.includes(w)).length;
          narrativeBoost = (hits / decWords.size) * 0.1;
        }
      }

      const totalScore = titleScore + conceptBoost + narrativeBoost;
      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestTitle = impl.title;
      }
    }

    // If no implementation clears the threshold → stale
    if (bestScore < FOLLOW_THROUGH_THRESHOLD) {
      stale.push({
        id: decision.id,
        title: decision.title,
        narrative: decision.narrative,
        concepts: decisionConcepts,
        created_at: decision.created_at,
        days_ago: daysAgo,
        ...(bestScore > 0.1 ? {
          best_match_title: bestTitle,
          best_match_similarity: Math.round(bestScore * 100) / 100,
        } : {}),
      });
    }
  }

  // Sort by age (oldest first — most urgent)
  stale.sort((a, b) => b.days_ago - a.days_ago);

  // Cap at 5 to avoid context bloat
  return stale.slice(0, 5);
}

/**
 * Variant for cross-project follow-through when project is unknown.
 * Searches ALL decisions across all projects.
 */
export function findStaleDecisionsGlobal(
  db: MemDatabase,
  options?: {
    staleAfterDays?: number;
    windowDays?: number;
  }
): StaleDecision[] {
  const staleAfterDays = options?.staleAfterDays ?? STALE_AFTER_DAYS;
  const windowDays = options?.windowDays ?? DECISION_WINDOW_DAYS;

  const nowEpoch = Math.floor(Date.now() / 1000);
  const windowStart = nowEpoch - windowDays * 86400;
  const staleThreshold = nowEpoch - staleAfterDays * 86400;

  const decisions = db.db
    .query<ObservationRow, [number]>(
      `SELECT * FROM observations
       WHERE type = 'decision'
       AND lifecycle IN ('active', 'aging', 'pinned')
       AND superseded_by IS NULL
       AND created_at_epoch >= ?
       ORDER BY created_at_epoch DESC`
    )
    .all(windowStart);

  if (decisions.length === 0) return [];

  const implementations = db.db
    .query<ObservationRow, [number]>(
      `SELECT * FROM observations
       WHERE type IN ('feature', 'bugfix', 'change', 'refactor')
       AND lifecycle IN ('active', 'aging', 'pinned')
       AND superseded_by IS NULL
       AND created_at_epoch >= ?
       ORDER BY created_at_epoch DESC
       LIMIT 500`
    )
    .all(windowStart);

  const stale: StaleDecision[] = [];

  for (const decision of decisions) {
    if (decision.created_at_epoch > staleThreshold) continue;
    const daysAgo = Math.floor((nowEpoch - decision.created_at_epoch) / 86400);

    let decisionConcepts: string[] = [];
    try {
      const parsed = decision.concepts ? JSON.parse(decision.concepts) : [];
      if (Array.isArray(parsed)) decisionConcepts = parsed;
    } catch { /* ignore */ }

    let bestScore = 0;
    let bestTitle = "";

    for (const impl of implementations) {
      if (impl.created_at_epoch <= decision.created_at_epoch) continue;

      const titleScore = jaccardSimilarity(decision.title, impl.title);

      let conceptBoost = 0;
      if (decisionConcepts.length > 0) {
        try {
          const implConcepts: string[] = impl.concepts ? JSON.parse(impl.concepts) : [];
          if (Array.isArray(implConcepts) && implConcepts.length > 0) {
            const decSet = new Set(decisionConcepts.map(c => c.toLowerCase()));
            const overlap = implConcepts.filter(c => decSet.has(c.toLowerCase())).length;
            conceptBoost = overlap / Math.max(decisionConcepts.length, 1) * 0.15;
          }
        } catch { /* ignore */ }
      }

      const totalScore = titleScore + conceptBoost;
      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestTitle = impl.title;
      }
    }

    if (bestScore < FOLLOW_THROUGH_THRESHOLD) {
      stale.push({
        id: decision.id,
        title: decision.title,
        narrative: decision.narrative,
        concepts: decisionConcepts,
        created_at: decision.created_at,
        days_ago: daysAgo,
        ...(bestScore > 0.1 ? {
          best_match_title: bestTitle,
          best_match_similarity: Math.round(bestScore * 100) / 100,
        } : {}),
      });
    }
  }

  stale.sort((a, b) => b.days_ago - a.days_ago);
  return stale.slice(0, 5);
}
