/**
 * Observer agent — uses Claude Agent SDK to extract rich observations
 * from tool use events.
 *
 * Architecture:
 *   1. PostToolUse hook calls observeToolEvent() with the raw event
 *   2. We call query() via the Agent SDK with the event formatted as context
 *   3. Claude responds with structured XML observation (or <skip/>)
 *   4. We parse the XML and return a SaveObservationInput
 *
 * Session persistence:
 *   - The observer session ID is stored in ~/.engrm/observer-{session_id}.json
 *   - Subsequent events resume the same observer session for context continuity
 *   - Claude remembers prior events in the session ("you already saw auth.ts change")
 *
 * Fallback:
 *   - If the Agent SDK is unavailable or fails, returns null
 *   - Caller should fall back to heuristic extraction
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { OBSERVER_SYSTEM_PROMPT, formatToolEvent } from "./prompts.js";
import { parseObservationXml, type ParsedObservation } from "./parser.js";
import type { ToolUseEvent } from "../capture/extractor.js";
import type { SaveObservationInput } from "../tools/save.js";

const ENGRM_DIR = join(homedir(), ".engrm");
const OBSERVER_DIR = join(ENGRM_DIR, "observer-sessions");

interface ObserverState {
  observerSessionId: string;
  eventCount: number;
  saveCount?: number;
}

/**
 * Get the state file path for an observer session.
 */
function stateFilePath(sessionId: string): string {
  return join(OBSERVER_DIR, `${sessionId}.json`);
}

/**
 * Read observer state for a coding session.
 */
function readState(sessionId: string): ObserverState | null {
  const path = stateFilePath(sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ObserverState;
  } catch {
    return null;
  }
}

/**
 * Write observer state.
 */
function writeState(sessionId: string, state: ObserverState): void {
  if (!existsSync(OBSERVER_DIR)) {
    mkdirSync(OBSERVER_DIR, { recursive: true });
  }
  writeFileSync(stateFilePath(sessionId), JSON.stringify(state), "utf-8");
}

/**
 * Observe a tool use event using the Claude Agent SDK.
 *
 * Returns a SaveObservationInput if Claude produces a meaningful observation,
 * or null if the event was skipped or the SDK is unavailable.
 */
export interface ObserveOptions {
  /** Model to use (default: "haiku") */
  model?: string;
}

export async function observeToolEvent(
  event: ToolUseEvent,
  options?: ObserveOptions
): Promise<SaveObservationInput | null> {
  // Dynamic import — fails gracefully if SDK not installed
  let query: typeof import("@anthropic-ai/claude-agent-sdk").query;
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    query = sdk.query;
  } catch {
    return null; // SDK not available — caller will use heuristic fallback
  }

  const eventXml = formatToolEvent(event);

  // Build the prompt
  const state = readState(event.session_id);
  const isFirst = !state;

  const prompt = isFirst
    ? `${OBSERVER_SYSTEM_PROMPT}\n\nObserve this tool event from the coding session and respond with an <observation> or <skip/>:\n\n${eventXml}`
    : `Observe this next tool event and respond with an <observation> or <skip/>:\n\n${eventXml}`;

  try {
    let observerSessionId = state?.observerSessionId;
    let responseText = "";

    const queryOptions: Record<string, unknown> = {
      model: options?.model ?? "haiku",
      maxTurns: 1,
      disallowedTools: [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Grep",
        "Glob",
        "WebFetch",
        "WebSearch",
        "Agent",
      ],
    };

    if (observerSessionId) {
      queryOptions.resume = observerSessionId;
    }

    const result = query({
      prompt,
      options: queryOptions as import("@anthropic-ai/claude-agent-sdk").Options,
    });

    for await (const message of result) {
      // Capture session ID from first message
      if ("session_id" in message && message.session_id) {
        observerSessionId = message.session_id;
      }

      // Extract text from assistant messages
      if (message.type === "assistant" && "message" in message) {
        const msg = message.message as { content?: Array<{ type: string; text?: string }> };
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              responseText += block.text;
            }
          }
        }
      }

      // Also check result messages
      if (message.type === "result" && "result" in message) {
        const resultMsg = message as { result?: string };
        if (resultMsg.result && !responseText) {
          responseText = resultMsg.result;
        }
      }
    }

    // Save observer session state for resume
    if (observerSessionId) {
      writeState(event.session_id, {
        observerSessionId,
        eventCount: (state?.eventCount ?? 0) + 1,
      });
    }

    // Parse the observation
    if (!responseText.trim()) return null;

    const parsed = parseObservationXml(responseText);
    if (!parsed) return null;

    // Convert to SaveObservationInput
    const { files_read, files_modified } = extractFilesFromEvent(event);
    return {
      type: parsed.type,
      title: parsed.title,
      narrative: parsed.narrative || undefined,
      facts: parsed.facts.length > 0 ? parsed.facts : undefined,
      concepts: parsed.concepts.length > 0 ? parsed.concepts : undefined,
      files_read,
      files_modified,
      session_id: event.session_id,
      cwd: event.cwd,
    };
  } catch {
    // Agent SDK failed — return null for heuristic fallback
    return null;
  }
}

/**
 * Extract file paths from a tool event for the observation metadata.
 * Separates reads (Read tool) from writes (Edit/Write tools).
 */
function extractFilesFromEvent(event: ToolUseEvent): {
  files_read?: string[];
  files_modified?: string[];
} {
  const filePath = event.tool_input["file_path"] as string | undefined;
  if (!filePath) return {};

  if (event.tool_name === "Read") {
    return { files_read: [filePath] };
  }
  return { files_modified: [filePath] };
}

/**
 * Increment the observer save count for a session.
 * Called when an observation is saved (by observer or heuristic).
 */
export function incrementObserverSaveCount(sessionId: string): void {
  try {
    const state = readState(sessionId);
    if (state) {
      state.saveCount = (state.saveCount ?? 0) + 1;
      writeState(sessionId, state);
    } else {
      // No observer state yet — create one to track heuristic saves
      if (!existsSync(OBSERVER_DIR)) {
        mkdirSync(OBSERVER_DIR, { recursive: true });
      }
      writeState(sessionId, {
        observerSessionId: "",
        eventCount: 0,
        saveCount: 1,
      });
    }
  } catch {
    // Best-effort
  }
}
