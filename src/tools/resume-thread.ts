import { detectProject } from "../storage/projects.js";
import type { MemDatabase } from "../storage/sqlite.js";
import { loadHandoff, type HandoffRow } from "./handoffs.js";
import { getRecentChat, type ChatCoverageState } from "./recent-chat.js";
import { searchRecall, type SearchRecallEntry } from "./search-recall.js";
import { getSessionContext } from "./session-context.js";
import { getRecentSessions } from "./recent-sessions.js";

export interface ResumeThreadInput {
  cwd?: string;
  user_id?: string;
  current_device_id?: string;
  limit?: number;
}

export interface ResumeThreadResult {
  project_name: string | null;
  continuity_state: "fresh" | "thin" | "cold";
  continuity_summary: string;
  latest_request: string | null;
  current_thread: string | null;
  handoff: {
    id: number;
    title: string;
    source: string | null;
  } | null;
  recent_outcomes: string[];
  chat_coverage_state: ChatCoverageState;
  recent_chat: Array<{
    role: "user" | "assistant";
    source: "transcript" | "history" | "hook";
    content: string;
    created_at_epoch: number;
  }>;
  recall_hits: SearchRecallEntry[];
  suggested_tools: string[];
}

export async function resumeThread(
  db: MemDatabase,
  input: ResumeThreadInput = {}
): Promise<ResumeThreadResult> {
  const cwd = input.cwd ?? process.cwd();
  const limit = Math.max(2, Math.min(input.limit ?? 5, 8));
  const detected = detectProject(cwd);
  const project = db.getProjectByCanonicalId(detected.canonical_id);
  const context = getSessionContext(db, {
    cwd,
    user_id: input.user_id,
    current_device_id: input.current_device_id,
  });
  const handoffResult = loadHandoff(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    current_device_id: input.current_device_id,
  });
  const handoff = handoffResult.handoff;
  const recentChat = getRecentChat(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: Math.max(limit, 4),
  });
  const recentSessions = getRecentSessions(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 3,
  }).sessions;
  const recall = await searchRecall(db, {
    query: "what were we just talking about",
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit,
  });

  const latestSession = recentSessions[0] ?? null;
  const inferredRequest =
    latestSession?.request?.trim()
    || null;

  const currentThread =
    extractCurrentThread(handoff)
    || latestSession?.current_thread?.trim()
    || inferredRequest
    || context?.recent_outcomes[0]
    || recentChat.messages[recentChat.messages.length - 1]?.content.replace(/\s+/g, " ").trim().slice(0, 180)
    || null;

  const suggestedTools = Array.from(new Set([
    "search_recall",
    ...(recentChat.coverage_state !== "transcript-backed" && recentChat.messages.length > 0
      ? ["repair_recall", "refresh_chat_recall"]
      : []),
    ...(handoff ? ["load_handoff"] : []),
    ...(recentChat.messages.length > 0 ? ["recent_chat"] : []),
  ])).slice(0, 4);

  return {
    project_name: project?.name ?? context?.project_name ?? null,
    continuity_state: context?.continuity_state ?? "cold",
    continuity_summary: context?.continuity_summary ?? "No fresh repo-local continuity yet; older memory should be treated cautiously.",
    latest_request: inferredRequest,
    current_thread: currentThread,
    handoff: handoff
      ? {
          id: handoff.id,
          title: handoff.title,
          source: extractHandoffSource(handoff),
        }
      : null,
    recent_outcomes: context?.recent_outcomes ?? [],
    chat_coverage_state: recentChat.coverage_state,
    recent_chat: recentChat.messages
      .slice(-4)
      .map((message) => ({
        role: message.role,
        source: message.source_kind === "transcript"
          ? "transcript"
          : (typeof message.remote_source_id === "string" && message.remote_source_id.startsWith("history:"))
            ? "history"
            : "hook",
        content: message.content.replace(/\s+/g, " ").trim(),
        created_at_epoch: message.created_at_epoch,
      })),
    recall_hits: recall.results.slice(0, limit),
    suggested_tools: suggestedTools,
  };
}

function extractCurrentThread(handoff: HandoffRow | null): string | null {
  const narrative = handoff?.narrative ?? "";
  const match = narrative.match(/Current thread:\s*(.+)/i);
  return match?.[1]?.trim() ?? null;
}

function extractHandoffSource(handoff: HandoffRow): string | null {
  return handoff.device_id ?? null;
}
