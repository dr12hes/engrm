#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pluginDir = join(root, "openclaw", "plugin", "engrm-openclaw");

function read(path) {
  return readFileSync(path, "utf8");
}

function expect(condition, message, problems) {
  if (!condition) problems.push(message);
}

const problems = [];

const pkg = JSON.parse(read(join(pluginDir, "package.json")));
const manifest = JSON.parse(read(join(pluginDir, "openclaw.plugin.json")));
const indexJs = read(join(pluginDir, "index.js"));
const pluginReadme = read(join(pluginDir, "README.md"));
const installScript = read(join(root, "openclaw", "plugin", "install-or-update-openclaw-plugin.sh"));
const submissionDoc = read(join(root, "openclaw", "plugin", "OPENCLAW_COMMUNITY_PLUGIN_SUBMISSION.md"));

expect(
  pkg.name === "engrm-openclaw-plugin",
  `Expected plugin package name engrm-openclaw-plugin, got ${pkg.name}`,
  problems
);

expect(
  manifest.id === "engrm",
  `Expected OpenClaw manifest id engrm, got ${manifest.id}`,
  problems
);

expect(
  indexJs.includes('id: "engrm"'),
  'Expected runtime plugin export id to remain "engrm"',
  problems
);

expect(
  installScript.includes('PLUGIN_ID="engrm"'),
  'Expected install/update script to use stable plugin id "engrm"',
  problems
);

expect(
  installScript.includes('PACKAGE_NAME="engrm-openclaw-plugin"'),
  'Expected install/update script to use package name "engrm-openclaw-plugin"',
  problems
);

expect(
  pluginReadme.includes("openclaw plugins install engrm-openclaw-plugin"),
  "Expected plugin README to document install with engrm-openclaw-plugin",
  problems
);

expect(
  pluginReadme.includes("openclaw plugins update engrm"),
  'Expected plugin README to document update with stable id "engrm"',
  problems
);

expect(
  submissionDoc.includes("openclaw plugins install engrm-openclaw-plugin"),
  "Expected submission doc to document package install via engrm-openclaw-plugin",
  problems
);

expect(
  submissionDoc.includes("openclaw plugins update engrm"),
  'Expected submission doc to document update via stable id "engrm"',
  problems
);

if (problems.length > 0) {
  console.error("OpenClaw plugin contract check failed:\n");
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}

console.log("OpenClaw plugin contract check passed.");
