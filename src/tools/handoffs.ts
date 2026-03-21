import type { Config } from "../config.js";
import { detectProject } from "../storage/projects.js";
import type {
  MemDatabase,
  ObservationRow,
  RecentSessionRow,
  SessionSummaryRow,
} from "../storage/sqlite.js";
import { getSessionStory } from "./session-story.js";
import { saveObservation } from "./save.js";

export interface CreateHandoffInput {
  session_id?: string;
  cwd?: string;
  title?: string;
  include_chat?: boolean;
  chat_limit?: number;
}

export interface CreateHandoffResult {
  success: boolean;
  observation_id?: number;
  session_id?: string;
  title?: string;
  reason?: string;
}

export interface RecentHandoffsInput {
  limit?: number;
  project_scoped?: boolean;
  cwd?: string;
  user_id?: string;
}

export interface HandoffRow extends ObservationRow {
  project_name?: string | null;
}

export interface RecentHandoffsResult {
  handoffs: HandoffRow[];
  project?: string;
}

export interface LoadHandoffInput {
  id?: number;
  cwd?: string;
  project_scoped?: boolean;
  user_id?: string;
}

export interface LoadHandoffResult {
  handoff: HandoffRow | null;
  project?: string;
}

export async function createHandoff(
  db: MemDatabase,
  config: Config,
  input: CreateHandoffInput
): Promise<CreateHandoffResult> {
  const resolved = resolveTargetSession(db, input.cwd, config.user_id, input.session_id);
  if (!resolved.session) {
    return {
      success: false,
      reason: "No recent session found to hand off yet",
    };
  }

  const story = getSessionStory(db, { session_id: resolved.session.session_id });
  if (!story.session) {
    return {
      success: false,
      reason: `Session ${resolved.session.session_id} not found`,
    };
  }

  const includeChat = input.include_chat === true;
  const chatLimit = Math.max(1, Math.min(input.chat_limit ?? 4, 8));
  const generatedTitle = buildHandoffTitle(story.summary, story.latest_request, input.title);
  const title = `Handoff: ${generatedTitle} · ${formatTimestamp(Date.now())}`;
  const narrative = buildHandoffNarrative(story.summary, story, {
    includeChat,
    chatLimit,
  });
  const facts = buildHandoffFacts(story.summary, story);
  const concepts = buildHandoffConcepts(story.project_name, story.capture_state);

  const result = await saveObservation(db, config, {
    type: "message",
    title,
    narrative,
    facts,
    concepts,
    session_id: story.session.session_id,
    cwd: input.cwd,
    agent: "engrm-handoff",
    source_tool: "create_handoff",
  });

  return {
    success: result.success,
    observation_id: result.observation_id,
    session_id: story.session.session_id,
    title,
    reason: result.reason,
  };
}

export function getRecentHandoffs(
  db: MemDatabase,
  input: RecentHandoffsInput
): RecentHandoffsResult {
  const limit = Math.max(1, Math.min(input.limit ?? 10, 25));
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

  const conditions = [
    "o.type = 'message'",
    "o.lifecycle IN ('active', 'aging', 'pinned')",
    "o.superseded_by IS NULL",
    "(o.title LIKE 'Handoff:%' OR o.concepts LIKE '%\"handoff\"%')",
  ];
  const params: Array<number | string> = [];

  if (input.user_id) {
    conditions.push("(o.sensitivity != 'personal' OR o.user_id = ?)");
    params.push(input.user_id);
  }

  if (projectId !== null) {
    conditions.push("o.project_id = ?");
    params.push(projectId);
  }

  params.push(limit);

  const handoffs = db.db
    .query<HandoffRow, Array<number | string>>(
      `SELECT o.*, p.name AS project_name
       FROM observations o
       LEFT JOIN projects p ON p.id = o.project_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY o.created_at_epoch DESC, o.id DESC
       LIMIT ?`
    )
    .all(...params);

  return {
    handoffs,
    project: projectName,
  };
}

export function loadHandoff(
  db: MemDatabase,
  input: LoadHandoffInput
): LoadHandoffResult {
  if (typeof input.id === "number") {
    const obs = db.getObservationById(input.id);
    if (!obs || obs.type !== "message" || !looksLikeHandoff(obs)) {
      return { handoff: null };
    }
    const projectName = obs.project_id ? db.getProjectById(obs.project_id)?.name ?? null : null;
    return { handoff: { ...obs, project_name: projectName } };
  }

  const recent = getRecentHandoffs(db, {
    limit: 1,
    project_scoped: input.project_scoped,
    cwd: input.cwd,
    user_id: input.user_id,
  });

  return {
    handoff: recent.handoffs[0] ?? null,
    project: recent.project,
  };
}

