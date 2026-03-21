import { detectProject } from "../storage/projects.js";
import type { ChatMessageRow, MemDatabase } from "../storage/sqlite.js";

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
}

export function getRecentChat(
  db: MemDatabase,
  input: RecentChatInput
): RecentChatResult {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));

  if (input.session_id) {
    return {
      messages: db.getSessionChatMessages(input.session_id, limit).slice(-limit).reverse(),
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

  return {
    messages: db.getRecentChatMessages(projectId, limit, input.user_id),
    project: projectName,
  };
}
