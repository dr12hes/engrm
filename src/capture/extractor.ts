/**
 * Observation extractor for PostToolUse hooks.
 *
 * Analyses tool use events and decides:
 *   1. Is this worth capturing? (signal vs noise)
 *   2. What type of observation is it?
 *   3. What title/narrative/files to record?
 *
 * Design: conservative by default — better to miss some observations
 * than flood the database with noise.
 */

// --- Types ---

export interface ToolUseEvent {
  session_id: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string;
  cwd: string;
}

export interface ExtractedObservation {
  type: string;
  title: string;
  narrative: string;
  files_read?: string[];
  files_modified?: string[];
}

// --- Skip rules (noise filters) ---

/**
 * Tools that are never worth capturing on their own.
 */
const SKIP_TOOLS = new Set([
  "Glob",
  "Grep",
  "Read",
  "WebSearch",
  "WebFetch",
  "Agent",
]);

/**
 * Bash commands that are navigational noise.
 */
const SKIP_BASH_PATTERNS = [
  /^\s*(ls|pwd|cd|echo|cat|head|tail|wc|which|whoami|date|uname)\b/,
  /^\s*git\s+(status|log|branch|diff|show|remote)\b/,
  /^\s*(node|bun|npm|npx|yarn|pnpm)\s+--?version\b/,
  /^\s*export\s+/,
  /^\s*#/,
];

/**
 * Bash responses indicating trivial success with no learning value.
 */
const TRIVIAL_RESPONSE_PATTERNS = [
  /^$/,
  /^\s*$/,
  /^Already up to date\.$/,
];

// --- Extraction logic ---

/**
 * Determine if a tool use event is worth capturing and extract observation data.
 * Returns null if the event should be skipped.
 */
export function extractObservation(
  event: ToolUseEvent
): ExtractedObservation | null {
  const { tool_name, tool_input, tool_response } = event;

  // Skip tools that are pure reads/navigation
  if (SKIP_TOOLS.has(tool_name)) {
    return null;
  }

  switch (tool_name) {
    case "Edit":
      return extractFromEdit(tool_input, tool_response);
    case "Write":
      return extractFromWrite(tool_input, tool_response);
    case "Bash":
      return extractFromBash(tool_input, tool_response);
    default:
      // MCP tool calls (mcp__server__tool) — capture if non-trivial
      if (tool_name.startsWith("mcp__")) {
        return extractFromMcpTool(tool_name, tool_input, tool_response);
      }
      return null;
  }
}

// --- Per-tool extractors ---

function extractFromEdit(
  input: Record<string, unknown>,
  response: string
): ExtractedObservation | null {
  const filePath = input["file_path"] as string | undefined;
  if (!filePath) return null;

  const oldStr = input["old_string"] as string | undefined;
  const newStr = input["new_string"] as string | undefined;
  if (!oldStr && !newStr) return null;

  // Skip tiny cosmetic edits (whitespace, single-char changes)
  if (oldStr && newStr) {
    const oldTrimmed = oldStr.trim();
    const newTrimmed = newStr.trim();
    if (oldTrimmed === newTrimmed) return null;
    if (Math.abs(oldTrimmed.length - newTrimmed.length) < 3 && oldTrimmed.length < 20) {
      return null;
    }
  }

  const fileName = filePath.split("/").pop() ?? filePath;
  const changeSize = (newStr?.length ?? 0) - (oldStr?.length ?? 0);
  const verb = changeSize > 50 ? "Extended" : changeSize < -50 ? "Reduced" : "Modified";

  return {
    type: "change",
    title: `${verb} ${fileName}`,
    narrative: buildEditNarrative(oldStr, newStr, filePath),
    files_modified: [filePath],
  };
}

function extractFromWrite(
  input: Record<string, unknown>,
  response: string
): ExtractedObservation | null {
  const filePath = input["file_path"] as string | undefined;
  if (!filePath) return null;

  const content = input["content"] as string | undefined;
  const fileName = filePath.split("/").pop() ?? filePath;

  // Skip very small files (likely config or trivial)
  if (content === undefined || content.length < 50) return null;

  return {
    type: "change",
    title: `Created ${fileName}`,
    narrative: `New file created: ${filePath}`,
    files_modified: [filePath],
  };
}

