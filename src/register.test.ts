import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { buildCodexHooksConfig, upsertCodexMcpServerConfig } from "./register.js";

// We test the internal logic by importing helpers and mocking the file paths.
// Since register.ts uses hardcoded paths (~/.claude.json, ~/.claude/settings.json),
// we test the JSON merge logic directly.

describe("register: JSON merge logic", () => {
  let tmpDir: string;
  let claudeJson: string;
  let claudeSettings: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `engrm-register-test-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    claudeJson = join(tmpDir, ".claude.json");
    claudeSettings = join(tmpDir, ".claude", "settings.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates claude.json from scratch with MCP server", () => {
    // Simulate what registerMcpServer does
    const config: Record<string, unknown> = {};
    const servers: Record<string, unknown> = {};
    servers["engrm"] = {
      type: "stdio",
      command: "/usr/local/bin/bun",
      args: ["run", "/path/to/server.ts"],
    };
    config["mcpServers"] = servers;

    writeFileSync(claudeJson, JSON.stringify(config, null, 2));
    const result = JSON.parse(readFileSync(claudeJson, "utf-8"));

    expect(result.mcpServers.engrm).toBeDefined();
    expect(result.mcpServers.engrm.command).toBe("/usr/local/bin/bun");
    expect(result.mcpServers.engrm.type).toBe("stdio");
  });

  it("preserves existing MCP servers when adding engrm", () => {
    const existing = {
      numStartups: 5,
      mcpServers: {
        "other-server": {
          type: "stdio",
          command: "node",
          args: ["other.js"],
        },
      },
    };
    writeFileSync(claudeJson, JSON.stringify(existing));

    // Read, merge, write
    const config = JSON.parse(readFileSync(claudeJson, "utf-8"));
    const servers = config.mcpServers ?? {};
    servers["engrm"] = { type: "stdio", command: "bun", args: ["run", "server.ts"] };
    config.mcpServers = servers;
    writeFileSync(claudeJson, JSON.stringify(config, null, 2));

    const result = JSON.parse(readFileSync(claudeJson, "utf-8"));
    expect(result.numStartups).toBe(5);
    expect(result.mcpServers["other-server"]).toBeDefined();
    expect(result.mcpServers.engrm).toBeDefined();
  });

  it("replaces existing engrm MCP config with new paths", () => {
    const existing = {
      mcpServers: {
        engrm: { type: "stdio", command: "bun", args: ["run", "/old/path/server.ts"] },
      },
    };
    writeFileSync(claudeJson, JSON.stringify(existing));

    const config = JSON.parse(readFileSync(claudeJson, "utf-8"));
    config.mcpServers.engrm = { type: "stdio", command: "bun", args: ["run", "/new/path/server.ts"] };
    writeFileSync(claudeJson, JSON.stringify(config, null, 2));

    const result = JSON.parse(readFileSync(claudeJson, "utf-8"));
    expect(result.mcpServers.engrm.args[1]).toBe("/new/path/server.ts");
  });

  it("creates hooks config from scratch", () => {
    const settings: Record<string, unknown> = {};
    settings["hooks"] = {
      SessionStart: [
        { hooks: [{ type: "command", command: "bun run /path/hooks/session-start.ts" }] },
      ],
      PostToolUse: [
        {
          matcher: "Edit|Write|Bash",
          hooks: [{ type: "command", command: "bun run /path/hooks/post-tool-use.ts" }],
        },
      ],
      Stop: [
        { hooks: [{ type: "command", command: "bun run /path/hooks/stop.ts" }] },
      ],
    };
    writeFileSync(claudeSettings, JSON.stringify(settings, null, 2));

    const result = JSON.parse(readFileSync(claudeSettings, "utf-8"));
    expect(result.hooks.SessionStart).toHaveLength(1);
    expect(result.hooks.PostToolUse).toHaveLength(1);
    expect(result.hooks.Stop).toHaveLength(1);
  });

  it("preserves non-engrm hooks when adding engrm hooks", () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "/path/to/other-hook.sh" }],
          },
        ],
      },
    };
    writeFileSync(claudeSettings, JSON.stringify(existing));

    const settings = JSON.parse(readFileSync(claudeSettings, "utf-8"));
    const hooks = settings.hooks ?? {};

    // Add engrm hooks — keep others
    const postToolUse = hooks.PostToolUse ?? [];
    const otherHooks = postToolUse.filter(
      (e: { hooks: { command: string }[] }) =>
        !e.hooks?.some((h: { command: string }) => h.command.includes("engrm"))
    );
    hooks.PostToolUse = [
      ...otherHooks,
      {
        matcher: "Edit|Write|Bash",
        hooks: [{ type: "command", command: "bun run /path/engrm/hooks/post-tool-use.ts" }],
      },
    ];
    settings.hooks = hooks;
    writeFileSync(claudeSettings, JSON.stringify(settings, null, 2));

    const result = JSON.parse(readFileSync(claudeSettings, "utf-8"));
    expect(result.hooks.PostToolUse).toHaveLength(2);
    expect(result.hooks.PostToolUse[0].hooks[0].command).toBe("/path/to/other-hook.sh");
    expect(result.hooks.PostToolUse[1].hooks[0].command).toContain("engrm");
  });

  it("preserves other settings fields", () => {
    const existing = {
      skipDangerousModePermissionPrompt: true,
      attribution: { commit: "", pr: "" },
    };
    writeFileSync(claudeSettings, JSON.stringify(existing));

    const settings = JSON.parse(readFileSync(claudeSettings, "utf-8"));
    settings.hooks = { Stop: [{ hooks: [{ type: "command", command: "test" }] }] };
    writeFileSync(claudeSettings, JSON.stringify(settings, null, 2));

    const result = JSON.parse(readFileSync(claudeSettings, "utf-8"));
    expect(result.skipDangerousModePermissionPrompt).toBe(true);
    expect(result.attribution).toBeDefined();
    expect(result.hooks.Stop).toHaveLength(1);
  });
});

describe("register: Codex TOML merge logic", () => {
  it("creates Codex MCP config from scratch", () => {
    const result = upsertCodexMcpServerConfig("", {
      name: "engrm",
      command: "/usr/local/bin/bun",
      args: ["run", "/path/to/server.ts"],
    });

    expect(result).toContain("[mcp_servers.engrm]");
    expect(result).toContain('command = "/usr/local/bin/bun"');
    expect(result).toContain('args = ["run", "/path/to/server.ts"]');
    expect(result).toContain("[features]");
    expect(result).toContain("codex_hooks = true");
  });

  it("preserves unrelated Codex MCP servers", () => {
    const existing = `[mcp_servers.other]
enabled = true
command = "node"
args = ["other.js"]
`;

    const result = upsertCodexMcpServerConfig(existing, {
      name: "engrm",
      command: "/usr/local/bin/bun",
      args: ["run", "/path/to/server.ts"],
    });

    expect(result).toContain("[mcp_servers.other]");
    expect(result).toContain('[mcp_servers.engrm]');
    expect(result.match(/\[mcp_servers\./g)?.length).toBe(2);
  });

  it("replaces existing engrm Codex MCP config", () => {
    const existing = `[mcp_servers.engrm]
enabled = true
command = "bun"
args = ["run", "/old/path/server.ts"]
`;

    const result = upsertCodexMcpServerConfig(existing, {
      name: "engrm",
      command: "/usr/local/bin/bun",
      args: ["run", "/new/path/server.ts"],
    });

    expect(result).not.toContain('/old/path/server.ts');
    expect(result).toContain('/new/path/server.ts');
    expect(result.match(/\[mcp_servers\.engrm\]/g)?.length).toBe(1);
  });

  it("migrates legacy Codex MCP config to engrm", () => {
    const existing = `[mcp_servers.${`candengo-${"mem"}`}]
enabled = true
command = "/Users/david/.bun/bin/bun"
args = ["run", "/Volumes/Data/devs/engrm/src/server.ts"]
`;

    const result = upsertCodexMcpServerConfig(existing, {
      name: "engrm",
      command: "/usr/local/bin/bun",
      args: ["run", "/path/to/server.ts"],
    });

    expect(result).not.toContain(`[mcp_servers.${`candengo-${"mem"}`}]`);
    expect(result).toContain("[mcp_servers.engrm]");
    expect(result).toContain('/path/to/server.ts');
  });

  it("adds codex_hooks to existing features section without duplicating it", () => {
    const existing = `[features]
some_feature = true
`;

    const result = upsertCodexMcpServerConfig(existing, {
      name: "engrm",
      command: "/usr/local/bin/bun",
      args: ["run", "/path/to/server.ts"],
    });

    expect(result.match(/\[features\]/g)?.length).toBe(1);
    expect(result).toContain("some_feature = true");
    expect(result).toContain("codex_hooks = true");
  });
});

describe("register: Codex hooks.json generation", () => {
  it("creates SessionStart and Stop command hooks", () => {
    const result = buildCodexHooksConfig(
      "bun run /path/to/session-start.ts",
      "bun run /path/to/codex-stop.ts"
    );

    expect(result).toContain("\"SessionStart\"");
    expect(result).toContain("\"Stop\"");
    expect(result).toContain("loading Engrm context");
    expect(result).toContain("saving Engrm session summary");
    expect(result).toContain("/path/to/session-start.ts");
    expect(result).toContain("/path/to/codex-stop.ts");
  });
});
