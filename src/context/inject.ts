/**
 * Context injection for session start.
 *
 * When a Claude Code session begins, we search memory for relevant
 * observations from the current project and inject them as context.
 * This gives the agent prior knowledge without being asked.
 *
 * Optimizations:
 *   - Token budget (not count limit) prevents context blowup at scale
 *   - Facts-first: shows facts[] bullets instead of narrative prose (~50% denser)
 *   - Tiered: top 3 get detail, rest are title-only
 *   - Blended scoring: quality * 0.6 + recency * 0.4 (recent medium-quality beats old high-quality)
 *   - Recent-first: last 5 observations always included for session continuity
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase, ObservationRow, SessionSummaryRow, SecurityFindingRow } from "../storage/sqlite.js";
import { findStaleDecisions, findStaleDecisionsGlobal } from "../intelligence/followthrough.js";
import type { StaleDecision } from "../intelligence/followthrough.js";

export interface ContextOptions {
  /** Max tokens for context injection (default: 3000) */
  tokenBudget?: number;
  /** Max observations to return (legacy, overrides tokenBudget if set) */
  maxCount?: number;
  /** Number of observations to show with full detail (default: 5) */
  detailedCount?: number;
  /** Search scope: "personal" (default), "team", or "all" (cross-project) */
  scope?: "personal" | "team" | "all";
  /** Current user for visibility filtering */
  userId?: string;
}

export interface RecentProject {
  name: string;
  canonical_id: string;
  observation_count: number;
  last_active: string;
  days_ago: number;
}

export interface InjectedContext {
  project_name: string;
  canonical_id: string;
  observations: ContextObservation[];
  /** Number of observations included in context */
  session_count: number;
  /** Total active observations in project (for footer) */
  total_active: number;
  /** Recent session summaries for lessons learned */
  summaries?: SessionSummaryRow[];
  /** Unresolved security findings from recent sessions */
  securityFindings?: SecurityFindingRow[];
  /** Projects in memory — shown when current project is new/unknown */
  recentProjects?: RecentProject[];
  /** Decisions with no matching implementation — "what you didn't do" */
  staleDecisions?: StaleDecision[];
}

export interface ContextObservation {
  id: number;
  type: string;
  title: string;
  narrative: string | null;
  facts: string | null;
  quality: number;
  created_at: string;
  /** Present when observation is from a different project (cross-project search) */
  source_project?: string;
}

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

/**
 * Estimate token count from text.
 * Uses ~4 chars per token heuristic (standard for English).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Build context for a new session.
 *
 * Strategy:
 *   1. Get pinned observations (always relevant, always included)
 *   2. Get most recent observations (always included for session continuity)
 *   3. Fetch candidates sorted by quality, apply token budget
 *   4. Tier output: top N detailed, rest title-only
 */
