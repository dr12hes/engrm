import type { Config } from "../config.js";
import { syncTranscriptChat } from "../capture/transcript.js";
import { detectProject } from "../storage/projects.js";
import type { MemDatabase, SessionRow } from "../storage/sqlite.js";
import { getChatCoverageState, summarizeChatSources, type ChatCoverageState, type ChatSourceSummary } from "./recent-chat.js";

export interface RepairRecallInput {
  cwd?: string;
  session_id?: string;
  limit?: number;
  user_id?: string;
  transcript_path?: string;
}

export interface RepairRecallSessionResult {
  session_id: string;
  project_name: string | null;
  imported_chat_messages: number;
  transcript_messages_seen: number;
  chat_messages_after: number;
  prompt_count_after: number;
  chat_source_summary: ChatSourceSummary;
  chat_coverage_state: ChatCoverageState;
}

export interface RepairRecallResult {
  project_name: string | null;
  scope: "session" | "project" | "workspace";
  inspected_sessions: number;
  sessions_with_imports: number;
  imported_chat_messages: number;
  results: RepairRecallSessionResult[];
}

export async function repairRecall(
  db: MemDatabase,
  config: Config,
  input: RepairRecallInput = {}
): Promise<RepairRecallResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const cwd = input.cwd ?? process.cwd();

  let scope: RepairRecallResult["scope"] = "workspace";
  let projectName: string | null = null;
  let targetSessions: SessionRow[] = [];

  if (input.session_id) {
    scope = "session";
    const session = db.getSessionById(input.session_id);
    if (session) {
      targetSessions = [session];
      if (session.project_id !== null) {
        projectName = db.getProjectById(session.project_id)?.name ?? null;
      }
    }
  } else {
    const detected = detectProject(cwd);
    const project = db.getProjectByCanonicalId(detected.canonical_id);
    if (project) {
      scope = "project";
      projectName = project.name;
      targetSessions = db
        .getRecentSessions(project.id, limit, input.user_id)
        .map((session) => db.getSessionById(session.session_id))
        .filter((session): session is SessionRow => Boolean(session));
    } else {
      targetSessions = db
        .getRecentSessions(null, limit, input.user_id)
        .map((session) => db.getSessionById(session.session_id))
        .filter((session): session is SessionRow => Boolean(session));
    }
  }

  const results: RepairRecallSessionResult[] = [];
  let importedChatMessages = 0;
  let sessionsWithImports = 0;

  for (const session of targetSessions) {
    const sessionCwd = session.project_id !== null
      ? db.getProjectById(session.project_id)?.local_path ?? cwd
      : cwd;
    const syncResult = await syncTranscriptChat(
      db,
      config,
      session.session_id,
      sessionCwd,
      input.transcript_path
    );
    const chatMessages = db.getSessionChatMessages(session.session_id, 200);
    const prompts = db.getSessionUserPrompts(session.session_id, 200);
    const sourceSummary = summarizeChatSources(chatMessages);

    importedChatMessages += syncResult.imported;
    if (syncResult.imported > 0) sessionsWithImports += 1;

    results.push({
      session_id: session.session_id,
      project_name:
        session.project_id !== null ? db.getProjectById(session.project_id)?.name ?? null : null,
      imported_chat_messages: syncResult.imported,
      transcript_messages_seen: syncResult.total,
      chat_messages_after: chatMessages.length,
      prompt_count_after: prompts.length,
      chat_source_summary: sourceSummary,
      chat_coverage_state: getChatCoverageState(sourceSummary),
    });
  }

  return {
    project_name: projectName,
    scope,
    inspected_sessions: targetSessions.length,
    sessions_with_imports: sessionsWithImports,
    imported_chat_messages: importedChatMessages,
    results,
  };
}