function extractFromBash(
  input: Record<string, unknown>,
  response: string
): ExtractedObservation | null {
  const command = input["command"] as string | undefined;
  if (!command) return null;

  // Skip navigational commands
  for (const pattern of SKIP_BASH_PATTERNS) {
    if (pattern.test(command)) return null;
  }

  // Skip trivial responses
  for (const pattern of TRIVIAL_RESPONSE_PATTERNS) {
    if (pattern.test(response.trim())) return null;
  }

  // Detect error → potential bugfix context
  const hasError = detectError(response);

  // Detect test runs
  const isTestRun = detectTestRun(command);

  if (isTestRun) {
    return extractTestResult(command, response);
  }

  if (hasError) {
    return {
      type: "bugfix",
      title: summariseCommand(command) + " (error)",
      narrative: `Command: ${truncate(command, 200)}\nError: ${truncate(response, 500)}`,
    };
  }

  // Detect install/dependency changes
  if (/\b(npm|bun|yarn|pnpm)\s+(install|add|remove|uninstall)\b/.test(command)) {
    return {
      type: "change",
      title: `Dependency change: ${summariseCommand(command)}`,
      narrative: `Command: ${truncate(command, 200)}\nOutput: ${truncate(response, 300)}`,
    };
  }

  // Detect build commands
  if (/\b(npm|bun|yarn)\s+(run\s+)?(build|compile|bundle)\b/.test(command)) {
    if (hasError) {
      return {
        type: "bugfix",
        title: `Build failure: ${summariseCommand(command)}`,
        narrative: `Build command failed.\nCommand: ${truncate(command, 200)}\nOutput: ${truncate(response, 500)}`,
      };
    }
    // Successful builds are low signal
    return null;
  }

  // Generic non-trivial bash — only capture if response is substantial
  if (response.length > 200) {
    return {
      type: "change",
      title: summariseCommand(command),
      narrative: `Command: ${truncate(command, 200)}\nOutput: ${truncate(response, 300)}`,
    };
  }

  return null;
}

function extractFromMcpTool(
  toolName: string,
  input: Record<string, unknown>,
  response: string
): ExtractedObservation | null {
  // Skip our own engrm tools to avoid self-referential loops
  if (toolName.startsWith("mcp__engrm__")) return null;

  // Generic MCP tool capture — only if response is substantial
  if (response.length < 100) return null;

  const parts = toolName.split("__");
  const serverName = parts[1] ?? "unknown";
  const toolAction = parts[2] ?? "unknown";

  return {
    type: "change",
    title: `${serverName}: ${toolAction}`,
    narrative: `MCP tool ${toolName} called.\nResponse: ${truncate(response, 300)}`,
  };
}

// --- Helper functions ---

function detectError(response: string): boolean {
  const lower = response.toLowerCase();
  return (
    lower.includes("error:") ||
    lower.includes("error[") ||
    lower.includes("failed") ||
    lower.includes("exception") ||
    lower.includes("traceback") ||
    lower.includes("panic:") ||
    lower.includes("fatal:") ||
    /exit code [1-9]/.test(lower)
  );
}

function detectTestRun(command: string): boolean {
  return (
    /\b(test|spec|jest|vitest|mocha|pytest|cargo\s+test|go\s+test|bun\s+test)\b/i.test(command)
  );
}

function extractTestResult(
  command: string,
  response: string
): ExtractedObservation | null {
  // Match "N fail" where N > 0, or standalone failure keywords
  const hasFailure =
    /[1-9]\d*\s+(fail|failed|failures?)\b/i.test(response) ||
    /\bFAILED\b/.test(response) ||
    /\berror\b/i.test(response);
  const hasPass =
    /\d+\s+(pass|passed|ok)\b/i.test(response) ||
    /\bPASS\b/.test(response);

  if (hasFailure) {
    return {
      type: "bugfix",
      title: `Test failure: ${summariseCommand(command)}`,
      narrative: `Test run failed.\nCommand: ${truncate(command, 200)}\nOutput: ${truncate(response, 500)}`,
    };
  }

  if (hasPass && !hasFailure) {
    // All-pass test runs are low signal unless coming after a failure
    // For now, skip — Phase 2 enhancement: track error→fix sequences
    return null;
  }

  return null;
}

function buildEditNarrative(
  oldStr: string | undefined,
  newStr: string | undefined,
  filePath: string
): string {
  const parts = [`File: ${filePath}`];

  if (oldStr && newStr) {
    const oldLines = oldStr.split("\n").length;
    const newLines = newStr.split("\n").length;
    if (oldLines !== newLines) {
      parts.push(`Lines: ${oldLines} → ${newLines}`);
    }
    // Include a brief diff summary
    parts.push(`Replaced: ${truncate(oldStr, 100)}`);
    parts.push(`With: ${truncate(newStr, 100)}`);
  } else if (newStr) {
    parts.push(`Added: ${truncate(newStr, 150)}`);
  }

  return parts.join("\n");
}

function summariseCommand(command: string): string {
  // Take the first meaningful part of the command
  const trimmed = command.trim();
  const firstLine = trimmed.split("\n")[0] ?? trimmed;
  return truncate(firstLine, 80);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}
