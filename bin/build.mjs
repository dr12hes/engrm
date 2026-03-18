#!/usr/bin/env bun
/**
 * Build script — compiles TypeScript to Node.js-compatible JavaScript.
 *
 * Uses Bun's bundler to produce self-contained .js files that run on Node.js.
 * Output goes to dist/ and is what gets published to npm.
 */

import { rmSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");

// Clean
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
mkdirSync(join(dist, "hooks"), { recursive: true });

console.log("Building Engrm for Node.js...\n");

// Build CLI + MCP server
const mainResult = await Bun.build({
  entrypoints: [
    join(root, "src/cli.ts"),
    join(root, "src/server.ts"),
  ],
  outdir: dist,
  target: "node",
  format: "esm",
  external: [
    "better-sqlite3",
    "sqlite-vec",
    "@xenova/transformers",
    "@modelcontextprotocol/sdk",
    "@anthropic-ai/claude-agent-sdk",
  ],
});

if (!mainResult.success) {
  console.error("Build failed (main):");
  for (const msg of mainResult.logs) console.error(msg);
  process.exit(1);
}
console.log("  dist/cli.js");
console.log("  dist/server.js");

// Build hooks
const hookResult = await Bun.build({
  entrypoints: [
    join(root, "hooks/session-start.ts"),
    join(root, "hooks/pre-compact.ts"),
    join(root, "hooks/post-tool-use.ts"),
    join(root, "hooks/stop.ts"),
    join(root, "hooks/codex-stop.ts"),
    join(root, "hooks/sentinel.ts"),
    join(root, "hooks/elicitation-result.ts"),
  ],
  outdir: join(dist, "hooks"),
  target: "node",
  format: "esm",
  external: [
    "better-sqlite3",
    "sqlite-vec",
    "@xenova/transformers",
    "@modelcontextprotocol/sdk",
    "@anthropic-ai/claude-agent-sdk",
  ],
});

if (!hookResult.success) {
  console.error("Build failed (hooks):");
  for (const msg of hookResult.logs) console.error(msg);
  process.exit(1);
}
console.log("  dist/hooks/session-start.js");
console.log("  dist/hooks/pre-compact.js");
console.log("  dist/hooks/post-tool-use.js");
console.log("  dist/hooks/stop.js");
console.log("  dist/hooks/codex-stop.js");
console.log("  dist/hooks/sentinel.js");
console.log("  dist/hooks/elicitation-result.js");

// Add Node.js shebang to CLI and hooks (strip any existing shebangs first)
async function addShebang(filePath) {
  const raw = await Bun.file(filePath).text();
  const stripped = raw.replace(/^#!.*\n/gm, "");
  writeFileSync(filePath, `#!/usr/bin/env node\n${stripped}`);
}

await addShebang(join(dist, "cli.js"));
await addShebang(join(dist, "server.js"));
for (const hook of ["session-start", "pre-compact", "post-tool-use", "stop", "codex-stop", "sentinel", "elicitation-result"]) {
  await addShebang(join(dist, "hooks", `${hook}.js`));
}

console.log("\nBuild complete.");
