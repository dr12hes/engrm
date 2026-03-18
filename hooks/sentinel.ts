#!/usr/bin/env bun
/**
 * Sentinel PreToolUse hook for Claude Code.
 *
 * Intercepts Write/Edit tool calls and audits them via LLM.
 * Exit codes:
 *   0 = allow (PASS or WARN in advisory mode)
 *   2 = block (BLOCK in blocking mode)
 *
 * Verdicts are saved as security findings and observations.
 */

import { auditCodeChange, checkDailyLimit } from "../src/sentinel/audit.js";
import { parseStdinJson, bootstrapHook, runHook } from "../src/hooks/common.js";
import { saveObservation } from "../src/tools/save.js";
import { detectProject } from "../src/storage/projects.js";

interface PreToolUseEvent {
  session_id: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string;
}

async function main(): Promise<void> {
  const event = await parseStdinJson<PreToolUseEvent>();
  if (!event) process.exit(0);

  // Only audit Write and Edit tools
  if (event.tool_name !== "Write" && event.tool_name !== "Edit") {
    process.exit(0);
  }

  const boot = bootstrapHook("sentinel");
  if (!boot) process.exit(0);

  const { config, db } = boot;

  // Check if Sentinel is enabled
  if (!config.sentinel.enabled) {
    db.close();
    process.exit(0);
  }

  // Tier-based access control
  // Free = disabled, Vibe = advisory 50/day, Pro = advisory 200/day, Team/Enterprise = full blocking
  const tier = config.sentinel.tier;
  if (tier === "free") {
    db.close();
    process.exit(0);
  }

  // Enforce mode based on tier
  const effectiveMode = (tier === "vibe" || tier === "solo" || tier === "pro") ? "advisory" : config.sentinel.mode;
  const dailyLimit = tier === "vibe" || tier === "solo" ? 50 : tier === "pro" ? 200 : config.sentinel.daily_limit;

  // Check daily limit
  if (!checkDailyLimit(db, dailyLimit)) {
    db.close();
    console.error("⚠️  Sentinel daily audit limit reached. Allowing change.");
    process.exit(0);
  }

  try {
    const filePath = String(event.tool_input["file_path"] ?? "unknown");

    // Skip files matching skip patterns (default: migration files, test files, config)
    const defaultSkips = [/migrations?\./, /\.test\./, /\.spec\./, /\.lock$/, /package\.json$/];
    const customSkips = (config.sentinel.skip_patterns || []).map((p: string) => new RegExp(p));
    const allSkips = [...defaultSkips, ...customSkips];
    if (allSkips.some((re) => re.test(filePath))) {
      db.close();
      process.exit(0);
    }

    const content = event.tool_name === "Write"
      ? String(event.tool_input["content"] ?? "")
      : String(event.tool_input["new_string"] ?? "");

    const result = await auditCodeChange(config, db, event.tool_name, filePath, content);

    if (result.verdict === "PASS") {
      process.exit(0);
    }

    // Log the finding
    const detected = detectProject(event.cwd);
    const project = db.getProjectByCanonicalId(detected.canonical_id);

    if (project && (result.verdict === "WARN" || result.verdict === "BLOCK")) {
      // Save as security finding
      db.insertSecurityFinding({
        session_id: event.session_id,
        project_id: project.id,
        finding_type: `sentinel_${result.verdict.toLowerCase()}`,
        severity: result.severity ?? (result.verdict === "BLOCK" ? "high" : "medium"),
        pattern_name: result.rule ?? "sentinel_audit",
        file_path: filePath,
        snippet: result.reason,
        tool_name: event.tool_name,
        user_id: config.user_id,
        device_id: config.device_id,
      });
    }

    if (result.verdict === "DRIFT") {
      console.error(`🔀 Sentinel DRIFT: ${result.reason}`);
      if (result.rule) console.error(`   Decision: ${result.rule}`);
      console.error("   This change may contradict a previous agreement.");

      if (effectiveMode === "blocking") {
        process.exit(2);
      } else {
        console.error("   (Advisory mode — change allowed)");
        process.exit(0);
      }
    }

    if (result.verdict === "WARN") {
      console.error(`⚠️  Sentinel: ${result.reason}`);
      if (result.rule) console.error(`   Rule: ${result.rule}`);
      process.exit(0); // Advisory — allow in both modes
    }

    if (result.verdict === "BLOCK") {
      console.error(`🛑 Sentinel BLOCKED: ${result.reason}`);
      if (result.rule) console.error(`   Rule: ${result.rule}`);

      if (effectiveMode === "blocking") {
        // Exit 2 = block the tool call
        process.exit(2);
      } else {
        // Advisory mode — warn but don't block
        console.error("   (Advisory mode — change allowed)");
        process.exit(0);
      }
    }
  } finally {
    db.close();
  }

  process.exit(0);
}

runHook("sentinel", main);
