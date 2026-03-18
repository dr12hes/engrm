/**
 * pin_observation MCP tool.
 *
 * Pin or unpin an observation. Pinned observations are excluded
 * from lifecycle aging and archival.
 */

import type { MemDatabase } from "../storage/sqlite.js";

export interface PinInput {
  id: number;
  pinned: boolean;
}

export interface PinResult {
  success: boolean;
  reason?: string;
}

/**
 * Pin or unpin an observation.
 */
export function pinObservation(
  db: MemDatabase,
  input: PinInput
): PinResult {
  const success = db.pinObservation(input.id, input.pinned);

  if (!success) {
    const obs = db.getObservationById(input.id);
    if (!obs) {
      return { success: false, reason: `Observation #${input.id} not found` };
    }
    if (input.pinned) {
      return {
        success: false,
        reason: `Cannot pin observation in '${obs.lifecycle}' state (must be active or aging)`,
      };
    }
    return {
      success: false,
      reason: `Cannot unpin observation in '${obs.lifecycle}' state (must be pinned)`,
    };
  }

  return { success: true };
}
