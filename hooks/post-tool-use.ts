#!/usr/bin/env bun
/**
 * PostToolUse hook for Claude Code.
 *
 * Receives tool use events on stdin, extracts observations,
 * saves them via the capture pipeline, tracks session metrics,
 * and scans for exposed secrets.
 *
 * This hook is non-blocking — PostToolUse cannot prevent the tool
 * from executing (it already did). We just observe and record.
 */

import { extractObservation, type ToolUseEvent } from "../src/capture/extractor.js";
import { parseStdinJson, bootstrapHook, runHook } from "../src/hooks/common.js";
import { saveObservation } from "../src/tools/save.js";
import { scanForSecrets } from "../src/capture/scanner.js";
import { detectProject } from "../src/storage/projects.js";
import { detectDependencyInstalls } from "../src/capture/dependency.js";
import { observeToolEvent, incrementObserverSaveCount } from "../src/observer/observe.js";
import { extractErrorSignature, recallPastFix } from "../src/capture/recall.js";
import { checkSessionFatigue } from "../src/capture/fatigue.js";

async function main(): Promise<void> {
  const event = await parseStdinJson<ToolUseEvent>();
  if (!event) process.exit(0);

  const boot = bootstrapHook("post-tool-use");
  if (!boot) process.exit(0);

  const { config, db } = boot;

  try {
    // --- Session + Metrics tracking ---
    if (event.session_id) {
      // Ensure session row exists (upsert on first tool use)
      const detected = detectProject(event.cwd);
      const project = db.getProjectByCanonicalId(detected.canonical_id);
      db.upsertSession(
        event.session_id,
        project?.id ?? null,
        config.user_id,
        config.device_id
      );

      const metricsIncrement: { files?: number; toolCalls?: number } = {
        toolCalls: 1,
      };

      // Count file touches from Edit/Write tools
      if (
        (event.tool_name === "Edit" || event.tool_name === "Write") &&
        event.tool_input["file_path"]
      ) {
        metricsIncrement.files = 1;
      }

      db.incrementSessionMetrics(event.session_id, metricsIncrement);

      db.insertToolEvent({
        session_id: event.session_id,
        project_id: project?.id ?? null,
        tool_name: event.tool_name,
        tool_input_json: safeSerializeToolInput(event.tool_input),
        tool_response_preview: truncatePreview(event.tool_response, 1200),
        file_path: extractFilePath(event.tool_input),
        command: extractCommand(event.tool_input),
        user_id: config.user_id,
        device_id: config.device_id,
        agent: "claude-code",
      });
    }

    // --- Security scanning ---
    const textToScan = extractScanText(event);
    if (textToScan) {
      const findings = scanForSecrets(textToScan, config.scrubbing.custom_patterns);
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
              tool_name: event.tool_name,
              user_id: config.user_id,
              device_id: config.device_id,
            });
          }
        }
      }
    }

    // --- Dependency monitoring ---
    if (event.tool_name === "Bash" && event.tool_input["command"]) {
      const command = String(event.tool_input["command"]);
      const installs = detectDependencyInstalls(command, event.tool_response ?? undefined);
      for (const install of installs) {
        await saveObservation(db, config, {
          type: "change",
          title: `Added ${install.packages.length === 1 ? install.packages[0] : install.packages.length + " packages"} via ${install.manager}`,
          narrative: `Dependency installed: ${install.command}`,
          concepts: [install.manager, "dependency", ...install.packages],
          session_id: event.session_id,
          cwd: event.cwd,
        });
      }
    }

    // --- Error recall: "You Solved This Before" ---
    if (event.tool_name === "Bash" && event.tool_response) {
      const sig = extractErrorSignature(event.tool_response);
      if (sig) {
        try {
          const detected = detectProject(event.cwd);
          const project = db.getProjectByCanonicalId(detected.canonical_id);
          const recall = await recallPastFix(db, sig, project?.id ?? null);

          // Track recall metrics in session state for beacon
          incrementRecallMetrics(event.session_id, recall.found);

          if (recall.found) {
            const projectLabel = recall.projectName ? ` (from ${recall.projectName})` : "";
            console.error(`\n💡 Engrm: You solved this before${projectLabel}: "${recall.title}"`);
            if (recall.narrative) {
              console.error(`   ${recall.narrative}`);
            }
          }
        } catch {
          // Recall is best-effort — never block the hook
        }
      }
    }

    // --- Session fatigue detection ---
    if (event.tool_name === "Bash" && event.tool_response && event.session_id) {
      if (extractErrorSignature(event.tool_response)) {
        try {
          const fatigue = checkSessionFatigue(db, event.session_id);
          if (fatigue.fatigued && fatigue.message) {
            console.error(`\n💡 Engrm: ${fatigue.message}`);
          }
        } catch {
          // Fatigue check is best-effort
        }
      }
    }

    // --- Observation extraction ---
    // Try AI observer first (Claude Agent SDK), fall back to heuristics
    let saved = false;

    if (config.observer?.enabled !== false) {
      try {
        const observed = await observeToolEvent(event, {
          model: config.observer.model,
        });
        if (observed) {
          await saveObservation(db, config, observed);
          incrementObserverSaveCount(event.session_id);
          saved = true;
        }
      } catch {
        // Observer failed — fall through to heuristic
      }
    }

    // Heuristic fallback when observer is unavailable or skipped the event
    if (!saved) {
      const extracted = extractObservation(event);
      if (extracted) {
        await saveObservation(db, config, {
          type: extracted.type,
          title: extracted.title,
          narrative: extracted.narrative,
          files_read: extracted.files_read,
          files_modified: extracted.files_modified,
          session_id: event.session_id,
          cwd: event.cwd,
        });
        incrementObserverSaveCount(event.session_id);
      }
    }
  } finally {
    db.close();
  }
}

