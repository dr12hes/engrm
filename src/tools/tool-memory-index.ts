/**
 * tool_memory_index MCP tool.
 *
 * Gives a source-tool centric view of captured memory so we can judge
 * which tools are actually creating durable value.
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase } from "../storage/sqlite.js";

export interface ToolMemoryIndexInput {
  cwd?: string;
  project_scoped?: boolean;
  limit?: number;
  user_id?: string;
}

export interface ToolMemoryIndexResult {
  project?: string;
  tools: Array<{
    tool: string;
    observation_count: number;
    latest_epoch: number;
    top_types: Array<{ type: string; count: number }>;
    top_plugins: Array<{ plugin: string; count: number }>;
    sample_titles: string[];
    session_count: number;
    latest_prompt_number: number | null;
  }>;
}

function parseConcepts(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

export function getToolMemoryIndex(
  db: MemDatabase,
  input: ToolMemoryIndexInput = {}
): ToolMemoryIndexResult {
  const limit = Math.max(1, Math.min(input.limit ?? 10, 25));
  const projectScoped = input.project_scoped !== false;
  const cwd = input.cwd ?? process.cwd();
  const detected = projectScoped ? detectProject(cwd) : null;
  const project = detected ? db.getProjectByCanonicalId(detected.canonical_id) : null;

  const projectClause = project ? " AND o.project_id = ?" : "";
  const visibilityClause = input.user_id
    ? " AND (o.sensitivity != 'personal' OR o.user_id = ?)"
    : "";

  const baseParams: Array<number | string> = [];
  if (project) baseParams.push(project.id);
  if (input.user_id) baseParams.push(input.user_id);

  const toolRows = db.db
    .query<{
      source_tool: string;
      observation_count: number;
      latest_epoch: number;
      session_count: number;
      latest_prompt_number: number | null;
    }, (number | string)[]>(
      `SELECT
         o.source_tool,
         COUNT(*) as observation_count,
         MAX(o.created_at_epoch) as latest_epoch,
         COUNT(DISTINCT o.session_id) as session_count,
         MAX(o.source_prompt_number) as latest_prompt_number
       FROM observations o
       WHERE o.source_tool IS NOT NULL
         AND o.lifecycle IN ('active', 'aging', 'pinned')
         AND o.superseded_by IS NULL
         ${projectClause}
         ${visibilityClause}
       GROUP BY o.source_tool
       ORDER BY observation_count DESC, latest_epoch DESC, o.source_tool ASC
       LIMIT ?`
    )
    .all(...baseParams, limit);

  const tools = toolRows.map((row) => {
    const rowParams: Array<number | string> = [row.source_tool];
    if (project) rowParams.push(project.id);
    if (input.user_id) rowParams.push(input.user_id);

    const topTypes = db.db
      .query<{ type: string; count: number }, (number | string)[]>(
        `SELECT
           o.type,
           COUNT(*) as count
         FROM observations o
         WHERE o.source_tool = ?
           AND o.lifecycle IN ('active', 'aging', 'pinned')
           AND o.superseded_by IS NULL
           ${projectClause}
           ${visibilityClause}
         GROUP BY o.type
         ORDER BY count DESC, o.type ASC
         LIMIT 5`
      )
      .all(...rowParams)
      .map((typeRow) => ({
        type: typeRow.type,
        count: typeRow.count,
      }));

    const observationRows = db.db
      .query<{ title: string; concepts: string | null }, (number | string)[]>(
        `SELECT o.title, o.concepts
         FROM observations o
         WHERE o.source_tool = ?
           AND o.lifecycle IN ('active', 'aging', 'pinned')
           AND o.superseded_by IS NULL
           ${projectClause}
           ${visibilityClause}
         ORDER BY o.created_at_epoch DESC, o.id DESC
         LIMIT 50`
      )
      .all(...rowParams);

    const topPlugins = Array.from(
      observationRows.reduce((acc, obs) => {
        for (const concept of parseConcepts(obs.concepts)) {
          if (!concept.startsWith("plugin:")) continue;
          const plugin = concept.slice("plugin:".length);
          if (!plugin) continue;
          acc.set(plugin, (acc.get(plugin) ?? 0) + 1);
        }
        return acc;
      }, new Map<string, number>()).entries()
    )
      .map(([plugin, count]) => ({ plugin, count }))
      .sort((a, b) => b.count - a.count || a.plugin.localeCompare(b.plugin))
      .slice(0, 4);

    const sampleTitles = observationRows.map((sample) => sample.title).slice(0, 4);

    return {
      tool: row.source_tool,
      observation_count: row.observation_count,
      latest_epoch: row.latest_epoch,
      top_types: topTypes,
      top_plugins: topPlugins,
      sample_titles: sampleTitles,
      session_count: row.session_count,
      latest_prompt_number: row.latest_prompt_number,
    };
  });

  return {
    project: project?.name,
    tools,
  };
}
