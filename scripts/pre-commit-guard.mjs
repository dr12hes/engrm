#!/usr/bin/env node

import { execSync } from "node:child_process";

const bannedPatterns = [
  /^CLAUDE\.md$/i,
  /^.*\/CLAUDE\.md$/i,
  /^.*\.plan\.md$/i,
  /^.*\.strategy\.md$/i,
  /^.*\.scratch\.md$/i,
  /^COMPETITIVE\.md$/i,
  /^MARKET\.md$/i,
  /^SWOT\.md$/i,
];

const output = execSync("git diff --cached --name-only", {
  encoding: "utf-8",
  stdio: ["pipe", "pipe", "pipe"],
}).trim();

if (!output) process.exit(0);

const files = output.split("\n").filter(Boolean);
const blocked = files.filter((file) => bannedPatterns.some((pattern) => pattern.test(file)));

if (blocked.length > 0) {
  console.error("Commit blocked. Internal or scratch documents are staged:\n");
  for (const file of blocked) {
    console.error(`- ${file}`);
  }
  console.error("\nRemove them from the commit or keep them outside the public repo.");
  process.exit(1);
}

process.exit(0);
