import { describe, expect, test } from "bun:test";
import { extractObservation, type ToolUseEvent } from "./extractor.js";

function makeEvent(
  overrides: Partial<ToolUseEvent>
): ToolUseEvent {
  return {
    session_id: "sess-001",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: {},
    tool_response: "",
    cwd: "/tmp/project",
    ...overrides,
  };
}

describe("extractObservation — skip rules", () => {
  test("skips Read tool", () => {
    expect(
      extractObservation(makeEvent({ tool_name: "Read" }))
    ).toBeNull();
  });

  test("skips Glob tool", () => {
    expect(
      extractObservation(makeEvent({ tool_name: "Glob" }))
    ).toBeNull();
  });

  test("skips Grep tool", () => {
    expect(
      extractObservation(makeEvent({ tool_name: "Grep" }))
    ).toBeNull();
  });

  test("skips WebSearch tool", () => {
    expect(
      extractObservation(makeEvent({ tool_name: "WebSearch" }))
    ).toBeNull();
  });

  test("skips Agent tool", () => {
    expect(
      extractObservation(makeEvent({ tool_name: "Agent" }))
    ).toBeNull();
  });

  test("skips navigational bash commands", () => {
    const commands = ["ls", "pwd", "cd src", "echo hello", "git status", "git log", "node --version"];
    for (const cmd of commands) {
      expect(
        extractObservation(
          makeEvent({ tool_input: { command: cmd }, tool_response: "output" })
        )
      ).toBeNull();
    }
  });

  test("skips bash with empty response", () => {
    expect(
      extractObservation(
        makeEvent({ tool_input: { command: "some-cmd" }, tool_response: "" })
      )
    ).toBeNull();
  });

  test("skips engrm MCP tools (self-referential)", () => {
    expect(
      extractObservation(
        makeEvent({
          tool_name: "mcp__engrm__search",
          tool_response: "some result that is long enough to normally trigger capture",
        })
      )
    ).toBeNull();
  });
});

describe("extractObservation — Edit", () => {
  test("extracts from file edit", () => {
    const result = extractObservation(
      makeEvent({
        tool_name: "Edit",
        tool_input: {
          file_path: "/project/src/auth.ts",
          old_string: "const token = getToken();",
          new_string: "const token = await refreshToken();",
        },
        tool_response: "Successfully edited",
      })
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("change");
    expect(result!.title).toContain("auth.ts");
    expect(result!.files_modified).toEqual(["/project/src/auth.ts"]);
  });

  test("skips whitespace-only edit", () => {
    const result = extractObservation(
      makeEvent({
        tool_name: "Edit",
        tool_input: {
          file_path: "/project/src/app.ts",
          old_string: "const x = 1;",
          new_string: "const x = 1; ",
        },
        tool_response: "ok",
      })
    );
    expect(result).toBeNull();
  });

  test("skips edit with no file_path", () => {
    const result = extractObservation(
      makeEvent({
        tool_name: "Edit",
        tool_input: { old_string: "a", new_string: "b" },
        tool_response: "ok",
      })
    );
    expect(result).toBeNull();
  });
});

describe("extractObservation — Write", () => {
  test("extracts from file creation", () => {
    const result = extractObservation(
      makeEvent({
        tool_name: "Write",
        tool_input: {
          file_path: "/project/src/utils.ts",
          content: "export function helper() {\n  // substantial content here that is long enough\n  return true;\n}",
        },
        tool_response: "File written successfully",
      })
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("change");
    expect(result!.title).toContain("Created utils.ts");
    expect(result!.files_modified).toEqual(["/project/src/utils.ts"]);
  });

  test("skips tiny file writes", () => {
    const result = extractObservation(
      makeEvent({
        tool_name: "Write",
        tool_input: {
          file_path: "/project/.gitkeep",
          content: "",
        },
        tool_response: "ok",
      })
    );
    expect(result).toBeNull();
  });
});

describe("extractObservation — Bash errors", () => {
  test("captures error output as bugfix", () => {
    const result = extractObservation(
      makeEvent({
        tool_input: { command: "npm run build" },
        tool_response:
          "Error: Cannot find module './missing'\n    at Module._resolveFilename\nexit code 1",
      })
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("bugfix");
    expect(result!.title).toContain("error");
  });

  test("captures test failure", () => {
    const result = extractObservation(
      makeEvent({
        tool_input: { command: "bun test" },
        tool_response: "3 pass\n2 fail\n5 expect() calls",
      })
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("bugfix");
    expect(result!.title).toContain("Test failure");
  });

  test("skips passing tests", () => {
    const result = extractObservation(
      makeEvent({
        tool_input: { command: "bun test" },
        tool_response: "147 pass\n0 fail",
      })
    );
    expect(result).toBeNull();
  });
});

describe("extractObservation — Bash dependencies", () => {
  test("captures npm install", () => {
    const result = extractObservation(
      makeEvent({
        tool_input: { command: "npm install express" },
        tool_response: "added 57 packages in 3s",
      })
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("change");
    expect(result!.title).toContain("Dependency change");
  });

  test("captures bun add", () => {
    const result = extractObservation(
      makeEvent({
        tool_input: { command: "bun add zod" },
        tool_response: "installed zod@3.22.0",
      })
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("change");
  });
});

describe("extractObservation — MCP tools", () => {
  test("captures non-candengo MCP tool with substantial response", () => {
    const result = extractObservation(
      makeEvent({
        tool_name: "mcp__github__create_pull_request",
        tool_input: { title: "Fix auth" },
        tool_response: "a".repeat(150),
      })
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("change");
    expect(result!.title).toContain("github");
  });

  test("skips MCP tool with short response", () => {
    const result = extractObservation(
      makeEvent({
        tool_name: "mcp__github__get_issue",
        tool_input: {},
        tool_response: "ok",
      })
    );
    expect(result).toBeNull();
  });
});
