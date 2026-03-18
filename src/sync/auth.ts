/**
 * Sync authentication utilities.
 *
 * Resolves API credentials from environment variables or config.
 * Environment variable takes precedence for CI/CD use.
 */

import type { Config } from "../config.js";

/**
 * Get API key for Candengo Vector.
 * Priority: ENGRM_TOKEN env var → config.candengo_api_key
 */
export function getApiKey(config: Config): string | null {
  const envKey = process.env.ENGRM_TOKEN;
  if (envKey && envKey.startsWith("cvk_")) return envKey;
  if (config.candengo_api_key && config.candengo_api_key.length > 0) {
    return config.candengo_api_key;
  }
  return null;
}

/**
 * Get base URL for Candengo Vector API.
 */
export function getBaseUrl(config: Config): string | null {
  if (config.candengo_url && config.candengo_url.length > 0) {
    return config.candengo_url;
  }
  return null;
}

/**
 * Build a globally unique source ID for a record.
 * Format: {user_id}-{device_id}-{type}-{local_id}
 * Default type is "obs" for backwards compatibility.
 */
export function buildSourceId(config: Config, localId: number, type: string = "obs"): string {
  return `${config.user_id}-${config.device_id}-${type}-${localId}`;
}

/**
 * Parse a source ID back into its components.
 * Returns null if the format doesn't match.
 */
export function parseSourceId(
  sourceId: string
): { userId: string; deviceId: string; localId: number } | null {
  // Format: {user_id}-{device_id}-obs-{local_id}
  // Split on "-obs-" which is our guaranteed delimiter
  const obsIndex = sourceId.lastIndexOf("-obs-");
  if (obsIndex === -1) return null;

  const prefix = sourceId.slice(0, obsIndex);
  const localIdStr = sourceId.slice(obsIndex + 5); // skip "-obs-"
  const localId = parseInt(localIdStr, 10);
  if (isNaN(localId)) return null;

  // Split prefix on first "-" to get userId and deviceId
  const firstDash = prefix.indexOf("-");
  if (firstDash === -1) return null;

  return {
    userId: prefix.slice(0, firstDash),
    deviceId: prefix.slice(firstDash + 1),
    localId,
  };
}
