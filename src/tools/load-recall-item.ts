import type { MemDatabase } from "../storage/sqlite.js";
import { loadHandoff } from "./handoffs.js";
import { getObservations } from "./get.js";
import { getSessionStory } from "./session-story.js";
import { getRecentChat } from "./recent-chat.js";

export interface LoadRecallItemInput {
  key: string;
  cwd?: string;
  user_id?: string;
  current_device_id?: string;
}

export interface LoadRecallItemResult {
  kind: "handoff" | "thread" | "chat" | "memory" | "unknown";
  key: string;
  title: string | null;
  detail: string | null;
  session_id: string | null;
  source_device_id: string | null;
  source_agent: string | null;
  payload:
    | { type: "handoff"; handoff_id: number; narrative: string | null }
    | { type: "thread"; latest_request: string | null; current_thread: string | null; recent_outcomes: string[]; hot_files: Array<{ path: string; count: number }> }
    | { type: "chat"; role: "user" | "assistant"; content: string; source: string }
    | { type: "memory"; observation_id: number; observation_type: string; narrative: string | null; facts: string | null }
    | null;
}

export function loadRecallItem(
  db: MemDatabase,
  input: LoadRecallItemInput
): LoadRecallItemResult {
  const [kind, rawId] = input.key.split(":", 2);
  if (!kind || !rawId) {
    return {
      kind: "unknown",
      key: input.key,
      title: null,
      detail: "Malformed recall key",
      session_id: null,
      source_device_id: null,
      source_agent: null,
      payload: null,
    };
  }

  if (kind === "handoff") {
    const id = Number.parseInt(rawId, 10);
    const result = loadHandoff(db, {
      id,
      cwd: input.cwd,
      user_id: input.user_id,
      current_device_id: input.current_device_id,
    });
    if (!result.handoff) {
      return missing(input.key, "handoff");
    }
    return {
      kind: "handoff",
      key: input.key,
      title: result.handoff.title,
      detail: summarizeNarrative(result.handoff.narrative),
      session_id: result.handoff.session_id ?? null,
      source_device_id: result.handoff.device_id ?? null,
      source_agent: result.handoff.session_id ? lookupSessionAgent(db, result.handoff.session_id) : null,
      payload: {
        type: "handoff",
        handoff_id: result.handoff.id,
        narrative: result.handoff.narrative ?? null,
      },
    };
  }

  if (kind === "session") {
    const story = getSessionStory(db, { session_id: rawId });
    if (!story.session) {
      return missing(input.key, "thread");
    }
    return {
      kind: "thread",
      key: input.key,
      title: story.summary?.current_thread ?? story.latest_request ?? story.summary?.completed ?? story.session.session_id,
      detail: story.summary?.next_steps ?? story.summary?.completed ?? null,
      session_id: story.session.session_id,
      source_device_id: story.session.device_id ?? null,
      source_agent: story.session.agent ?? null,
      payload: {
        type: "thread",
        latest_request: story.latest_request,
        current_thread: story.summary?.current_thread ?? null,
        recent_outcomes: story.recent_outcomes,
        hot_files: story.hot_files,
      },
    };
  }

  if (kind === "chat") {
    const id = Number.parseInt(rawId, 10);
    const messages = getRecentChat(db, {
      cwd: input.cwd,
      project_scoped: false,
      user_id: input.user_id,
      limit: 200,
    }).messages;
    const message = messages.find((item) => item.id === id);
    if (!message) {
      return missing(input.key, "chat");
    }
    const source =
      message.source_kind === "transcript"
        ? "transcript"
        : message.remote_source_id?.startsWith("history:")
          ? "history"
          : "hook";
    return {
      kind: "chat",
      key: input.key,
      title: `${message.role} [${source}]`,
      detail: message.content,
      session_id: message.session_id,
      source_device_id: message.device_id ?? null,
      source_agent: message.agent ?? null,
      payload: {
        type: "chat",
        role: message.role,
        content: message.content,
        source,
      },
    };
  }

  if (kind === "obs") {
    const id = Number.parseInt(rawId, 10);
    const result = getObservations(db, {
      ids: [id],
      user_id: input.user_id,
    });
    const obs = result.observations[0];
    if (!obs) {
      return missing(input.key, "memory");
    }
    return {
      kind: "memory",
      key: input.key,
      title: obs.title,
      detail: obs.narrative ?? obs.facts ?? null,
      session_id: obs.session_id ?? null,
      source_device_id: obs.device_id ?? null,
      source_agent: obs.session_id ? lookupSessionAgent(db, obs.session_id) : (obs.agent?.startsWith("engrm-") ? null : obs.agent ?? null),
      payload: {
        type: "memory",
        observation_id: obs.id,
        observation_type: obs.type,
        narrative: obs.narrative ?? null,
        facts: obs.facts ?? null,
      },
    };
  }

  return missing(input.key, "unknown");
}

function summarizeNarrative(value: string | null): string | null {
  if (!value) return null;
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function lookupSessionAgent(db: MemDatabase, sessionId: string): string | null {
  const row = db.db
    .query<{ agent: string | null }, [string]>("SELECT agent FROM sessions WHERE session_id = ? LIMIT 1")
    .get(sessionId);
  return row?.agent ?? null;
}

function missing(key: string, kind: LoadRecallItemResult["kind"]): LoadRecallItemResult {
  return {
    kind,
    key,
    title: null,
    detail: "Recall item not found",
    session_id: null,
    source_device_id: null,
    source_agent: null,
    payload: null,
  };
}
