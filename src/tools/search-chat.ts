import { detectProject } from "../storage/projects.js";
import type { ChatMessageRow, MemDatabase } from "../storage/sqlite.js";

export interface SearchChatInput {
  query: string;
  limit?: number;
  project_scoped?: boolean;
  cwd?: string;
  user_id?: string;
}

export interface SearchChatResult {
  messages: ChatMessageRow[];
  project?: string;
  session_count: number;
  source_summary: {
    transcript: number;
    hook: number;
  };
  transcript_backed: boolean;
}

export function searchChat(
  db: MemDatabase,
  input: SearchChatInput
): SearchChatResult {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
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

  const messages = db.searchChatMessages(input.query, projectId, limit, input.user_id);
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
      summary[message.source_kind] += 1;
      return summary;
    },
    { transcript: 0, hook: 0 }
  );
}

function countDistinctSessions(messages: ChatMessageRow[]): number {
  return new Set(messages.map((message) => message.session_id)).size;
}
