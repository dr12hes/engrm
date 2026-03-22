import { detectProject } from "../storage/projects.js";
import type { ChatMessageRow, MemDatabase } from "../storage/sqlite.js";

export type ChatCaptureOrigin = "transcript" | "history" | "hook";
export type ChatCoverageState = "transcript-backed" | "history-backed" | "hook-only" | "none";
export interface ChatSourceSummary {
  transcript: number;
  history: number;
  hook: number;
}

export interface RecentChatInput {
  limit?: number;
  project_scoped?: boolean;
  session_id?: string;
  cwd?: string;
  user_id?: string;
}

export interface RecentChatResult {
  messages: ChatMessageRow[];
  project?: string;
  session_count: number;
  source_summary: ChatSourceSummary;
  transcript_backed: boolean;
  coverage_state: ChatCoverageState;
}

export function getRecentChat(
  db: MemDatabase,
  input: RecentChatInput
): RecentChatResult {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));

  if (input.session_id) {
    const messages = db.getSessionChatMessages(input.session_id, limit).slice(-limit).reverse();
    return {
      messages,
      session_count: countDistinctSessions(messages),
      source_summary: summarizeChatSources(messages),
      transcript_backed: messages.some((message) => message.source_kind === "transcript"),
      coverage_state: getChatCoverageState(messages),
    };
  }

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

  const messages = db.getRecentChatMessages(projectId, limit, input.user_id);
  return {
    messages,
    project: projectName,
    session_count: countDistinctSessions(messages),
    source_summary: summarizeChatSources(messages),
    transcript_backed: messages.some((message) => message.source_kind === "transcript"),
    coverage_state: getChatCoverageState(messages),
  };
}

export function summarizeChatSources(messages: Array<Pick<ChatMessageRow, "source_kind" | "remote_source_id">>): ChatSourceSummary {
  return messages.reduce(
    (summary, message) => {
      summary[getChatCaptureOrigin(message)] += 1;
      return summary;
    },
    { transcript: 0, history: 0, hook: 0 }
  );
}

export function getChatCoverageState(
  messagesOrSummary: Array<Pick<ChatMessageRow, "source_kind" | "remote_source_id">> | ChatSourceSummary
): ChatCoverageState {
  const summary = Array.isArray(messagesOrSummary)
    ? summarizeChatSources(messagesOrSummary)
    : messagesOrSummary;
  if (summary.transcript > 0) return "transcript-backed";
  if (summary.history > 0) return "history-backed";
  if (summary.hook > 0) return "hook-only";
  return "none";
}

function countDistinctSessions(messages: ChatMessageRow[]): number {
  return new Set(messages.map((message) => message.session_id)).size;
}

export function getChatCaptureOrigin(message: Pick<ChatMessageRow, "source_kind" | "remote_source_id">): ChatCaptureOrigin {
  if (message.source_kind === "transcript") return "transcript";
  if (typeof message.remote_source_id === "string" && message.remote_source_id.startsWith("history:")) {
    return "history";
  }
  return "hook";
}
