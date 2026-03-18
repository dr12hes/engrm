/**
 * send_message MCP tool.
 *
 * Creates a lightweight cross-device/team note. Messages are stored as
 * observations of type "message" so they participate in existing sync and
 * inbox flows.
 */

import type { Config } from "../config.js";
import type { MemDatabase } from "../storage/sqlite.js";
import { saveObservation } from "./save.js";

export interface SendMessageInput {
  title: string;
  narrative?: string;
  concepts?: string[];
  session_id?: string;
  cwd?: string;
}

export interface SendMessageResult {
  success: boolean;
  observation_id?: number;
  reason?: string;
}

export async function sendMessage(
  db: MemDatabase,
  config: Config,
  input: SendMessageInput
): Promise<SendMessageResult> {
  const result = await saveObservation(db, config, {
    type: "message",
    title: input.title,
    narrative: input.narrative,
    concepts: input.concepts,
    session_id: input.session_id,
    cwd: input.cwd,
  });

  return {
    success: result.success,
    observation_id: result.observation_id,
    reason: result.reason,
  };
}
