import { detectProject } from "../storage/projects.js";
import type { MemDatabase, RecentSessionRow } from "../storage/sqlite.js";
import type { ChatCoverageState } from "./recent-chat.js";
import { listRecallItems, type RecallIndexItem } from "./list-recall-items.js";

export interface AgentMemoryIndexInput {
  cwd?: string;
  project_scoped?: boolean;
  user_id?: string;
}

export interface AgentMemorySummary {
  agent: string;
  session_count: number;
  summary_session_count: number;
  prompt_count: number;
  tool_event_count: number;
  observation_count: number;
  handoff_count: number;
  chat_message_count: number;
  chat_coverage_state: ChatCoverageState;
  continuity_state: "fresh" | "thin" | "cold";
  capture_state: "rich" | "partial" | "summary-only" | "legacy";
  last_seen_epoch: number | null;
  latest_session_id: string | null;
  latest_summary: string | null;
  devices: string[];
  best_recall_key: string | null;
  best_recall_title: string | null;
  best_recall_kind: RecallIndexItem["kind"] | null;
  resume_freshness: RecallIndexItem["freshness"] | "stale";
}

export interface AgentMemoryIndexResult {
  project?: string;
  agents: AgentMemorySummary[];
  suggested_tools: string[];
}

export function getAgentMemoryIndex(
  db: MemDatabase,
  input: AgentMemoryIndexInput
): AgentMemoryIndexResult {
  const cwd = input.cwd ?? process.cwd();
  const projectScoped = input.project_scoped !== false;
  let projectId: number | null = null;
  let projectName: string | undefined;

  if (projectScoped) {
    const detected = detectProject(cwd);
    const project = db.getProjectByCanonicalId(detected.canonical_id);
    if (project) {
      projectId = project.id;
      projectName = project.name;
    }
  }

  const userFilter = input.user_id ? " AND s.user_id = ?" : "";
  const userArgs = input.user_id ? [input.user_id] : [];
  const projectFilter = projectId !== null ? " AND s.project_id = ?" : "";
  const projectArgs = projectId !== null ? [projectId] : [];

  const sessionRows = db.db
    .query<{
      agent: string;
      session_count: number;
      summary_session_count: number;
      prompt_count: number;
      tool_event_count: number;
      last_seen_epoch: number | null;
    }, (string | number)[]>(
      `SELECT
         s.agent as agent,
         COUNT(*) as session_count,
         SUM(CASE WHEN ss.request IS NOT NULL OR ss.completed IS NOT NULL THEN 1 ELSE 0 END) as summary_session_count,
         SUM(COALESCE(pc.prompt_count, 0)) as prompt_count,
         SUM(COALESCE(tc.tool_event_count, 0)) as tool_event_count,
         MAX(COALESCE(s.completed_at_epoch, s.started_at_epoch)) as last_seen_epoch
       FROM sessions s
       LEFT JOIN session_summaries ss ON ss.session_id = s.session_id
       LEFT JOIN (
         SELECT session_id, COUNT(*) as prompt_count
         FROM user_prompts
         GROUP BY session_id
       ) pc ON pc.session_id = s.session_id
       LEFT JOIN (
         SELECT session_id, COUNT(*) as tool_event_count
         FROM tool_events
         GROUP BY session_id
       ) tc ON tc.session_id = s.session_id
       WHERE 1 = 1${projectFilter}${userFilter}
       GROUP BY s.agent
       ORDER BY last_seen_epoch DESC, s.agent ASC`
    )
    .all(...projectArgs, ...userArgs)
    .filter((row) => !isInternalAgent(row.agent));

  const observationCounts = new Map<string, { observation_count: number; handoff_count: number }>();
  const observationRows = db.db
    .query<{ agent: string; observation_count: number; handoff_count: number }, (string | number)[]>(
      `SELECT
         COALESCE(s.agent, o.agent) as agent,
         COUNT(*) as observation_count,
         SUM(CASE WHEN o.type = 'message' AND o.concepts LIKE '%session-handoff%' THEN 1 ELSE 0 END) as handoff_count
       FROM observations o
       LEFT JOIN sessions s ON s.session_id = o.session_id
       WHERE o.lifecycle IN ('active', 'aging', 'pinned')
         AND o.superseded_by IS NULL
         ${projectId !== null ? "AND o.project_id = ?" : ""}
         ${input.user_id ? "AND (o.sensitivity != 'personal' OR o.user_id = ?)" : ""}
       GROUP BY COALESCE(s.agent, o.agent)`
    )
    .all(...(projectId !== null ? [projectId] : []), ...(input.user_id ? [input.user_id] : []))
    .filter((row) => !isInternalAgent(row.agent));
  for (const row of observationRows) {
    observationCounts.set(row.agent, {
      observation_count: row.observation_count,
      handoff_count: row.handoff_count,
    });
  }

  const chatCoverage = new Map<string, {
    chat_message_count: number;
    transcript_count: number;
    history_count: number;
    hook_count: number;
  }>();
  const chatRows = db.db
    .query<{ agent: string; origin_kind: "transcript" | "history" | "hook"; count: number }, (string | number)[]>(
      `SELECT
         COALESCE(s.agent, cm.agent) as agent,
         CASE
           WHEN cm.source_kind = 'transcript' THEN 'transcript'
           WHEN cm.remote_source_id LIKE 'history:%' THEN 'history'
           ELSE 'hook'
         END as origin_kind,
         COUNT(*) as count
       FROM chat_messages cm
       LEFT JOIN sessions s ON s.session_id = cm.session_id
       WHERE 1 = 1
         ${projectId !== null ? "AND cm.project_id = ?" : ""}
         ${input.user_id ? "AND cm.user_id = ?" : ""}
       GROUP BY COALESCE(s.agent, cm.agent), origin_kind`
    )
    .all(...(projectId !== null ? [projectId] : []), ...(input.user_id ? [input.user_id] : []))
    .filter((row) => !isInternalAgent(row.agent));
  for (const row of chatRows) {
    const current = chatCoverage.get(row.agent) ?? {
      chat_message_count: 0,
      transcript_count: 0,
      history_count: 0,
      hook_count: 0,
    };
    current.chat_message_count += row.count;
    if (row.origin_kind === "transcript") current.transcript_count += row.count;
    else if (row.origin_kind === "history") current.history_count += row.count;
    else current.hook_count += row.count;
    chatCoverage.set(row.agent, current);
  }

  const recentSessions = db.getRecentSessions(projectId, 200, input.user_id)
    .filter((session) => !isInternalAgent(session.agent));
  const recallItems = listRecallItems(db, {
    cwd,
    project_scoped: projectScoped,
    user_id: input.user_id,
    limit: 30,
  }).items;
  const latestByAgent = new Map<string, RecentSessionRow>();
  const devicesByAgent = new Map<string, Set<string>>();
  for (const session of recentSessions) {
    if (!latestByAgent.has(session.agent)) latestByAgent.set(session.agent, session);
    const devices = devicesByAgent.get(session.agent) ?? new Set<string>();
    if (session.device_id) devices.add(session.device_id);
    devicesByAgent.set(session.agent, devices);
  }

  const knownAgents = new Set<string>([
    ...sessionRows.map((row) => row.agent),
    ...Array.from(observationCounts.keys()),
    ...Array.from(chatCoverage.keys()),
  ]);

  const agents = Array.from(knownAgents)
    .map<AgentMemorySummary>((agent) => {
      const session = sessionRows.find((row) => row.agent === agent) ?? {
        agent,
        session_count: 0,
        summary_session_count: 0,
        prompt_count: 0,
        tool_event_count: 0,
        last_seen_epoch: null,
      };
      const obs = observationCounts.get(agent) ?? { observation_count: 0, handoff_count: 0 };
      const chat = chatCoverage.get(agent) ?? {
        chat_message_count: 0,
        transcript_count: 0,
        history_count: 0,
        hook_count: 0,
      };
      const latestSession = latestByAgent.get(agent) ?? null;
      const bestRecall = pickBestRecallForAgent(recallItems, agent);
      return {
        agent,
        session_count: session.session_count,
        summary_session_count: session.summary_session_count,
        prompt_count: session.prompt_count,
        tool_event_count: session.tool_event_count,
        observation_count: obs.observation_count,
        handoff_count: obs.handoff_count,
        chat_message_count: chat.chat_message_count,
        chat_coverage_state:
          chat.transcript_count > 0
            ? "transcript-backed"
            : chat.history_count > 0
              ? "history-backed"
              : chat.hook_count > 0
                ? "hook-only"
                : "none",
        continuity_state: classifyAgentContinuity(
          session.last_seen_epoch,
          session.prompt_count,
          session.tool_event_count,
          chat.chat_message_count,
          obs.handoff_count,
          obs.observation_count
        ),
        capture_state: classifyAgentCaptureState(
          session.prompt_count,
          session.tool_event_count,
          session.summary_session_count,
          obs.observation_count,
          chat.chat_message_count
        ),
        last_seen_epoch: session.last_seen_epoch,
        latest_session_id: latestSession?.session_id ?? null,
        latest_summary: latestSession?.current_thread ?? latestSession?.request ?? latestSession?.completed ?? null,
        devices: Array.from(devicesByAgent.get(agent) ?? []).sort(),
        best_recall_key: bestRecall?.key ?? null,
        best_recall_title: bestRecall?.title ?? null,
        best_recall_kind: bestRecall?.kind ?? null,
        resume_freshness: bestRecall?.freshness ?? "stale",
      };
    })
    .sort((a, b) => {
      const epochA = a.last_seen_epoch ?? 0;
      const epochB = b.last_seen_epoch ?? 0;
      return epochB - epochA || a.agent.localeCompare(b.agent);
    });

  return {
    project: projectName,
    agents,
    suggested_tools: buildSuggestedTools(agents),
  };
}

