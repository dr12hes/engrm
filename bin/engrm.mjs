#!/usr/bin/env node
/**
 * Engrm CLI entry point for npm/npx.
 * Runs the pre-built dist/cli.js on Node.js — no Bun required.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import and run the built CLI
await import(join(__dirname, "..", "dist", "cli.js"));
