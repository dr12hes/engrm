#!/usr/bin/env bun
/**
 * Codex Stop hook wrapper.
 *
 * Codex stop hooks require JSON on stdout. Our existing stop hook prints a
 * human-readable retrospective to stdout, so this wrapper runs it as a child
 * process, captures that output, and returns a valid Codex stop response.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const delegatePath = join(thisDir, "stop.ts");

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
  }
  return chunks.join("");
}

async function main(): Promise<void> {
  const input = await readStdin();
  const isBun = process.execPath.endsWith("bun");
  const childArgs = isBun ? ["run", delegatePath] : [delegatePath];

  const child = spawn(process.execPath, childArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (input.length > 0) {
    child.stdin.write(input);
  }
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  const messages = [stdout.trim(), stderr.trim()].filter(Boolean);
  const systemMessage = messages.length > 0 ? messages.join("\n") : null;

  if (exitCode === 0) {
    console.log(JSON.stringify({
      continue: true,
      ...(systemMessage ? { systemMessage } : {}),
    }));
    process.exit(0);
  }

  console.log(JSON.stringify({
    continue: true,
    ...(systemMessage ? { systemMessage: `Engrm stop hook failed:\n${systemMessage}` } : {}),
  }));
  process.exit(0);
}

main().catch((error) => {
  console.log(JSON.stringify({
    continue: true,
    systemMessage: `Engrm stop hook failed: ${error instanceof Error ? error.message : String(error)}`,
  }));
  process.exit(0);
});
