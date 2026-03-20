import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGitWorktree } from "./capture-git-worktree.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-capture-git-worktree-test-"));
  execSync("git init", { cwd: tmpDir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: "ignore" });
  execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: "ignore" });
  writeFileSync(join(tmpDir, "app.ts"), "export const value = 1;\n");
  execSync("git add app.ts", { cwd: tmpDir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: tmpDir, stdio: "ignore" });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("captureGitWorktree", () => {
  test("reads unstaged worktree diffs and changed files", () => {
    writeFileSync(join(tmpDir, "app.ts"), "export const value = 2;\n");

    const result = captureGitWorktree({ cwd: tmpDir });

    expect(result.files).toEqual(["app.ts"]);
    expect(result.diff).toContain("diff --git a/app.ts b/app.ts");
    expect(result.diff).toContain("+export const value = 2;");
  });

  test("throws for non-git directories", () => {
    const plainDir = mkdtempSync(join(tmpdir(), "engrm-non-git-"));
    try {
      expect(() => captureGitWorktree({ cwd: plainDir })).toThrow("Not a git repository");
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});