export function buildSessionContext(
  db: MemDatabase,
  cwd: string,
  options: ContextOptions | number = {}
): InjectedContext | null {
  // Backwards compat: accept number as legacy maxCount
  const opts: ContextOptions =
    typeof options === "number" ? { maxCount: options } : options;
  const tokenBudget = opts.tokenBudget ?? 3000;
  const maxCount = opts.maxCount;
  const visibilityClause = opts.userId
    ? " AND (sensitivity != 'personal' OR user_id = ?)"
    : "";
  const visibilityParams = opts.userId ? [opts.userId] : [];

  const detected = detectProject(cwd);
  const project = db.getProjectByCanonicalId(detected.canonical_id);

  // When the project is unknown (new folder, never had observations),
  // still do cross-project search. This is the core value prop —
  // memory follows you across projects.
  const projectId = project?.id ?? -1;
  const isNewProject = !project;

  // Count total active observations for footer (exclude superseded)
  const totalActive = isNewProject
    ? (
        db.db
          .query<{ c: number }, string[]>(
            `SELECT COUNT(*) as c FROM observations
             WHERE lifecycle IN ('active', 'aging', 'pinned')
             ${visibilityClause}
             AND superseded_by IS NULL`
          )
          .get(...visibilityParams) ?? { c: 0 }
      ).c
    : (
        db.db
          .query<{ c: number }, (number | string)[]>(
            `SELECT COUNT(*) as c FROM observations
             WHERE project_id = ? AND lifecycle IN ('active', 'aging', 'pinned')
             ${visibilityClause}
             AND superseded_by IS NULL`
          )
          .get(projectId, ...visibilityParams) ?? { c: 0 }
      ).c;

  // For new projects, pinned/recent/candidates are empty — we rely on cross-project
  const candidateLimit = maxCount ?? 50;
  let pinned: ObservationRow[] = [];
  let recent: ObservationRow[] = [];
  let candidates: ObservationRow[] = [];

  if (!isNewProject) {
    // Get pinned observations (always included, capped to prevent budget exhaustion)
    const MAX_PINNED = 5;
    pinned = db.db
      .query<ObservationRow, (number | string)[]>(
        `SELECT * FROM observations
         WHERE project_id = ? AND lifecycle = 'pinned'
         AND superseded_by IS NULL
         ${visibilityClause}
         ORDER BY quality DESC, created_at_epoch DESC
         LIMIT ?`
      )
      .all(projectId, ...visibilityParams, MAX_PINNED);

    // Get most recent observations (always included, regardless of quality).
    // This ensures session continuity — when restarting Claude, the latest
    // observations from the previous session are always visible.
    const MAX_RECENT = 5;
    recent = db.db
      .query<ObservationRow, (number | string)[]>(
        `SELECT * FROM observations
         WHERE project_id = ? AND lifecycle IN ('active', 'aging')
         AND superseded_by IS NULL
         ${visibilityClause}
         ORDER BY created_at_epoch DESC
         LIMIT ?`
      )
      .all(projectId, ...visibilityParams, MAX_RECENT);

    // Fetch candidates (more than we need, we'll trim by token budget)
    // Exclude superseded observations — they've been replaced by newer ones
    candidates = db.db
      .query<ObservationRow, (number | string)[]>(
        `SELECT * FROM observations
         WHERE project_id = ? AND lifecycle IN ('active', 'aging')
         AND quality >= 0.3
         AND superseded_by IS NULL
         ${visibilityClause}
         ORDER BY quality DESC, created_at_epoch DESC
         LIMIT ?`
      )
      .all(projectId, ...visibilityParams, candidateLimit);
  }

  // Cross-project candidates: always search when scope is "all",
  // or when project is new (ensures memory follows you everywhere)
  let crossProjectCandidates: (ObservationRow & { _source_project?: string })[] = [];
  if (opts.scope === "all" || isNewProject) {
    // For new projects, search more broadly (higher limit, lower quality threshold)
    const crossLimit = isNewProject
      ? Math.max(30, candidateLimit)
      : Math.max(10, Math.floor(candidateLimit / 3));
    const qualityThreshold = isNewProject ? 0.3 : 0.5;

    const rawCross = isNewProject
      ? db.db
          .query<ObservationRow, (number | string)[]>(
            `SELECT * FROM observations
             WHERE lifecycle IN ('active', 'aging', 'pinned')
             AND quality >= ?
             AND superseded_by IS NULL
             ${visibilityClause}
             ORDER BY quality DESC, created_at_epoch DESC
             LIMIT ?`
          )
          .all(qualityThreshold, ...visibilityParams, crossLimit)
      : db.db
          .query<ObservationRow, (number | string)[]>(
            `SELECT * FROM observations
             WHERE project_id != ? AND lifecycle IN ('active', 'aging')
             AND quality >= ?
             AND superseded_by IS NULL
             ${visibilityClause}
             ORDER BY quality DESC, created_at_epoch DESC
             LIMIT ?`
          )
          .all(projectId, qualityThreshold, ...visibilityParams, crossLimit);

    // Resolve project names for labeling
    const projectNameCache = new Map<number, string>();
    crossProjectCandidates = rawCross.map((obs) => {
      if (!projectNameCache.has(obs.project_id)) {
        const proj = db.getProjectById(obs.project_id);
        if (proj) projectNameCache.set(obs.project_id, proj.name);
      }
      return { ...obs, _source_project: projectNameCache.get(obs.project_id) };
    });
  }

  // Deduplicate: pinned and recent are always included, candidates fill the rest
  const seenIds = new Set(pinned.map((o) => o.id));

  // Deduplicate recent against pinned
  const dedupedRecent = recent.filter((o) => {
    if (seenIds.has(o.id)) return false;
    seenIds.add(o.id);
    return true;
  });

  const deduped = candidates.filter((o) => !seenIds.has(o.id));

  // Merge cross-project candidates (deduplicate against local)
  for (const obs of crossProjectCandidates) {
    if (!seenIds.has(obs.id)) {
      seenIds.add(obs.id);
      deduped.push(obs);
    }
  }

  // Re-sort candidates by blended score (quality * 0.6 + recency * 0.4)
  // Digests get a boost so they surface as "lessons from previous sessions"
  const nowEpoch = Math.floor(Date.now() / 1000);
  const sorted = [...deduped].sort((a, b) => {
    const boostA = a.type === "digest" ? 0.15 : 0;
    const boostB = b.type === "digest" ? 0.15 : 0;
    const scoreA = computeBlendedScore(a.quality, a.created_at_epoch, nowEpoch) + boostA;
    const scoreB = computeBlendedScore(b.quality, b.created_at_epoch, nowEpoch) + boostB;
    return scoreB - scoreA; // descending
  });

  const projectName = project?.name ?? detected.name;
  const canonicalId = project?.canonical_id ?? detected.canonical_id;

  // If using legacy maxCount mode, just slice
  if (maxCount !== undefined) {
    const remaining = Math.max(0, maxCount - pinned.length - dedupedRecent.length);
    const all = [...pinned, ...dedupedRecent, ...sorted.slice(0, remaining)];
    return {
      project_name: projectName,
      canonical_id: canonicalId,
      observations: all.map(toContextObservation),
      session_count: all.length,
      total_active: totalActive,
    };
  }

  // Token budget mode: fill greedily
  // Reserve ~30 tokens for header + footer
  let remainingBudget = tokenBudget - 30;
  const selected: ObservationRow[] = [];

  // Pinned always included (deducted from budget)
  for (const obs of pinned) {
    const cost = estimateObservationTokens(obs, selected.length);
    remainingBudget -= cost;
    selected.push(obs);
  }

  // Recent always included (deducted from budget) — ensures session continuity
  for (const obs of dedupedRecent) {
    const cost = estimateObservationTokens(obs, selected.length);
    remainingBudget -= cost;
    selected.push(obs);
  }

  // Fill with candidates (sorted by blended score) until budget exhausted
  for (const obs of sorted) {
    const cost = estimateObservationTokens(obs, selected.length);
    if (remainingBudget - cost < 0 && selected.length > 0) break;
    remainingBudget -= cost;
    selected.push(obs);
  }

  // Fetch recent session summaries for lessons learned
  const summaries = isNewProject ? [] : db.getRecentSummaries(projectId, 5);

  // Fetch recent security findings (last 7 days) for risk awareness
  let securityFindings: SecurityFindingRow[] = [];
  if (!isNewProject) {
    try {
      const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
      securityFindings = db.db
        .query<SecurityFindingRow, [number, number, number]>(
          `SELECT * FROM security_findings
           WHERE project_id = ? AND created_at_epoch > ?
           ORDER BY severity DESC, created_at_epoch DESC
           LIMIT ?`
        )
        .all(projectId, weekAgo, 10);
    } catch {
      // security_findings table may not exist on old schema
    }
  }

  // For new/unknown projects, build a workspace overview so the agent
  // knows what we've been working on (project names, activity, scale).
  // This prevents "what's Engrm?" when opening a new folder.
  let recentProjects: RecentProject[] | undefined;
  if (isNewProject) {
    try {
      const nowEpochSec = Math.floor(Date.now() / 1000);
      interface ProjectSummaryRow {
        name: string;
        canonical_id: string;
        last_active_epoch: number;
        obs_count: number;
      }
      const projectRows = db.db
        .query<ProjectSummaryRow, string[]>(
          `SELECT p.name, p.canonical_id, p.last_active_epoch,
                  (SELECT COUNT(*) FROM observations o
                   WHERE o.project_id = p.id
                   AND o.lifecycle IN ('active', 'aging', 'pinned')
                   ${opts.userId ? "AND (o.sensitivity != 'personal' OR o.user_id = ?)" : ""}
                   AND o.superseded_by IS NULL) as obs_count
           FROM projects p
           ORDER BY p.last_active_epoch DESC
           LIMIT 10`
        )
        .all(...visibilityParams);
      if (projectRows.length > 0) {
        recentProjects = projectRows.map((r) => {
          const daysAgo = Math.max(0, Math.floor((nowEpochSec - r.last_active_epoch) / 86400));
          const lastActive = new Date(r.last_active_epoch * 1000).toISOString().split("T")[0]!;
          return {
            name: r.name,
            canonical_id: r.canonical_id,
            observation_count: r.obs_count,
            last_active: lastActive,
            days_ago: daysAgo,
          };
        });
      }
    } catch {
      // project summary is best-effort
    }
  }

  // Decision follow-through: find commitments with no matching implementation.
  // "We know what we did. We don't know what we didn't."
  let staleDecisions: StaleDecision[] | undefined;
  try {
    const stale = isNewProject
      ? findStaleDecisionsGlobal(db)
      : findStaleDecisions(db, projectId);
    if (stale.length > 0) staleDecisions = stale;
  } catch {
    // Follow-through detection is best-effort
  }

  return {
    project_name: projectName,
    canonical_id: canonicalId,
    observations: selected.map(toContextObservation),
    session_count: selected.length,
    total_active: totalActive,
    summaries: summaries.length > 0 ? summaries : undefined,
    securityFindings: securityFindings.length > 0 ? securityFindings : undefined,
    recentProjects,
    staleDecisions,
  };
}

