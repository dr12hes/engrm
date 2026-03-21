#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const allowedRootMarkdown = new Set([
  "README.md",
  "AGENT_SUPPORT.md",
  "ARCHITECTURE.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "ECOSYSTEM_LISTINGS.md",
  "MCP_EXAMPLES.md",
  "PLUGIN_SPEC.md",
  "ROADMAP.md",
  "SECURITY.md",
]);

const bannedNames = new Set([
  "CLAUDE.md",
  "PLAN.md",
  "SPEC.md",
  "SWOT.md",
  "MARKET.md",
  "COMPETITIVE.md",
  "BRIEF.md",
  "PUBLISHING.md",
  "SENTINEL.md",
  "AUTH-DESIGN.md",
  "SERVER-API-PLAN.md",
  "SYNC-ARCHITECTURE.md",
  "VIBE-CODER-STRATEGY.md",
  "ELICITATION-PLAN.md",
  "CONTEXT-OPTIMIZATION.md",
  "INFRASTRUCTURE.md",
]);

const bannedPatterns = [
  /\.plan\.md$/i,
  /\.strategy\.md$/i,
  /\.scratch\.md$/i,
];

const problems = [];

for (const entry of readdirSync(root)) {
  const fullPath = join(root, entry);
  const stat = statSync(fullPath);
  if (stat.isDirectory()) continue;

  if (bannedNames.has(entry) || bannedPatterns.some((pattern) => pattern.test(entry))) {
    problems.push(`Banned doc present: ${entry}`);
    continue;
  }

  if (entry.endsWith(".md") && !allowedRootMarkdown.has(entry)) {
    problems.push(`Unexpected root Markdown file: ${entry}`);
  }
}

if (problems.length > 0) {
  console.error("Public-doc guard failed:\n");
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  console.error("\nMove internal notes outside the repo or into an untracked folder.");
  process.exit(1);
}

console.log("Public-doc guard passed.");
