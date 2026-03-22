/**
 * activity_feed MCP tool.
 *
 * Merges prompts, tools, chat, observations, and session summaries into one
 * chronological local feed so agents can inspect the working story without
 * hopping between multiple narrower tools.
 */

import { detectProject } from "../storage/projects.js";
import type {
  ChatMessageRow,
  MemDatabase,
  ObservationRow,
  SessionSummaryRow,
  ToolEventRow,
  UserPromptRow,
} from "../storage/sqlite.js";
import { getRecentActivity } from "./recent.js";
import { getChatCaptureOrigin, getRecentChat } from "./recent-chat.js";
import { getRecentRequests } from "./recent-prompts.js";
import { getRecentSessions } from "./recent-sessions.js";
import { getRecentTools } from "./recent-tools.js";
import { getSessionStory } from "./session-story.js";
import { isDraftHandoff, looksLikeHandoff } from "./handoffs.js";

export interface ActivityFeedInput {
  limit?: number;
  project_scoped?: boolean;
  session_id?: string;
  cwd?: string;
  user_id?: string;
}

export interface ActivityFeedEvent {
  kind: "prompt" | "tool" | "chat" | "observation" | "summary" | "handoff";
  created_at_epoch: number;
  session_id: string | null;
  title: string;
  detail?: string;
  id?: number;
  observation_type?: string;
  handoff_kind?: "saved" | "draft";
}

export interface ActivityFeedResult {
  events: ActivityFeedEvent[];
  project?: string;
}

function toPromptEvent(prompt: UserPromptRow): ActivityFeedEvent {
  return {
    kind: "prompt",
    created_at_epoch: prompt.created_at_epoch,
    session_id: prompt.session_id,
    id: prompt.id,
    title: `#${prompt.prompt_number} ${prompt.prompt.replace(/\s+/g, " ").trim()}`,
  };
}

function toToolEvent(tool: ToolEventRow): ActivityFeedEvent {
  const detail = tool.file_path ?? tool.command ?? tool.tool_response_preview ?? undefined;
  return {
    kind: "tool",
    created_at_epoch: tool.created_at_epoch,
    session_id: tool.session_id,
    id: tool.id,
    title: tool.tool_name,
    detail: detail?.replace(/\s+/g, " ").trim(),
  };
}

function toChatEvent(message: ChatMessageRow): ActivityFeedEvent {
  const content = message.content.replace(/\s+/g, " ").trim();
  const origin = getChatCaptureOrigin(message);
  return {
    kind: "chat",
    created_at_epoch: message.created_at_epoch,
    session_id: message.session_id,
    id: message.id,
    title: `${message.role} [${origin}]`,
    detail: content.slice(0, 220),
  };
}

function toObservationEvent(obs: ObservationRow): ActivityFeedEvent {
  if (looksLikeHandoff(obs)) {
    const handoffKind = isDraftHandoff(obs) ? "draft" : "saved";
    return {
      kind: "handoff",
      created_at_epoch: obs.created_at_epoch,
      session_id: obs.session_id,
      id: obs.id,
      title: obs.title,
      detail: `${handoffKind === "draft" ? "rolling draft" : "saved handoff"}${obs.narrative ? ` · ${obs.narrative.replace(/\s+/g, " ").trim().slice(0, 220)}` : ""}`,
      observation_type: obs.type,
      handoff_kind: handoffKind,
    };
  }
  const detailBits: string[] = [];
  if (obs.source_tool) detailBits.push(`via ${obs.source_tool}`);
  if (typeof obs.source_prompt_number === "number") {
    detailBits.push(`#${obs.source_prompt_number}`);
  }
  return {
    kind: "observation",
    created_at_epoch: obs.created_at_epoch,
    session_id: obs.session_id,
    id: obs.id,
    title: obs.title,
    detail: detailBits.length > 0 ? detailBits.join(" · ") : undefined,
    observation_type: obs.type,
  };
}