function isInternalAgent(agent: string | null | undefined): boolean {
  return !agent || agent.startsWith("engrm-");
}

function classifyAgentContinuity(
  lastSeenEpoch: number | null,
  promptCount: number,
  toolCount: number,
  chatCount: number,
  handoffCount: number,
  observationCount: number
): AgentMemorySummary["continuity_state"] {
  if (!lastSeenEpoch) return "cold";
  const ageMs = Date.now() - lastSeenEpoch * 1000;
  const hasStrongContinuity = promptCount > 0 || toolCount > 0 || chatCount > 0 || handoffCount > 0;
  if (ageMs <= 3 * 24 * 60 * 60 * 1000 && hasStrongContinuity) return "fresh";
  if (observationCount > 0 || promptCount > 0 || toolCount > 0 || chatCount > 0) return "thin";
  return "cold";
}

function classifyAgentCaptureState(
  promptCount: number,
  toolCount: number,
  summarySessionCount: number,
  observationCount: number,
  chatCount: number
): AgentMemorySummary["capture_state"] {
  if (promptCount > 0 && toolCount > 0) return "rich";
  if (promptCount > 0 || toolCount > 0) return "partial";
  if (summarySessionCount > 0 || observationCount > 0 || chatCount > 0) return "summary-only";
  return "legacy";
}

function buildSuggestedTools(agents: AgentMemorySummary[]): string[] {
  if (agents.length === 0) return [];
  const suggestions = ["recent_sessions", "capture_quality"];
  if (agents.length > 1) {
    suggestions.push("list_recall_items");
  }
  if (agents.some((agent) => agent.best_recall_key)) {
    suggestions.push("load_recall_item");
  }
  if (agents.some((agent) => agent.continuity_state !== "fresh")) {
    suggestions.push("resume_thread");
  }
  if (agents.some((agent) => agent.chat_coverage_state === "hook-only")) {
    suggestions.push("repair_recall");
  }
  return suggestions;
}

function pickBestRecallForAgent(
  items: RecallIndexItem[],
  agent: string
): RecallIndexItem | null {
  return items.find((item) => item.source_agent === agent) ?? null;
}
