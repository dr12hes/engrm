#!/usr/bin/env bun
/**
 * ElicitationResult hook for Claude Code.
 *
 * Fires after a user responds to an MCP elicitation dialog, but before
 * the response is sent back to the MCP server. We observe the interaction
 * and capture it as a potential observation (with secret scrubbing).
 *
 * This hook is non-blocking — we never modify or block elicitation responses.
 * We just observe and record the interaction as project context.
 */

import { saveObservation } from "../src/tools/save.js";
import { parseStdinJson, bootstrapHook, runHook } from "../src/hooks/common.js";
import { scanForSecrets } from "../src/capture/scanner.js";
import { detectProject } from "../src/storage/projects.js";

interface ElicitationResultEvent {
  session_id: string;
  hook_event_name: string;
  mcp_server_name: string;
  action: "accept" | "decline" | "cancel";
  content: Record<string, unknown> | null;
  mode: "form" | "url";
  elicitation_id: string;
  cwd: string;
}

/**
 * Fields that should never be captured as observation content.
 * Matched case-insensitively against form field names.
 */
const SENSITIVE_FIELD_PATTERNS = [
  /passw/i,
  /secret/i,
  /token/i,
  /api.?key/i,
  /credential/i,
  /auth/i,
  /private/i,
  /ssh/i,
  /bearer/i,
];

async function main(): Promise<void> {
  const event = await parseStdinJson<ElicitationResultEvent>();
  if (!event) process.exit(0);

  // Only capture accepted form submissions — declined/cancelled have no content
  if (event.action !== "accept" || !event.content) process.exit(0);

  // Skip our own MCP server's elicitations to avoid recursive capture
  if (event.mcp_server_name === "engrm") process.exit(0);

  const boot = bootstrapHook("elicitation");
  if (!boot) process.exit(0);

  const { config, db } = boot;

  try {
    // --- Security scanning on form content ---
    const contentStr = JSON.stringify(event.content);
    const findings = scanForSecrets(contentStr, config.scrubbing.custom_patterns);
    if (findings.length > 0) {
      const detected = detectProject(event.cwd);
      const project = db.getProjectByCanonicalId(detected.canonical_id);
      if (project) {
        for (const finding of findings) {
          db.insertSecurityFinding({
            session_id: event.session_id,
            project_id: project.id,
            finding_type: finding.finding_type,
            severity: finding.severity,
            pattern_name: finding.pattern_name,
            snippet: finding.snippet,
            tool_name: `elicitation:${event.mcp_server_name}`,
            user_id: config.user_id,
            device_id: config.device_id,
          });
        }
      }
    }

    // --- Observation extraction ---
    // Scrub sensitive fields before building observation narrative
    const safeFields = scrubSensitiveFields(event.content);
    const fieldCount = Object.keys(event.content).length;
    const safeFieldCount = Object.keys(safeFields).length;
    const redactedCount = fieldCount - safeFieldCount;

    // Only create observation if there are non-sensitive fields to capture
    if (safeFieldCount === 0) process.exit(0);

    const fieldSummary = Object.entries(safeFields)
      .map(([k, v]) => `${k}: ${summarizeValue(v)}`)
      .join(", ");

    const title = `User provided input to ${event.mcp_server_name} MCP server`;
    const narrativeParts = [
      `Elicitation response to ${event.mcp_server_name}: ${fieldSummary}`,
    ];
    if (redactedCount > 0) {
      narrativeParts.push(`(${redactedCount} sensitive field(s) redacted)`);
    }

    await saveObservation(db, config, {
      type: "discovery",
      title,
      narrative: narrativeParts.join(". "),
      concepts: [event.mcp_server_name, "elicitation", "mcp"],
      session_id: event.session_id,
      cwd: event.cwd,
    });

    // --- Metrics ---
    if (event.session_id) {
      db.incrementSessionMetrics(event.session_id, { toolCalls: 1 });
    }
  } finally {
    db.close();
  }
}

/**
 * Remove fields whose names match sensitive patterns.
 */
function scrubSensitiveFields(
  content: Record<string, unknown>
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    const isSensitive = SENSITIVE_FIELD_PATTERNS.some((p) => p.test(key));
    if (!isSensitive) {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Summarize a value for the narrative — truncate long strings, stringify others.
 */
function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
  if (typeof value === "string") {
    return value.length > 80 ? value.slice(0, 77) + "..." : value;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value).slice(0, 80);
}

runHook("elicitation", main);