function toSummaryEvent(
  summary: SessionSummaryRow,
  fallbackEpoch: number = 0,
  extras?: {
    capture_state?: string;
    prompt_count?: number;
    tool_event_count?: number;
    latest_request?: string | null;
  }
): ActivityFeedEvent | null {
  const title = summary.request ?? summary.completed ?? summary.learned ?? summary.investigated;
  if (!title) return null;

  const detail = [
    extras?.capture_state ? `Capture: ${extras.capture_state}` : null,
    typeof extras?.prompt_count === "number" && typeof extras?.tool_event_count === "number"
      ? `Prompts/tools: ${extras.prompt_count}/${extras.tool_event_count}`
      : null,
    extras?.latest_request && extras.latest_request !== title ? `Latest request: ${extras.latest_request}` : null,
    summary.completed && summary.completed !== title ? `Completed: ${summary.completed}` : null,
    summary.learned ? `Learned: ${summary.learned}` : null,
    summary.next_steps ? `Next: ${summary.next_steps}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    kind: "summary",
    created_at_epoch: summary.created_at_epoch ?? fallbackEpoch,
    session_id: summary.session_id,
    id: summary.id,
    title: title.replace(/\s+/g, " ").trim(),
    detail: detail || undefined,
  };
}

function compareEvents(a: ActivityFeedEvent, b: ActivityFeedEvent): number {
  if (b.created_at_epoch !== a.created_at_epoch) {
    return b.created_at_epoch - a.created_at_epoch;
  }

  const kindOrder: Record<ActivityFeedEvent["kind"], number> = {
    summary: 0,
    handoff: 1,
    observation: 2,
    tool: 3,
    chat: 4,
    prompt: 5,
  };
  if (kindOrder[a.kind] !== kindOrder[b.kind]) {
    return kindOrder[a.kind] - kindOrder[b.kind];
  }

  return (b.id ?? 0) - (a.id ?? 0);
}

export function getActivityFeed(
  db: MemDatabase,
  input: ActivityFeedInput
): ActivityFeedResult {
  const limit = Math.max(1, Math.min(input.limit ?? 30, 100));

  if (input.session_id) {
    const story = getSessionStory(db, { session_id: input.session_id });
    const project =
      story.session?.project_id !== null && story.session?.project_id !== undefined
        ? db.getProjectById(story.session.project_id)?.name
        : undefined;

    const events = [
      ...(story.summary
        ? [toSummaryEvent(
            story.summary,
            story.session?.completed_at_epoch ?? story.session?.started_at_epoch ?? 0,
            {
              capture_state: story.capture_state,
              prompt_count: story.prompts.length,
              tool_event_count: story.tool_events.length,
              latest_request: story.latest_request,
            }
          )].filter(
            (event): event is ActivityFeedEvent => event !== null
          )
        : []),
      ...story.prompts.map(toPromptEvent),
      ...story.tool_events.map(toToolEvent),
      ...story.chat_messages.map(toChatEvent),
      ...story.handoffs.map(toObservationEvent),
      ...story.observations.map(toObservationEvent),
    ]
      .sort(compareEvents)
      .slice(0, limit);

    return { events, project };
  }

  const projectScoped = input.project_scoped !== false;
  let projectName: string | undefined;

  if (projectScoped) {
    const cwd = input.cwd ?? process.cwd();
    const detected = detectProject(cwd);
    const project = db.getProjectByCanonicalId(detected.canonical_id);
    if (project) {
      projectName = project.name;
    }
  }

  const prompts = getRecentRequests(db, { ...input, limit }).prompts;
  const tools = getRecentTools(db, { ...input, limit }).tool_events;
  const observations = getRecentActivity(db, {
    limit,
    project_scoped: input.project_scoped,
    cwd: input.cwd,
    user_id: input.user_id,
  }).observations;
  const chat = getRecentChat(db, {
    ...input,
    limit,
  }).messages;
  const sessions = getRecentSessions(db, {
    limit,
    project_scoped: input.project_scoped,
    cwd: input.cwd,
    user_id: input.user_id,
  }).sessions;

  const summaryEvents = sessions
    .map((session) => {
      const summary = db.getSessionSummary(session.session_id);
      if (!summary) return null;
      return toSummaryEvent(
        summary,
        session.completed_at_epoch ?? session.started_at_epoch ?? 0,
        {
          capture_state: session.capture_state,
          prompt_count: session.prompt_count,
          tool_event_count: session.tool_event_count,
          latest_request: summary.request,
        }
      );
    })
    .filter((event): event is ActivityFeedEvent => event !== null);

  const events = [
    ...summaryEvents,
    ...prompts.map(toPromptEvent),
    ...tools.map(toToolEvent),
    ...chat.map(toChatEvent),
    ...observations.map(toObservationEvent),
  ]
    .sort(compareEvents)
    .slice(0, limit);

  return {
    events,
    project: projectName,
  };
}