function safeSerializeToolInput(toolInput: Record<string, unknown>): string | null {
  try {
    const raw = JSON.stringify(toolInput);
    return truncatePreview(raw, 2000);
  } catch {
    return null;
  }
}

function truncatePreview(value: string | null | undefined, maxLen: number): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1)}…`;
}

function extractFilePath(toolInput: Record<string, unknown>): string | null {
  const filePath = toolInput["file_path"];
  return typeof filePath === "string" && filePath.trim().length > 0
    ? filePath
    : null;
}

function extractCommand(toolInput: Record<string, unknown>): string | null {
  const command = toolInput["command"];
  return typeof command === "string" && command.trim().length > 0
    ? truncatePreview(command, 500)
    : null;
}

/**
 * Extract text to scan for secrets from a tool use event.
 * Only scans content that might contain secrets — tool inputs/outputs
 * from Edit, Write, and Bash tools.
 */
function extractScanText(event: ToolUseEvent): string | null {
  const { tool_name, tool_input, tool_response } = event;

  switch (tool_name) {
    case "Edit": {
      const parts: string[] = [];
      if (tool_input["old_string"]) parts.push(String(tool_input["old_string"]));
      if (tool_input["new_string"]) parts.push(String(tool_input["new_string"]));
      return parts.length > 0 ? parts.join("\n") : null;
    }
    case "Write": {
      const content = tool_input["content"];
      return content ? String(content) : null;
    }
    case "Bash": {
      const parts: string[] = [];
      if (tool_input["command"]) parts.push(String(tool_input["command"]));
      if (tool_response) parts.push(tool_response);
      return parts.length > 0 ? parts.join("\n") : null;
    }
    default:
      return null;
  }
}

/**
 * Increment recall attempt/hit counters in the observer-sessions state file.
 * The beacon builder reads these at session end.
 */
function incrementRecallMetrics(sessionId: string, hit: boolean): void {
  try {
    const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
    const { join } = require("node:path");
    const { homedir } = require("node:os");
    const dir = join(homedir(), ".engrm", "observer-sessions");
    const path = join(dir, `${sessionId}.json`);

    let state: Record<string, unknown> = {};
    if (existsSync(path)) {
      state = JSON.parse(readFileSync(path, "utf-8"));
    } else {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    state.recallAttempts = ((state.recallAttempts as number) || 0) + 1;
    if (hit) {
      state.recallHits = ((state.recallHits as number) || 0) + 1;
    }
    writeFileSync(path, JSON.stringify(state), "utf-8");
  } catch {
    // Best-effort — never block
  }
}

runHook("post-tool-use", main);
