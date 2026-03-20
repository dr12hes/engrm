import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRepoScan } from "./capture-repo-scan.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-capture-repo-scan-test-"));
  mkdirSync(join(tmpDir, "src"), { recursive: true });
  writeFileSync(
    join(tmpDir, "src", "auth.ts"),
    "export function authMiddleware(token: string) { return token; }\n// TODO tighten auth validation\n"
  );
  writeFileSync(
    join(tmpDir, "src", "routes.ts"),
    "export const router = { endpoint: '/health' };\n"
  );
  writeFileSync(
    join(tmpDir, "src", "auth.test.ts"),
    "describe('auth', () => { test('works', () => {}) })\n"
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("captureRepoScan", () => {
  test("finds default repo scan signals", () => {
    const result = captureRepoScan({ cwd: tmpDir });

    expect(result.findings.some((finding) => finding.kind === "risk")).toBe(true);
    expect(result.findings.some((finding) => finding.title.includes("Auth/session logic"))).toBe(true);
    expect(result.findings.some((finding) => finding.title.includes("Routing/API structure"))).toBe(true);
    expect(result.findings.some((finding) => finding.title.includes("Test-related files"))).toBe(true);
  });

  test("adds focused discovery findings", () => {
    const result = captureRepoScan({ cwd: tmpDir, focus: ["validation"] });
    expect(result.findings.some((finding) => finding.title.includes("Found validation references"))).toBe(false);

    writeFileSync(join(tmpDir, "src", "validation.ts"), "export const validation = true;\n");
    const rescanned = captureRepoScan({ cwd: tmpDir, focus: ["validation"] });
    expect(rescanned.findings.some((finding) => finding.title.includes("Found validation references"))).toBe(true);
  });
});
