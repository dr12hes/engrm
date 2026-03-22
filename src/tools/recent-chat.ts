import { detectProject } from "../storage/projects.js";
import type { ChatMessageRow, MemDatabase } from "../storage/sqlite.js";

export type ChatCaptureOrigin = "transcript" | "history" | "hook";

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
  source_summary: {
    transcript: number;
    history: number;
    hook: number;
  };
  transcript_backed: boolean;
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
  };
}

function summarizeChatSources(messages: ChatMessageRow[]): { transcript: number; hook: number } {
  return messages.reduce(
    (summary, message) => {
      summary[getChatCaptureOrigin(message)] += 1;
      return summary;
    },
    { transcript: 0, history: 0, hook: 0 }
  );
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
