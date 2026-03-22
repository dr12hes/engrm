/**
 * Transcript analysis — extract plans, decisions, and insights
 * from Claude Code JSONL session transcripts.
 *
 * Opt-in feature. Server-side LLM extraction. Raw transcript
 * deleted after processing. Double opt-in required.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";
import type { MemDatabase } from "../storage/sqlite.js";
import { composeChatEmbeddingText, embedText } from "../embeddings/embedder.js";
import { detectProject } from "../storage/projects.js";
import { saveObservation } from "../tools/save.js";

// --- Types ---

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

export interface TranscriptAnalysisItem {
  title: string;
  narrative: string;
  concepts: string[];
}

export interface TranscriptAnalysisResult {
  plans: TranscriptAnalysisItem[];
  decisions: TranscriptAnalysisItem[];
  insights: TranscriptAnalysisItem[];
}

export interface TranscriptChatSyncResult {
  imported: number;
  total: number;
}

interface HistoryEntry {
  display: string;
  project: string;
  sessionId: string;
  timestamp: number;
}

// --- Public API ---

/**
 * Resolve the path to a Claude Code session transcript.
 * Claude Code stores transcripts as JSONL at:
 *   ~/.claude/projects/{cwd with / replaced by -}/{sessionId}.jsonl
 */
export function resolveTranscriptPath(
  sessionId: string,
  cwd: string,
  transcriptPath?: string
): string {
  if (transcriptPath) return transcriptPath;

  // Claude Code encodes the cwd by replacing path separators
  const encodedCwd = cwd.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", encodedCwd, `${sessionId}.jsonl`);
}

/**
 * Read and parse a Claude Code JSONL transcript.
 * Extracts user and assistant text content only (skips thinking, tool_use, tool_result).
 */
export function readTranscript(
  sessionId: string,
  cwd: string,
  transcriptPath?: string
): TranscriptMessage[] {
  const path = resolveTranscriptPath(sessionId, cwd, transcriptPath);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const messages: TranscriptMessage[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Only process user and assistant messages
    const role = entry.role;
    if (role !== "user" && role !== "assistant") continue;

    // Extract text content blocks
    const content = entry.content;
    if (typeof content === "string") {
      messages.push({ role, text: content });
      continue;
    }

    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        }
      }
      if (textParts.length > 0) {
        messages.push({ role, text: textParts.join("\n") });
      }
    }
  }

  return messages;
}

export function resolveHistoryPath(historyPath?: string): string {
  if (historyPath) return historyPath;
  const override = process.env["ENGRM_CLAUDE_HISTORY_PATH"];
  if (override) return override;
  return join(homedir(), ".claude", "history.jsonl");
}

export function readHistoryFallback(
  sessionId: string,
  cwd: string,
  opts?: {
    historyPath?: string;
    startedAtEpoch?: number | null;
    completedAtEpoch?: number | null;
  }
): Array<TranscriptMessage & { createdAtEpoch: number }> {
  const path = resolveHistoryPath(opts?.historyPath);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const targetCanonical = detectProject(cwd).canonical_id;
  const windowStart = Math.max(0, (opts?.startedAtEpoch ?? Math.floor(Date.now() / 1000) - 6 * 3600) - 600);
  const windowEnd = (opts?.completedAtEpoch ?? Math.floor(Date.now() / 1000)) + 600;
  const entries: HistoryEntry[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof entry?.display !== "string" || typeof entry?.timestamp !== "number") continue;
    const createdAtEpoch = Math.floor(entry.timestamp / 1000);
    entries.push({
      display: entry.display.trim(),
      project: typeof entry.project === "string" ? entry.project : "",
      sessionId: typeof entry.sessionId === "string" ? entry.sessionId : "",
      timestamp: createdAtEpoch,
    });
  }

  const bySession = entries
    .filter((entry) => entry.display.length > 0 && entry.sessionId === sessionId)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (bySession.length > 0) {
    return dedupeHistoryMessages(
      bySession.map((entry) => ({
        role: "user" as const,
        text: entry.display,
        createdAtEpoch: entry.timestamp,
      }))
    );
  }

  const byProjectAndWindow = entries
    .filter((entry) => {
      if (entry.display.length === 0) return false;
      if (entry.timestamp < windowStart || entry.timestamp > windowEnd) return false;
      if (!entry.project) return false;
      return detectProject(entry.project).canonical_id === targetCanonical;
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  return dedupeHistoryMessages(
    byProjectAndWindow.map((entry) => ({
      role: "user" as const,
      text: entry.display,
      createdAtEpoch: entry.timestamp,
    }))
  );
}

/**
 * Import transcript user/assistant turns into the separate chat lane.
 * Transcript-backed rows are stored separately from hook-captured chat so
 * recall can prefer the fuller conversation when it is available.
 */
export async function syncTranscriptChat(
  db: MemDatabase,
  config: Config,
  sessionId: string,
  cwd: string,
  transcriptPath?: string
): TranscriptChatSyncResult {
  const session = db.getSessionById(sessionId);
  const transcriptMessages = readTranscript(sessionId, cwd, transcriptPath)
    .map((message) => ({
      ...message,
      text: message.text.trim(),
    }))
    .filter((message) => message.text.length > 0);
  const messages =
    transcriptMessages.length > 0
      ? transcriptMessages.map((message, index) => ({
          ...message,
          sourceKind: "transcript" as const,
          transcriptIndex: index + 1,
          createdAtEpoch: null as number | null,
          remoteSourceId: null as string | null,
        }))
      : readHistoryFallback(sessionId, cwd, {
          startedAtEpoch: session?.started_at_epoch ?? null,
          completedAtEpoch: session?.completed_at_epoch ?? null,
        }).map((message) => ({
          role: message.role,
          text: message.text,
          sourceKind: "hook" as const,
          transcriptIndex: null as number | null,
          createdAtEpoch: message.createdAtEpoch,
          remoteSourceId: buildHistorySourceId(sessionId, message.createdAtEpoch, message.text),
        }));
  if (messages.length === 0) return { imported: 0, total: 0 };

  const projectId = session?.project_id ?? null;
  const now = Math.floor(Date.now() / 1000);
  let imported = 0;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const transcriptIndex = message.transcriptIndex ?? index + 1;
    if (message.sourceKind === "transcript" && db.getTranscriptChatMessage(sessionId, transcriptIndex)) {
      continue;
    }
    if (message.remoteSourceId && db.getChatMessageByRemoteSourceId(message.remoteSourceId)) {
      continue;
    }

    const createdAtEpoch = message.createdAtEpoch ?? Math.max(0, now - (messages.length - transcriptIndex));
    const row = db.insertChatMessage({
      session_id: sessionId,
      project_id: projectId,
      role: message.role,
      content: message.text,
      user_id: config.user_id,
      device_id: config.device_id,
      agent: "claude-code",
      created_at_epoch: createdAtEpoch,
      remote_source_id: message.remoteSourceId,
      source_kind: message.sourceKind,
      transcript_index: message.transcriptIndex,
    });
    db.addToOutbox("chat_message", row.id);
    if (message.role === "user") {
      db.insertUserPrompt({
        session_id: sessionId,
        project_id: projectId,
        prompt: message.text,
        cwd,
        user_id: config.user_id,
        device_id: config.device_id,
        agent: "claude-code",
        created_at_epoch: createdAtEpoch,
      });
    }
    if (db.vecAvailable) {
      const embedding = await embedText(composeChatEmbeddingText(message.text));
      if (embedding) {
        db.vecChatInsert(row.id, embedding);
      }
    }
    imported++;
  }

  return { imported, total: messages.length };
}

