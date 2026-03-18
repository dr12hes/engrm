import { describe, it, expect } from "bun:test";
import { formatToolEvent, OBSERVER_SYSTEM_PROMPT } from "./prompts.js";
import { parseObservationXml } from "./parser.js";
import type { ToolUseEvent } from "../capture/extractor.js";

function makeEvent(overrides: Partial<ToolUseEvent> = {}): ToolUseEvent {
  return {
    session_id: "test-session-001",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: {},
    tool_response: "",
    cwd: "/home/user/project",
    ...overrides,
  };
}

describe("formatToolEvent", () => {
  it("formats Edit events with file path and diff", () => {
    const event = makeEvent({
      tool_name: "Edit",
      tool_input: {
        file_path: "/src/auth.ts",
        old_string: "const token = null;",
        new_string: 'const token = getToken();',
      },
    });
    const xml = formatToolEvent(event);
    expect(xml).toContain("<tool>Edit</tool>");
    expect(xml).toContain("<file>/src/auth.ts</file>");
    expect(xml).toContain("<old_code>");
    expect(xml).toContain("<new_code>");
  });

  it("formats Write events with content preview", () => {
    const event = makeEvent({
      tool_name: "Write",
      tool_input: {
        file_path: "/src/new-file.ts",
        content: "export function hello() { return 'world'; }",
      },
    });
    const xml = formatToolEvent(event);
    expect(xml).toContain("<tool>Write</tool>");
    expect(xml).toContain("<file>/src/new-file.ts</file>");
    expect(xml).toContain("<content_preview>");
  });

  it("formats Read events with content preview", () => {
    const event = makeEvent({
      tool_name: "Read",
      tool_input: { file_path: "/src/config.ts" },
      tool_response: "export interface Config { url: string; }",
    });
    const xml = formatToolEvent(event);
    expect(xml).toContain("<tool>Read</tool>");
    expect(xml).toContain("<file>/src/config.ts</file>");
    expect(xml).toContain("<content_preview>");
  });

  it("formats Bash events with command and output", () => {
    const event = makeEvent({
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: "401 pass\n0 fail",
    });
    const xml = formatToolEvent(event);
    expect(xml).toContain("<tool>Bash</tool>");
    expect(xml).toContain("<command>bun test</command>");
    expect(xml).toContain("<output>401 pass");
  });

  it("formats MCP tools generically", () => {
    const event = makeEvent({
      tool_name: "mcp__github__create_pr",
      tool_input: { title: "Fix bug" },
      tool_response: "PR #42 created",
    });
    const xml = formatToolEvent(event);
    expect(xml).toContain("<tool>mcp__github__create_pr</tool>");
    expect(xml).toContain("<input>");
    expect(xml).toContain("<response>");
  });

  it("truncates long content", () => {
    const longContent = "x".repeat(2000);
    const event = makeEvent({
      tool_name: "Edit",
      tool_input: {
        file_path: "/src/big.ts",
        old_string: longContent,
        new_string: "short",
      },
    });
    const xml = formatToolEvent(event);
    expect(xml.length).toBeLessThan(2500);
    expect(xml).toContain("[truncated]");
  });
});

describe("observer system prompt", () => {
  it("includes all observation types", () => {
    expect(OBSERVER_SYSTEM_PROMPT).toContain("bugfix");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("discovery");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("decision");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("change");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("feature");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("refactor");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("pattern");
  });

  it("instructs observer to respond with XML", () => {
    expect(OBSERVER_SYSTEM_PROMPT).toContain("<observation>");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("<skip/>");
  });
});

describe("end-to-end: format → parse roundtrip", () => {
  it("observer prompt + XML response can be parsed", () => {
    // Simulate what the observer agent would return
    const observerResponse = `<observation>
  <type>discovery</type>
  <title>Config module uses SQLite for storage with FTS5 search</title>
  <narrative>Read through config.ts and found it initializes SQLite with FTS5 extensions for full-text search capability.</narrative>
  <facts>
    <fact>SQLite with FTS5 is used for local observation storage</fact>
    <fact>Config dir is ~/.engrm/ with settings.json and engrm.db</fact>
  </facts>
  <concepts>
    <concept>sqlite</concept>
    <concept>fts5</concept>
    <concept>configuration</concept>
  </concepts>
</observation>`;

    const parsed = parseObservationXml(observerResponse);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("discovery");
    expect(parsed!.title).toContain("Config module");
    expect(parsed!.facts).toHaveLength(2);
    expect(parsed!.concepts).toContain("sqlite");
  });

  it("observer skip response is handled", () => {
    const parsed = parseObservationXml("<skip/>");
    expect(parsed).toBeNull();
  });
});
