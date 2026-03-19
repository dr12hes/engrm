import type { ObservationRow } from "../storage/sqlite.js";

/** Decay window for recency scoring (30 days in seconds). */
const RECENCY_WINDOW_SECONDS = 30 * 86400;

/**
 * Compute a blended relevance score combining quality and recency.
 * Quality contributes 60%, recency 40%. Both are 0-1 normalised.
 * Recency decays linearly over 30 days to 0.
 */
export function computeBlendedScore(
  quality: number,
  createdAtEpoch: number,
  nowEpoch: number
): number {
  const age = nowEpoch - createdAtEpoch;
  const recencyNorm = Math.max(0, Math.min(1, 1 - age / RECENCY_WINDOW_SECONDS));
  return quality * 0.6 + recencyNorm * 0.4;
}

export function observationTypeBoost(type: string): number {
  switch (type) {
    case "decision":
      return 0.2;
    case "pattern":
      return 0.18;
    case "bugfix":
      return 0.14;
    case "feature":
      return 0.12;
    case "discovery":
      return 0.1;
    case "refactor":
      return 0.05;
    case "digest":
      return 0.03;
    case "change":
      return 0;
    default:
      return 0;
  }
}

export function computeObservationPriority(
  obs: ObservationRow,
  nowEpoch: number
): number {
  return computeBlendedScore(obs.quality, obs.created_at_epoch, nowEpoch) + observationTypeBoost(obs.type);
}

function textIncludesQuery(text: string | null | undefined, query: string): boolean {
  return Boolean(text && query && text.toLowerCase().includes(query));
}

function tokenOverlapBoost(text: string | null | undefined, queryTokens: string[]): number {
  if (!text || queryTokens.length === 0) return 0;
  const lower = text.toLowerCase();
  const matched = queryTokens.filter((token) => lower.includes(token)).length;
  if (matched === 0) return 0;
  return Math.min(0.12, matched * 0.03);
}

export function computeSearchRank(
  obs: ObservationRow,
  baseScore: number,
  query: string,
  nowEpoch: number
): number {
  const normalizedQuery = query.trim().toLowerCase();
  const queryTokens = normalizedQuery
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  let matchBoost = 0;
  if (textIncludesQuery(obs.title, normalizedQuery)) matchBoost += 0.2;
  if (textIncludesQuery(obs.facts, normalizedQuery)) matchBoost += 0.15;
  if (textIncludesQuery(obs.narrative, normalizedQuery)) matchBoost += 0.08;
  matchBoost += tokenOverlapBoost(obs.title, queryTokens);
  matchBoost += tokenOverlapBoost(obs.facts, queryTokens);
  matchBoost += tokenOverlapBoost(obs.narrative, queryTokens) * 0.6;

  const lifecycleWeight = obs.lifecycle === "aging" ? 0.7 : 1.0;
  const retrievalScore = baseScore * 20 * lifecycleWeight;
  const priorityBoost = computeObservationPriority(obs, nowEpoch) * 0.12;

  return retrievalScore + priorityBoost + Math.min(0.35, matchBoost);
}