function resolveTargetSession(
  db: MemDatabase,
  cwd: string | undefined,
  userId: string,
  sessionId?: string
): { session: RecentSessionRow | null; projectName?: string } {
  if (sessionId) {
    const session = db.getSessionById(sessionId);
    if (!session) return { session: null };
    const projectName = session.project_id ? db.getProjectById(session.project_id)?.name : undefined;
    return {
      session: {
        ...session,
        project_name: projectName ?? null,
        request: db.getSessionSummary(sessionId)?.request ?? null,
        completed: db.getSessionSummary(sessionId)?.completed ?? null,
        current_thread: db.getSessionSummary(sessionId)?.current_thread ?? null,
        capture_state: db.getSessionSummary(sessionId)?.capture_state ?? null,
        recent_tool_names: db.getSessionSummary(sessionId)?.recent_tool_names ?? null,
        hot_files: db.getSessionSummary(sessionId)?.hot_files ?? null,
        recent_outcomes: db.getSessionSummary(sessionId)?.recent_outcomes ?? null,
        prompt_count: db.getSessionUserPrompts(sessionId, 200).length,
        tool_event_count: db.getSessionToolEvents(sessionId, 200).length,
      },
      projectName: projectName ?? undefined,
    };
  }

  const detected = detectProject(cwd ?? process.cwd());
  const project = db.getProjectByCanonicalId(detected.canonical_id);
  const sessions = db.getRecentSessions(project?.id ?? null, 10, userId);
  return {
    session: sessions[0] ?? null,
    projectName: project?.name,
  };
}

function buildHandoffTitle(
  summary: SessionSummaryRow | null,
  latestRequest: string | null,
  explicit?: string
): string {
  const chosen = explicit?.trim()
    || summary?.current_thread?.trim()
    || summary?.completed?.trim()
    || latestRequest?.trim()
    || "Current work";
  return compactLine(chosen) ?? "Current work";
}

function buildHandoffNarrative(
  summary: SessionSummaryRow | null,
  story: ReturnType<typeof getSessionStory>,
  options: { includeChat: boolean; chatLimit: number }
): string {
  const sections: string[] = [];

  if (summary?.request || story.latest_request) {
    sections.push(`Request: ${summary?.request ?? story.latest_request}`);
  }
  if (summary?.current_thread) {
    sections.push(`Current thread: ${summary.current_thread}`);
  }
  if (summary?.investigated) {
    sections.push(`Investigated: ${summary.investigated}`);
  }
  if (summary?.learned) {
    sections.push(`Learned: ${summary.learned}`);
  }
  if (summary?.completed) {
    sections.push(`Completed: ${summary.completed}`);
  }
  if (summary?.next_steps) {
    sections.push(`Next Steps: ${summary.next_steps}`);
  }

  if (story.recent_outcomes.length > 0) {
    sections.push(`Recent outcomes:\n${story.recent_outcomes.slice(0, 5).map((item) => `- ${item}`).join("\n")}`);
  }
  if (story.hot_files.length > 0) {
    sections.push(`Hot files:\n${story.hot_files.slice(0, 5).map((file) => `- ${file.path}`).join("\n")}`);
  }
  if (story.provenance_summary.length > 0) {
    sections.push(`Tool trail:\n${story.provenance_summary.slice(0, 5).map((item) => `- ${item.tool}: ${item.count}`).join("\n")}`);
  }
  if (options.includeChat && story.chat_messages.length > 0) {
    const chatLines = story.chat_messages
      .slice(-options.chatLimit)
      .map((msg) => `- [${msg.role}] ${compactLine(msg.content) ?? msg.content.slice(0, 120)}`);
    sections.push(`Chat snippets:\n${chatLines.join("\n")}`);
  }

  return sections.filter(Boolean).join("\n\n");
}

function buildHandoffFacts(
  summary: SessionSummaryRow | null,
  story: ReturnType<typeof getSessionStory>
): string[] {
  const facts = [
    `session_id=${story.session?.session_id ?? "unknown"}`,
    `capture_state=${story.capture_state}`,
    story.project_name ? `project=${story.project_name}` : null,
    summary?.current_thread ? `current_thread=${summary.current_thread}` : null,
    story.hot_files[0] ? `hot_file=${story.hot_files[0].path}` : null,
    story.provenance_summary[0] ? `primary_tool=${story.provenance_summary[0].tool}` : null,
  ];
  return facts.filter((item): item is string => Boolean(item));
}

function buildHandoffConcepts(projectName: string | null, captureState: string): string[] {
  return [
    "handoff",
    "session-handoff",
    `capture:${captureState}`,
    ...(projectName ? [projectName] : []),
  ];
}

export function looksLikeHandoff(obs: ObservationRow): boolean {
  if (obs.title.startsWith("Handoff:")) return true;
  const concepts = parseJsonArray(obs.concepts);
  return concepts.includes("handoff") || concepts.includes("session-handoff");
}

function parseJsonArray(value: string | null | undefined): string[] {
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

function formatTimestamp(nowMs: number): string {
  const d = new Date(nowMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}Z`;
}

function compactLine(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}
