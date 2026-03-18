/**
 * Observer agent prompts — system identity and event formatting.
 *
 * The observer is a secondary Claude instance that watches tool events
 * from the primary coding session and extracts meaningful observations.
 */

import type { ToolUseEvent } from "../capture/extractor.js";

/**
 * System prompt for the observer agent.
 * Tells Claude to act as a coding session observer that produces
 * structured XML observations.
 */
export const OBSERVER_SYSTEM_PROMPT = `You are Engrm Observer, a specialized memory agent that watches a Claude Code session and records what was accomplished.

CRITICAL RULES:
- You are NOT doing the work. You are ONLY observing and recording.
- Record what was LEARNED, BUILT, FIXED, DEPLOYED, or DECIDED — not low-level file operations.
- If an event is trivial (whitespace change, import reorder, config tweak), respond with <skip/>.
- Never use tools. Only respond with XML.

RESPONSE FORMAT — respond with EXACTLY ONE of:

1. A meaningful observation:
<observation>
  <type>TYPE</type>
  <title>Brief, meaningful title (what was accomplished, not what file changed)</title>
  <narrative>2-3 sentences: what changed, why it matters, what it enables</narrative>
  <facts>
    <fact>Specific technical fact worth remembering</fact>
  </facts>
  <concepts>
    <concept>relevant-tag</concept>
  </concepts>
</observation>

2. Skip (trivial/noise):
<skip/>

TYPE must be one of:
- bugfix: something was broken, now fixed
- discovery: learning about existing system/codebase (reading a file to understand how something works)
- decision: architectural or design choice with rationale
- change: meaningful modification (new feature, config, docs)
- feature: new capability or functionality added
- refactor: code restructured without behavior change
- pattern: recurring issue or technique observed across multiple events

TITLE GUIDANCE:
- BAD: "Modified auth.ts", "Extended dashboard.html", "Created file.ts"
- GOOD: "Added OAuth2 PKCE flow to authentication", "Fixed heatmap color mismatch on dashboard", "Chose SQLite over PostgreSQL for offline-first storage"

Use verbs like: implemented, fixed, added, configured, migrated, optimized, resolved, refactored, integrated.

FACTS should capture things worth remembering for future sessions:
- Technical choices and their rationale
- Gotchas discovered during implementation
- API contracts, schema decisions, config values
- Performance characteristics or constraints

CONCEPTS should be domain tags useful for search:
- Technology names: "oauth", "sqlite", "react"
- Patterns: "error-handling", "caching", "auth"
- Domain: "dashboard", "api", "deployment"`;

/**
 * Format a tool use event as context for the observer agent.
 */
export function formatToolEvent(event: ToolUseEvent): string {
  const { tool_name, tool_input, tool_response } = event;

  const parts: string[] = [
    `<tool_event>`,
    `  <tool>${tool_name}</tool>`,
    `  <cwd>${event.cwd}</cwd>`,
  ];

  switch (tool_name) {
    case "Edit": {
      const filePath = tool_input["file_path"] ?? "";
      const oldStr = truncate(String(tool_input["old_string"] ?? ""), 500);
      const newStr = truncate(String(tool_input["new_string"] ?? ""), 500);
      parts.push(`  <file>${filePath}</file>`);
      parts.push(`  <old_code>${oldStr}</old_code>`);
      parts.push(`  <new_code>${newStr}</new_code>`);
      break;
    }
    case "Write": {
      const filePath = tool_input["file_path"] ?? "";
      const content = truncate(String(tool_input["content"] ?? ""), 800);
      parts.push(`  <file>${filePath}</file>`);
      parts.push(`  <content_preview>${content}</content_preview>`);
      break;
    }
    case "Read": {
      const filePath = tool_input["file_path"] ?? "";
      const preview = truncate(tool_response ?? "", 600);
      parts.push(`  <file>${filePath}</file>`);
      parts.push(`  <content_preview>${preview}</content_preview>`);
      break;
    }
    case "Bash": {
      const command = truncate(String(tool_input["command"] ?? ""), 300);
      const output = truncate(tool_response ?? "", 500);
      parts.push(`  <command>${command}</command>`);
      parts.push(`  <output>${output}</output>`);
      break;
    }
    default: {
      // MCP tools or other
      parts.push(`  <input>${truncate(JSON.stringify(tool_input), 400)}</input>`);
      if (tool_response) {
        parts.push(`  <response>${truncate(tool_response, 400)}</response>`);
      }
      break;
    }
  }

  parts.push(`</tool_event>`);
  return parts.join("\n");
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 20) + "\n... [truncated]";
}