/**
 * Estimate token cost of an observation in context.
 * Detailed entries (index < 3) cost more than title-only entries.
 */
function estimateObservationTokens(
  obs: ObservationRow,
  index: number
): number {
  const DETAILED_THRESHOLD = 5;
  // Title line: "- **[type]** title (date, q=0.X)"
  const titleCost = estimateTokens(
    `- **[${obs.type}]** ${obs.title} (2026-01-01, q=0.5)`
  );

  if (index >= DETAILED_THRESHOLD) {
    return titleCost;
  }

  // Detailed: title + facts or narrative snippet
  const detailText = formatObservationDetail(obs);
  return titleCost + estimateTokens(detailText);
}

/**
 * Format injected context as a readable string for Claude.
 *
 * Tiered approach:
 *   - First 3 observations: title + facts (or narrative snippet)
 *   - Remaining: title-only
 *   - Footer: "N more observations available via search"
 */
export function formatContextForInjection(
  context: InjectedContext
): string {
  if (context.observations.length === 0) {
    return `Project: ${context.project_name} (no prior observations)`;
  }

  const DETAILED_COUNT = 5;
  const isCrossProject = context.recentProjects && context.recentProjects.length > 0;

  const lines: string[] = [];

  if (isCrossProject) {
    // New/unknown project: show workspace overview first
    lines.push(`## Engrm Memory — Workspace Overview`);
    lines.push(`This is a new project folder. Here is context from your recent work:`);
    lines.push("");
    lines.push("**Active projects in memory:**");
    for (const rp of context.recentProjects!) {
      const activity = rp.days_ago === 0 ? "today" : rp.days_ago === 1 ? "yesterday" : `${rp.days_ago}d ago`;
      lines.push(`- **${rp.name}** — ${rp.observation_count} observations, last active ${activity}`);
    }
    lines.push("");
    lines.push(`${context.session_count} relevant observation(s) from across projects:`);
    lines.push("");
  } else {
    lines.push(`## Project Memory: ${context.project_name}`);
    lines.push(`${context.session_count} relevant observation(s) from prior sessions:`);
    lines.push("");
  }

  for (let i = 0; i < context.observations.length; i++) {
    const obs = context.observations[i]!;
    const date = obs.created_at.split("T")[0];
    const fromLabel = obs.source_project ? ` [from: ${obs.source_project}]` : "";
    lines.push(
      `- **[${obs.type}]** ${obs.title} (${date}, q=${obs.quality.toFixed(1)})${fromLabel}`
    );

    // Detailed tier: show facts or narrative snippet
    if (i < DETAILED_COUNT) {
      const detail = formatObservationDetailFromContext(obs);
      if (detail) {
        lines.push(detail);
      }
    }
  }

  // Session summaries (project-state briefs from recent sessions)
  if (context.summaries && context.summaries.length > 0) {
    lines.push("");
    lines.push("## Recent Project Briefs");
    for (const summary of context.summaries.slice(0, 3)) {
      lines.push(...formatSessionBrief(summary));
      lines.push("");
    }
  }

  // Security findings (recent, unresolved)
  if (context.securityFindings && context.securityFindings.length > 0) {
    lines.push("");
    lines.push("Security findings (recent):");
    for (const finding of context.securityFindings) {
      const date = new Date(finding.created_at_epoch * 1000)
        .toISOString()
        .split("T")[0];
      const file = finding.file_path
        ? ` in ${finding.file_path}`
        : finding.tool_name
          ? ` via ${finding.tool_name}`
          : "";
      lines.push(
        `- [${finding.severity.toUpperCase()}] ${finding.pattern_name}${file} (${date})`
      );
    }
  }

  // Stale decisions (committed but not implemented)
  if (context.staleDecisions && context.staleDecisions.length > 0) {
    lines.push("");
    lines.push("Stale commitments (decided but no implementation observed):");
    for (const sd of context.staleDecisions) {
      const date = sd.created_at.split("T")[0];
      lines.push(`- [DECISION] ${sd.title} (${date}, ${sd.days_ago}d ago)`);
      if (sd.best_match_title) {
        lines.push(`  Closest match: "${sd.best_match_title}" (${Math.round((sd.best_match_similarity ?? 0) * 100)}% similar — not enough to count as done)`);
      }
    }
  }

  // Footer: how many more are available
  const remaining = context.total_active - context.session_count;
  if (remaining > 0) {
    lines.push("");
    lines.push(
      `${remaining} more observation(s) available via search tool.`
    );
  }

  return lines.join("\n");
}

