/**
 * Sentinel audit engine — thin client relay.
 *
 * Sends code changes to the server-side review endpoint (POST /v1/mem/check)
 * and returns the verdict. All LLM logic, prompts, and decision context
 * are handled server-side.
 */

import type { Config } from "../config.js";
import type { MemDatabase } from "../storage/sqlite.js";
import type { AuditResult } from "./types.js";

/**
 * Audit a code change by sending it to the server for review.
 */
export async function auditCodeChange(
  config: Config,
  _db: MemDatabase,
  toolName: string,
  filePath: string,
  content: string
): Promise<AuditResult> {
  // Check if file matches skip patterns (client-side for speed)
  if (shouldSkip(filePath, config.sentinel.skip_patterns)) {
    return { verdict: "PASS", reason: "File matches skip pattern" };
  }

  // Need a server URL and API key
  if (!config.candengo_url || !config.candengo_api_key) {
    return { verdict: "PASS", reason: "Server not configured" };
  }

  const url = `${config.candengo_url.replace(/\/$/, "")}/v1/mem/check`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.candengo_api_key}`,
      },
      body: JSON.stringify({
        tool_name: toolName,
        file_path: filePath,
        content: content.slice(0, 8000),
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return { verdict: "PASS", reason: "Review service unavailable" };
    }

    const data = (await response.json()) as {
      verdict: string;
      reason: string;
      rule?: string | null;
      severity?: string | null;
    };

    return parseServerResponse(data);
  } catch {
    // Network/timeout failure should never block development
    return { verdict: "PASS", reason: "Review service unreachable" };
  }
}

/**
 * Parse the server response into an AuditResult.
 */
function parseServerResponse(data: Record<string, unknown>): AuditResult {
  const verdict = data.verdict as string;
  if (
    verdict !== "PASS" &&
    verdict !== "WARN" &&
    verdict !== "BLOCK" &&
    verdict !== "DRIFT"
  ) {
    return { verdict: "PASS", reason: "Invalid verdict from server" };
  }

  return {
    verdict,
    reason: (data.reason as string) ?? "No reason given",
    rule: (data.rule as string) ?? undefined,
    severity: parseSeverity(data.severity as string),
  };
}

function parseSeverity(s: string | undefined): AuditResult["severity"] {
  if (s === "critical" || s === "high" || s === "medium" || s === "low")
    return s;
  return undefined;
}

/**
 * Check if a file path matches any skip patterns.
 */
function shouldSkip(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (filePath.includes(pattern)) return true;
    try {
      if (new RegExp(pattern).test(filePath)) return true;
    } catch {
      // Invalid regex — treat as literal match (already checked above)
    }
  }
  return false;
}

/**
 * Check and increment daily audit count.
 * Returns true if within limit, false if exceeded.
 */
export function checkDailyLimit(db: MemDatabase, limit: number): boolean {
  const today = new Date().toISOString().split("T")[0]!;
  const key = `sentinel_audit_count_${today}`;

  try {
    const current = db.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM sync_state WHERE key = ?"
      )
      .get(key);

    const count = current ? parseInt(current.value, 10) : 0;
    if (count >= limit) return false;

    // Increment
    db.db
      .query(
        `INSERT INTO sync_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = ?`
      )
      .run(key, String(count + 1), String(count + 1));

    return true;
  } catch {
    return true; // On error, allow the audit
  }
}
