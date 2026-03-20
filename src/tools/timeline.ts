/**
 * get_timeline MCP tool.
 *
 * Returns chronological observations around an anchor point,
 * providing temporal context for understanding sequences of events.
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase, ObservationRow, ToolEventRow, UserPromptRow } from "../storage/sqlite.js";

export interface TimelineInput {
  anchor_id: number;
  depth_before?: number;
  depth_after?: number;
  project_scoped?: boolean;
  cwd?: string;
  user_id?: string;
}

export interface TimelineResult {
  observations: ObservationRow[];
  anchor_index: number;
  project?: string;
  session_prompts?: UserPromptRow[];
  session_tool_events?: ToolEventRow[];
}

/**
 * Get a timeline of observations around an anchor.
 */
export function getTimeline(
  db: MemDatabase,
  input: TimelineInput
): TimelineResult {
  const depthBefore = input.depth_before ?? 3;
  const depthAfter = input.depth_after ?? 3;
  const projectScoped = input.project_scoped !== false;

  let projectId: number | null = null;
  let projectName: string | undefined;

  if (projectScoped) {
    const cwd = input.cwd ?? process.cwd();
    const detected = detectProject(cwd);
    const project = db.getProjectByCanonicalId(detected.canonical_id);
    if (project) {
      projectId = project.id;
      projectName = project.name;
    }
  }

  const observations = db.getTimeline(
    input.anchor_id,
    projectId,
    depthBefore,
    depthAfter,
    input.user_id
  );

  // Find the anchor's position in the result
  const anchorIndex = observations.findIndex((o) => o.id === input.anchor_id);
  const sessionPrompts = observations[anchorIndex >= 0 ? anchorIndex : 0]?.session_id
    ? db.getSessionUserPrompts(observations[anchorIndex >= 0 ? anchorIndex : 0]!.session_id!, 10)
    : [];
  const sessionToolEvents = observations[anchorIndex >= 0 ? anchorIndex : 0]?.session_id
    ? db.getSessionToolEvents(observations[anchorIndex >= 0 ? anchorIndex : 0]!.session_id!, 12)
    : [];

  return {
    observations,
    anchor_index: anchorIndex >= 0 ? anchorIndex : 0,
    project: projectName,
    session_prompts: sessionPrompts.length > 0 ? sessionPrompts : undefined,
    session_tool_events: sessionToolEvents.length > 0 ? sessionToolEvents : undefined,
  };
}