function formatSessionBrief(summary: SessionSummaryRow): string[] {
  const lines: string[] = [];
  const heading = summary.request
    ? `### ${truncateText(summary.request, 120)}`
    : `### Session ${summary.session_id.slice(0, 8)}`;
  lines.push(heading);

  const sections: Array<[string, string | null, number]> = [
    ["Investigated", summary.investigated, 180],
    ["Learned", summary.learned, 180],
    ["Completed", summary.completed, 180],
    ["Next Steps", summary.next_steps, 140],
  ];

  for (const [label, value, maxLen] of sections) {
    const formatted = formatSummarySection(value, maxLen);
    if (formatted) {
      lines.push(`${label}:`);
      lines.push(formatted);
    }
  }

  return lines;
}

function formatSummarySection(value: string | null, maxLen: number): string | null {
  if (!value) return null;
  const cleaned = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith("-") ? line : `- ${line}`))
    .join("\n");
  if (!cleaned) return null;
  return truncateMultilineText(cleaned, maxLen);
}

function truncateMultilineText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen).trimEnd();
  const lastBreak = Math.max(truncated.lastIndexOf("\n"), truncated.lastIndexOf(" "));
  const safe = lastBreak > maxLen * 0.5 ? truncated.slice(0, lastBreak) : truncated;
  return `${safe.trimEnd()}…`;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Format detail for a top-tier observation.
 * Prefers facts (bullet points, denser) over narrative (prose, verbose).
 */
