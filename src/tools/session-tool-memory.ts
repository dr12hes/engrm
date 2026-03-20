/**
 * session_tool_memory MCP tool.
 *
 * Shows which tool activity in a single session produced durable memory
 * and which tools ran without creating reusable observations.
 */

import type { MemDatabase, ObservationRow, ToolEventRow } from "../storage/sqlite.js";

export interface SessionToolMemoryInput {
  session_id: string;
}

export interface SessionToolMemoryResult {
  session_id: string;
  tools: Array<{
    tool: string;
    tool_event_count: number;
    observation_count: number;
    top_types: Array<{ type: string; count: number }>;
    sample_titles: string[];
    latest_prompt_number: number | null;
  }>;
  tools_without_memory: Array<{
    tool: string;
    tool_event_count: number;
  }>;
}

export function getSessionToolMemory(
  db: MemDatabase,
  input: SessionToolMemoryInput
): SessionToolMemoryResult {
  const toolEvents = db.getSessionToolEvents(input.session_id, 500);
  const observations = db.getObservationsBySession(input.session_id);

  const toolEventCounts = toolEvents.reduce((acc, event) => {
    acc.set(event.tool_name, (acc.get(event.tool_name) ?? 0) + 1);
    return acc;
  }, new Map<string, number>());

  const observationGroups = observations.reduce((acc, obs) => {
    if (!obs.source_tool) return acc;
    const group = acc.get(obs.source_tool) ?? [];
    group.push(obs);
    acc.set(obs.source_tool, group);
    return acc;
  }, new Map<string, ObservationRow[]>());

  const tools = Array.from(observationGroups.entries())
    .map(([tool, groupedObservations]) => {
      const topTypes = Array.from(
        groupedObservations.reduce((acc, obs) => {
          acc.set(obs.type, (acc.get(obs.type) ?? 0) + 1);
          return acc;
        }, new Map<string, number>()).entries()
      )
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
        .slice(0, 5);

      const sampleTitles = groupedObservations
        .map((obs) => obs.title)
        .filter((title, index, all) => all.indexOf(title) === index)
        .slice(0, 4);

      const latestPromptNumber = groupedObservations.reduce<number | null>(
        (latest, obs) =>
          typeof obs.source_prompt_number === "number"
            ? latest === null || obs.source_prompt_number > latest
              ? obs.source_prompt_number
              : latest
            : latest,
        null
      );

      return {
        tool,
        tool_event_count: toolEventCounts.get(tool) ?? 0,
        observation_count: groupedObservations.length,
        top_types: topTypes,
        sample_titles: sampleTitles,
        latest_prompt_number: latestPromptNumber,
      };
    })
    .sort((a, b) => b.observation_count - a.observation_count || a.tool.localeCompare(b.tool));

  const toolsWithoutMemory = Array.from(toolEventCounts.entries())
    .filter(([tool]) => !observationGroups.has(tool))
    .map(([tool, toolEventCount]) => ({
      tool,
      tool_event_count: toolEventCount,
    }))
    .sort((a, b) => b.tool_event_count - a.tool_event_count || a.tool.localeCompare(b.tool));

  return {
    session_id: input.session_id,
    tools,
    tools_without_memory: toolsWithoutMemory,
  };
}
