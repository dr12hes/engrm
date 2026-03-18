/**
 * Transcript analysis — extract plans, decisions, and insights
 * from Claude Code JSONL session transcripts.
 *
 * Opt-in feature. Server-side LLM extraction. Raw transcript
 * deleted after processing. Double opt-in required.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";
import type { MemDatabase } from "../storage/sqlite.js";
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