function dedupeHistoryMessages(
  messages: Array<TranscriptMessage & { createdAtEpoch: number }>
): Array<TranscriptMessage & { createdAtEpoch: number }> {
  const deduped: Array<TranscriptMessage & { createdAtEpoch: number }> = [];
  for (const message of messages) {
    const compact = message.text.replace(/\s+/g, " ").trim();
    if (!compact) continue;
    const previous = deduped[deduped.length - 1];
    if (previous && previous.text.replace(/\s+/g, " ").trim() === compact) continue;
    deduped.push({ ...message, text: compact });
  }
  return deduped;
}

function buildHistorySourceId(sessionId: string, createdAtEpoch: number, text: string): string {
  const digest = createHash("sha1").update(text).digest("hex").slice(0, 12);
  return `history:${sessionId}:${createdAtEpoch}:${digest}`;
}

/**
 * Truncate transcript messages to a max byte size.
 * Takes the LAST portion (most recent = most relevant).
 */
export function truncateTranscript(messages: TranscriptMessage[], maxBytes: number = 50000): string {
  const lines: string[] = [];
  for (const msg of messages) {
    lines.push(`[${msg.role}]: ${msg.text}`);
  }

  const full = lines.join("\n");
  if (Buffer.byteLength(full, "utf-8") <= maxBytes) return full;

  // Take from the end — most recent messages are most relevant
  let result = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines[i] + "\n" + result;
    if (Buffer.byteLength(candidate, "utf-8") > maxBytes) break;
    result = candidate;
  }

  return result.trim();
}

/**
 * Send transcript to server for LLM-based analysis.
 * Returns structured plans, decisions, and insights.
 */
export async function analyzeTranscript(
  config: Config,
  transcript: string,
  sessionId: string
): Promise<TranscriptAnalysisResult | null> {
  if (!config.candengo_url || !config.candengo_api_key) return null;

  const url = `${config.candengo_url}/v1/mem/transcript-analysis`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.candengo_api_key}`,
      },
      body: JSON.stringify({
        transcript,
        session_id: sessionId,
      }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = (await response.json()) as TranscriptAnalysisResult;

    // Validate shape
    if (!Array.isArray(data.plans) || !Array.isArray(data.decisions) || !Array.isArray(data.insights)) {
      return null;
    }

    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Save transcript analysis results as observations.
 * Plans and decisions → type "decision", insights → type "discovery".
 */
export async function saveTranscriptResults(
  db: MemDatabase,
  config: Config,
  results: TranscriptAnalysisResult,
  sessionId: string,
  cwd?: string
): Promise<number> {
  let saved = 0;

  const items: Array<{ item: TranscriptAnalysisItem; type: string }> = [
    ...results.plans.map((item) => ({ item, type: "decision" })),
    ...results.decisions.map((item) => ({ item, type: "decision" })),
    ...results.insights.map((item) => ({ item, type: "discovery" })),
  ];

  for (const { item, type } of items) {
    if (!item.title || item.title.trim().length === 0) continue;

    const result = await saveObservation(db, config, {
      type,
      title: item.title.slice(0, 80),
      narrative: item.narrative,
      concepts: item.concepts,
      session_id: sessionId,
      cwd,
    });

    if (result.success) saved++;
  }

  return saved;
}
