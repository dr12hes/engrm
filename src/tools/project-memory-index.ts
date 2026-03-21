/**
 * project_memory_index MCP tool.
 *
 * Gives a structured local overview of a project's captured memory:
 * observation types, recent sessions, prompt/tool volume, and hot files.
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase, ObservationRow, RecentSessionRow } from "../storage/sqlite.js";
import { getRecentSessions } from "./recent-sessions.js";
import { getRecentRequests } from "./recent-prompts.js";
import { getRecentTools } from "./recent-tools.js";
import { estimateTokens } from "../context/inject.js";

export interface CaptureSummary {
  rich_sessions: number;
  partial_sessions: number;
  summary_only_sessions: number;
  legacy_sessions: number;
}

export interface ProjectMemoryIndexInput {
  cwd?: string;
  user_id?: string;
}

export interface ProjectMemoryIndexResult {
  project: string;
  canonical_id: string;
  observation_counts: Record<string, number>;
  recent_sessions: RecentSessionRow[];
  recent_outcomes: string[];
  recent_requests_count: number;
  recent_tools_count: number;
  raw_capture_active: boolean;
  capture_summary: CaptureSummary;
  hot_files: Array<{ path: string; count: number }>;
  provenance_summary: Array<{ tool: string; count: number }>;
  assistant_checkpoint_count: number;
  assistant_checkpoint_types: Array<{ type: string; count: number }>;
  top_titles: Array<{ type: string; title: string; id: number }>;
  top_types: Array<{ type: string; count: number }>;
  estimated_read_tokens: number;
  suggested_tools: string[];
}

export function getProjectMemoryIndex(
  db: MemDatabase,
  input: ProjectMemoryIndexInput
): ProjectMemoryIndexResult | null {
  const cwd = input.cwd ?? process.cwd();
  const detected = detectProject(cwd);
  const project = db.getProjectByCanonicalId(detected.canonical_id);
  if (!project) return null;

  const visibilityClause = input.user_id
    ? " AND (sensitivity != 'personal' OR user_id = ?)"
    : "";
  const visibilityParams = input.user_id ? [input.user_id] : [];

  const observations = db.db
    .query<ObservationRow, (number | string)[]>(
      `SELECT * FROM observations
       WHERE project_id = ?
         AND lifecycle IN ('active', 'aging', 'pinned')
         AND superseded_by IS NULL
         ${visibilityClause}
       ORDER BY created_at_epoch DESC`
    )
    .all(project.id, ...visibilityParams);

  const counts: Record<string, number> = {};
  for (const obs of observations) {
    counts[obs.type] = (counts[obs.type] ?? 0) + 1;
  }

  const fileCounts = new Map<string, number>();
  for (const obs of observations) {
    for (const path of extractPaths(obs.files_modified)) {
      fileCounts.set(path, (fileCounts.get(path) ?? 0) + 1);
    }
  }

  const hotFiles = Array.from(fileCounts.entries())
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, 8);
  const provenanceSummary = Array.from(
    observations.reduce((acc, obs) => {
      if (!obs.source_tool) return acc;
      acc.set(obs.source_tool, (acc.get(obs.source_tool) ?? 0) + 1);
      return acc;
    }, new Map<string, number>()).entries()
  )
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    .slice(0, 6);
  const assistantCheckpointCount = observations.filter((obs) => obs.source_tool === "assistant-stop").length;
  const assistantCheckpointTypes = Array.from(
    observations
      .filter((obs) => obs.source_tool === "assistant-stop")
      .reduce((acc, obs) => {
        acc.set(obs.type, (acc.get(obs.type) ?? 0) + 1);
        return acc;
      }, new Map<string, number>())
      .entries()
  )
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
    .slice(0, 5);

  const topTitles = observations
    .slice(0, 12)
    .map((obs) => ({
      type: obs.type,
      title: obs.title,
      id: obs.id,
    }));

  const recentSessions = getRecentSessions(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 6,
  }).sessions;
  const recentRequestsCount = getRecentRequests(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 20,
  }).prompts.length;
  const recentToolsCount = getRecentTools(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 20,
  }).tool_events.length;
  const recentOutcomes = observations
    .filter((obs) => ["bugfix", "feature", "refactor", "change", "decision"].includes(obs.type))
    .map((obs) => obs.title.trim())
    .filter((title) => title.length > 0 && !looksLikeFileOperationTitle(title))
    .slice(0, 8);
  const captureSummary = summarizeCaptureState(recentSessions);
  const topTypes = Object.entries(counts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
    .slice(0, 5);
  const suggestedTools = buildSuggestedTools(recentSessions, recentRequestsCount, recentToolsCount, observations.length);
  const estimatedReadTokens = estimateTokens(
    [
      recentOutcomes.join("\n"),
      topTitles.map((item) => `${item.type}: ${item.title}`).join("\n"),
      hotFiles.map((item) => `${item.path} (${item.count})`).join("\n"),
    ].filter(Boolean).join("\n")
  );

  return {
    project: project.name,
    canonical_id: project.canonical_id,
    observation_counts: counts,
    recent_sessions: recentSessions,
    recent_outcomes: recentOutcomes,
    recent_requests_count: recentRequestsCount,
    recent_tools_count: recentToolsCount,
    raw_capture_active: recentRequestsCount > 0 || recentToolsCount > 0,
    capture_summary: captureSummary,
    hot_files: hotFiles,
    provenance_summary: provenanceSummary,
    assistant_checkpoint_count: assistantCheckpointCount,
    assistant_checkpoint_types: assistantCheckpointTypes,
    top_titles: topTitles,
    top_types: topTypes,
    estimated_read_tokens: estimatedReadTokens,
    suggested_tools: suggestedTools,
  };
}

function extractPaths(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function looksLikeFileOperationTitle(value: string): boolean {
  return /^(modified|updated|edited|touched|changed|extended|refactored|redesigned)\s+[A-Za-z0-9_.\-\/]+(?:\s*\([^)]*\))?$/i.test(
    value.trim()
  );
}

function summarizeCaptureState(sessions: Array<RecentSessionRow & { capture_state?: string }>): CaptureSummary {
  const summary: CaptureSummary = {
    rich_sessions: 0,
    partial_sessions: 0,
    summary_only_sessions: 0,
    legacy_sessions: 0,
  };
  for (const session of sessions) {
    switch (session.capture_state) {
      case "rich":
        summary.rich_sessions += 1;
        break;
      case "partial":
        summary.partial_sessions += 1;
        break;
      case "summary-only":
        summary.summary_only_sessions += 1;
        break;
      default:
        summary.legacy_sessions += 1;
        break;
    }
  }
  return summary;
}

function buildSuggestedTools(
  sessions: RecentSessionRow[],
  requestCount: number,
  toolCount: number,
  observationCount: number
): string[] {
  const suggested: string[] = [];
  if (sessions.length > 0) {
    suggested.push("recent_sessions");
  }
  if (requestCount > 0 || toolCount > 0) {
    suggested.push("activity_feed");
  }
  if (observationCount > 0) {
    suggested.push("tool_memory_index", "capture_git_worktree");
  }
  if (sessions.length > 0) {
    suggested.push("create_handoff", "recent_handoffs");
  }
  return Array.from(new Set(suggested)).slice(0, 4);
}
