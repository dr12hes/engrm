import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface CaptureGitWorktreeInput {
  cwd?: string;
  staged?: boolean;
}

export interface CaptureGitWorktreeResult {
  cwd: string;
  diff: string;
  files: string[];
}

function runGitCommand(cwd: string, args: string[]): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd,
    encoding: "utf-8",
    timeout: 8000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function captureGitWorktree(input: CaptureGitWorktreeInput = {}): CaptureGitWorktreeResult {
  const cwd = resolve(input.cwd ?? process.cwd());
  if (!existsSync(cwd)) {
    throw new Error(`Path does not exist: ${cwd}`);
  }

  try {
    runGitCommand(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error(`Not a git repository: ${cwd}`);
  }

  const diffArgs = input.staged
    ? ["diff", "--cached", "--no-ext-diff", "--minimal"]
    : ["diff", "--no-ext-diff", "--minimal"];
  const fileArgs = input.staged
    ? ["diff", "--cached", "--name-only"]
    : ["diff", "--name-only"];

  const diff = runGitCommand(cwd, diffArgs);
  const files = runGitCommand(cwd, fileArgs)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    cwd,
    diff,
    files,
  };
}
