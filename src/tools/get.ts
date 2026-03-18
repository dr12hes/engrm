/**
 * get_observations MCP tool.
 *
 * Retrieve observations by ID(s). Supports single and batch lookups.
 */

import type { MemDatabase, ObservationRow } from "../storage/sqlite.js";

export interface GetObservationsInput {
  ids: number[];
  user_id?: string;
}

export interface GetObservationsResult {
  observations: ObservationRow[];
  not_found: number[];
}

/**
 * Get observations by their IDs.
 */
export function getObservations(
  db: MemDatabase,
  input: GetObservationsInput
): GetObservationsResult {
  if (input.ids.length === 0) {
    return { observations: [], not_found: [] };
  }

  const observations = db.getObservationsByIds(input.ids, input.user_id);
  const foundIds = new Set(observations.map((o) => o.id));
  const notFound = input.ids.filter((id) => !foundIds.has(id));

  return { observations, not_found: notFound };
}
