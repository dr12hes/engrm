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

  return {
    messages: db.searchChatMessages(input.query, projectId, limit, input.user_id),
    project: projectName,
  };
}
