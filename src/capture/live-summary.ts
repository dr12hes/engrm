import type { ObservationRow, SessionSummaryRow } from "../storage/sqlite.js";

export interface LiveSummaryUpdate {
  investigated?: string | null;
  learned?: string | null;
  completed?: string | null;
}

const LOW_SIGNAL_TITLE_PATTERNS = [
  /^(Modified|Extended|Reduced|Created)\s+\S+/i,
  /^Dependency change:/i,
  /^[a-z0-9._-]+\s*\(error\)$/i,
  /^(engrm|unknown):\s+/i,
];

export function buildLiveSummaryUpdate(
  observation: ObservationRow
): LiveSummaryUpdate | null {
  const title = compactSummaryTitle(observation.title);
  if (!title) return null;

  switch (observation.type) {
    case "discovery":
    case "pattern":
      return { investigated: title };
    case "decision":
      return { learned: title };
    case "bugfix":
    case "feature":
    case "change":
    case "refactor":
      return { completed: title };
    default:
      return null;
  }
}

export function compactSummaryTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim();
  if (!trimmed) return null;
  if (LOW_SIGNAL_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return null;
  }
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

export function mergeLiveSummarySections(
  existing: SessionSummaryRow | null,
  update: LiveSummaryUpdate
): LiveSummaryUpdate {
  return {
    investigated: mergeSectionItem(existing?.investigated ?? null, update.investigated ?? null),
    learned: mergeSectionItem(existing?.learned ?? null, update.learned ?? null),
    completed: mergeSectionItem(existing?.completed ?? null, update.completed ?? null),
  };
}

function mergeSectionItem(existing: string | null, item: string | null): string | null {
  if (!item) return existing;
  if (!existing) return item;

  const lines = existing
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);

  const normalizedItem = item.trim();
  if (lines.some((line) => line.toLowerCase() === normalizedItem.toLowerCase())) {
    return existing;
  }

  return `${existing}\n- ${normalizedItem}`;
}
