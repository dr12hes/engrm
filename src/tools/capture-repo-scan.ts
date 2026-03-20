import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { RepoScanFinding } from "../plugins/repo-scan.js";

export interface CaptureRepoScanInput {
  cwd?: string;
  focus?: string[];
  max_findings?: number;
}

export interface CaptureRepoScanResult {
  cwd: string;
  findings: RepoScanFinding[];
}

function runRg(cwd: string, args: string[]): string {
  return execSync(`rg ${args.join(" ")}`, {
    cwd,
    encoding: "utf-8",
    timeout: 8000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function safeRunRg(cwd: string, args: string[]): string {
  try {
    return runRg(cwd, args);
  } catch {
    return "";
  }
}

function quotePattern(pattern: string): string {
  return JSON.stringify(pattern);
}

function parseUniqueFiles(output: string): string[] {
  return Array.from(
    new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(":")[0] ?? line)
        .filter(Boolean)
    )
  );
}

function buildDefaultFindings(cwd: string): RepoScanFinding[] {
  const findings: RepoScanFinding[] = [];

  const todoOutput = safeRunRg(cwd, ["-n", "-S", "-m", "12", quotePattern("TODO|FIXME|HACK|XXX"), "."]);
  const todoFiles = parseUniqueFiles(todoOutput);
  if (todoFiles.length > 0) {
    findings.push({
      kind: "risk",
      title: `Outstanding TODO/FIXME markers found in ${todoFiles.length} files`,
      severity: todoFiles.length >= 5 ? "high" : "medium",
      file: todoFiles[0],
      detail: todoOutput.split("\n").slice(0, 3).join("\n"),
    });
  }

  const authOutput = safeRunRg(
    cwd,
    ["-l", "-S", quotePattern("auth|oauth|token|session|middleware"), "."]
  );
  const authFiles = parseUniqueFiles(authOutput).slice(0, 8);
  if (authFiles.length > 0) {
    findings.push({
      kind: "discovery",
      title: `Auth/session logic concentrated in ${authFiles.length} files`,
      file: authFiles[0],
      detail: authFiles.join(", "),
    });
  }

  const routeOutput = safeRunRg(
    cwd,
    ["-l", "-S", quotePattern("router|route|endpoint|express\\.Router|FastAPI|APIRouter"), "."]
  );
  const routeFiles = parseUniqueFiles(routeOutput).slice(0, 8);
  if (routeFiles.length > 0) {
    findings.push({
      kind: "pattern",
      title: `Routing/API structure appears in ${routeFiles.length} files`,
      file: routeFiles[0],
      detail: routeFiles.join(", "),
    });
  }

  const testOutput = safeRunRg(
    cwd,
    ["-l", "-S", quotePattern("\\.test\\.|\\.spec\\.|describe\\(|test\\("), "."]
  );
  const testFiles = parseUniqueFiles(testOutput).slice(0, 8);
  if (testFiles.length > 0) {
    findings.push({
      kind: "change",
      title: `Test-related files present across ${testFiles.length} files`,
      file: testFiles[0],
      detail: testFiles.join(", "),
    });
  }

  return findings;
}

function buildFocusFindings(cwd: string, focus: string[]): RepoScanFinding[] {
  const findings: RepoScanFinding[] = [];
  for (const topic of focus) {
    const cleaned = topic.trim();
    if (!cleaned) continue;
    const output = safeRunRg(cwd, ["-n", "-S", "-m", "12", quotePattern(cleaned), "."]);
    const files = parseUniqueFiles(output).slice(0, 8);
    if (files.length === 0) continue;
    findings.push({
      kind: "discovery",
      title: `Found ${cleaned} references in ${files.length} files`,
      file: files[0],
      detail: files.join(", "),
    });
  }
  return findings;
}

export function captureRepoScan(input: CaptureRepoScanInput = {}): CaptureRepoScanResult {
  const cwd = resolve(input.cwd ?? process.cwd());
  if (!existsSync(cwd)) {
    throw new Error(`Path does not exist: ${cwd}`);
  }

  const focus = (input.focus ?? []).map((item) => item.trim()).filter(Boolean);
  const findings = [
    ...buildDefaultFindings(cwd),
    ...buildFocusFindings(cwd, focus),
  ].slice(0, Math.max(1, Math.min(input.max_findings ?? 8, 20)));

  return {
    cwd,
    findings,
  };
}