function formatObservationDetailFromContext(
  obs: ContextObservation
): string | null {
  // Try facts first (denser per token)
  if (obs.facts) {
    const bullets = parseFacts(obs.facts);
    if (bullets.length > 0) {
      return bullets
        .slice(0, 4) // Cap at 4 facts
        .map((f) => `  - ${f}`)
        .join("\n");
    }
  }

  // Fall back to narrative snippet
  if (obs.narrative) {
    const snippet =
      obs.narrative.length > 120
        ? obs.narrative.slice(0, 117) + "..."
        : obs.narrative;
    return `  ${snippet}`;
  }

  return null;
}

/**
 * Format detail for token estimation (from ObservationRow).
 */
function formatObservationDetail(obs: ObservationRow): string {
  if (obs.facts) {
    const bullets = parseFacts(obs.facts);
    if (bullets.length > 0) {
      return bullets
        .slice(0, 4)
        .map((f) => `  - ${f}`)
        .join("\n");
    }
  }
  if (obs.narrative) {
    const snippet =
      obs.narrative.length > 120
        ? obs.narrative.slice(0, 117) + "..."
        : obs.narrative;
    return `  ${snippet}`;
  }
  return "";
}

/**
 * Parse facts from stored JSON string.
 * Handles malformed JSON gracefully.
 */
export function parseFacts(facts: string): string[] {
  if (!facts) return [];
  try {
    const parsed = JSON.parse(facts);
    if (Array.isArray(parsed)) {
      return parsed.filter((f) => typeof f === "string" && f.length > 0);
    }
  } catch {
    // Not valid JSON — treat as a single fact
    if (facts.trim().length > 0) {
      return [facts.trim()];
    }
  }
  return [];
}

function toContextObservation(obs: ObservationRow & { _source_project?: string }): ContextObservation {
  return {
    id: obs.id,
    type: obs.type,
    title: obs.title,
    narrative: obs.narrative,
    facts: obs.facts,
    quality: obs.quality,
    created_at: obs.created_at,
    ...(obs._source_project ? { source_project: obs._source_project } : {}),
  };
}
