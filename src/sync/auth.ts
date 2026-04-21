/**
 * Sync authentication utilities.
 *
 * Resolves API credentials from environment variables or config.
 * Environment variable takes precedence for CI/CD use.
 */

import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { MemDatabase } from "../storage/sqlite.js";
import { classifyOutboxFailure, resetFailedEntries, resetFailedEntriesMatching, resetStaleSyncingEntries, resetSyncingEntries } from "../storage/outbox.js";

const LEGACY_PUBLIC_HOSTS = new Set(["www.candengo.com", "candengo.com"]);

export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (LEGACY_PUBLIC_HOSTS.has(parsed.hostname)) {
      parsed.hostname = "engrm.dev";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}

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
    return normalizeBaseUrl(config.candengo_url);
  }
  return null;
}

export function getAuthFingerprint(config: Config): string | null {
  const apiKey = getApiKey(config);
  const baseUrl = getBaseUrl(config);
  if (!apiKey || !baseUrl) return null;
  return createHash("sha256")
    .update(`${baseUrl}\n${apiKey}\n${config.namespace}\n${config.site_id}`)
    .digest("hex");
}

export interface OutboxRecoveryResult {
  fingerprintChanged: boolean;
  failedReset: number;
  authFailedReset: number;
  syncingReset: number;
  staleSyncingReset: number;
}

export function recoverOutboxAfterAuthChange(
  db: MemDatabase,
  config: Config
): OutboxRecoveryResult {
  const fingerprint = getAuthFingerprint(config);
  if (!fingerprint) {
    const staleSyncingReset = resetStaleSyncingEntries(db);
    return { fingerprintChanged: false, failedReset: 0, authFailedReset: 0, syncingReset: 0, staleSyncingReset };
  }

  const key = "sync_auth_fingerprint";
  const previous = db.getSyncState(key);
  const fingerprintChanged = previous !== fingerprint;
  if (!fingerprintChanged) {
    const authFailedReset = resetFailedEntriesMatching(
      db,
      (error) => classifyOutboxFailure(error) === "auth"
    );
    const staleSyncingReset = resetStaleSyncingEntries(db);
    return { fingerprintChanged: false, failedReset: 0, authFailedReset, syncingReset: 0, staleSyncingReset };
  }

  const failedReset = resetFailedEntries(db);
  const syncingReset = resetSyncingEntries(db);
  const staleSyncingReset = 0;
  db.setSyncState(key, fingerprint);
  return { fingerprintChanged: true, failedReset, authFailedReset: 0, syncingReset, staleSyncingReset };
}

export function recoverOutboxAfterSuccessfulAuth(
  db: MemDatabase,
  config: Config
): OutboxRecoveryResult {
  const fingerprint = getAuthFingerprint(config);
  const staleSyncingReset = resetStaleSyncingEntries(db);
  const authFailedReset = resetFailedEntriesMatching(
    db,
    (error) => classifyOutboxFailure(error) === "auth"
  );

  if (fingerprint) {
    db.setSyncState("sync_auth_fingerprint", fingerprint);
  }

  return {
    fingerprintChanged: false,
    failedReset: 0,
    authFailedReset,
    syncingReset: 0,
    staleSyncingReset,
  };
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
): { userId: string; deviceId: string; localId: number; type: string } | null {
  for (const type of ["obs", "summary", "chat"]) {
    const marker = `-${type}-`;
    const idx = sourceId.lastIndexOf(marker);
    if (idx === -1) continue;

    const prefix = sourceId.slice(0, idx);
    const localIdStr = sourceId.slice(idx + marker.length);
    const localId = parseInt(localIdStr, 10);
    if (isNaN(localId)) return null;

    const firstDash = prefix.indexOf("-");
    if (firstDash === -1) return null;

    return {
      userId: prefix.slice(0, firstDash),
      deviceId: prefix.slice(firstDash + 1),
      localId,
      type,
    };
  }

  return null;
}
