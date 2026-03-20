import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getProjectRelatedWork } from "./project-related-work.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-project-related-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getProjectRelatedWork", () => {
  test("finds work relevant to current repo but stored under another project", () => {
    const fallbackRepo = mkdtempSync(join(tmpdir(), "engrm-related-fallback-"));
    const targetRepo = mkdtempSync(join(tmpdir(), "engrm-related-target-"));

    execSync("git init", { cwd: fallbackRepo, stdio: "pipe" });
    execSync("git remote add origin https://github.com/dr12hes/alchemy.git", {
      cwd: fallbackRepo,
      stdio: "pipe",
    });
    execSync("git init", { cwd: targetRepo, stdio: "pipe" });
    execSync("git remote add origin https://github.com/dr12hes/huginn.git", {
      cwd: targetRepo,
      stdio: "pipe",
    });
    mkdirSync(join(targetRepo, "AIServer", "admin"), { recursive: true });

    const alchemy = db.upsertProject({
      canonical_id: "github.com/dr12hes/alchemy",
      name: "alchemy",
      local_path: fallbackRepo,
    });

    db.insertObservation({
      project_id: alchemy.id,
      type: "feature",
      title: "Implemented Huginn topology improvements",
      narrative: "Worked on Huginn admin topology rendering.",
      files_modified: JSON.stringify(["AIServer/admin/src/pages/site/TopologyCanvas.tsx"]),
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });

    const result = getProjectRelatedWork(db, {
      cwd: targetRepo,
      user_id: "david",
    });

    expect(result.project).toBe("huginn");
    expect(result.related).toHaveLength(1);
    expect(result.related[0]?.source_project).toBe("alchemy");
    expect(result.related[0]?.matched_on).toContain(":");

    rmSync(fallbackRepo, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  });
});
