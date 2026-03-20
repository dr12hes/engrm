/**
 * memory_console MCP tool.
 *
 * High-signal local overview for testing what Engrm currently knows about
 * a project: sessions, requests, tools, observations, and summary cues.
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase } from "../storage/sqlite.js";
import { getRecentActivity } from "./recent.js";
import { getRecentRequests } from "./recent-prompts.js";
import { getRecentTools } from "./recent-tools.js";
import { getRecentSessions } from "./recent-sessions.js";
import { getProjectMemoryIndex } from "./project-memory-index.js";

export interface MemoryConsoleInput {
  cwd?: string;
  project_scoped?: boolean;
  user_id?: string;
}

export interface MemoryConsoleResult {
  project?: string;
  capture_mode: "rich" | "observations-only";
  sessions: ReturnType<typeof getRecentSessions>["sessions"];
  requests: ReturnType<typeof getRecentRequests>["prompts"];
  tools: ReturnType<typeof getRecentTools>["tool_events"];
  observations: ReturnType<typeof getRecentActivity>["observations"];
  recent_outcomes: string[];
  hot_files: Array<{ path: string; count: number }>;
}

export function getMemoryConsole(
  db: MemDatabase,
  input: MemoryConsoleInput
): MemoryConsoleResult {
  const cwd = input.cwd ?? process.cwd();
  const projectScoped = input.project_scoped !== false;
  const detected = projectScoped ? detectProject(cwd) : null;
  const project = detected ? db.getProjectByCanonicalId(detected.canonical_id) : null;

  const sessions = getRecentSessions(db, {
      cwd,
      project_scoped: projectScoped,
      user_id: input.user_id,
      limit: 6,
    }).sessions;
  const requests = getRecentRequests(db, {
      cwd,
      project_scoped: projectScoped,
      user_id: input.user_id,
      limit: 6,
    }).prompts;
  const tools = getRecentTools(db, {
      cwd,
      project_scoped: projectScoped,
      user_id: input.user_id,
      limit: 8,
    }).tool_events;
  const observations = getRecentActivity(db, {
      cwd,
      project_scoped: projectScoped,
      user_id: input.user_id,
      limit: 8,
    }).observations;
  const projectIndex = projectScoped
    ? getProjectMemoryIndex(db, {
        cwd,
        user_id: input.user_id,
      })
    : null;

  return {
    project: project?.name,
    capture_mode: requests.length > 0 || tools.length > 0 ? "rich" : "observations-only",
    sessions,
    requests,
    tools,
    observations,
    recent_outcomes: projectIndex?.recent_outcomes ?? [],
    hot_files: projectIndex?.hot_files ?? [],
  };
}
