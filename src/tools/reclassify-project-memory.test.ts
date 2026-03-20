import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { reclassifyProjectMemory } from "./reclassify-project-memory.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-reclassify-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("reclassifyProjectMemory", () => {
  test("moves related observations into the current project", () => {
    const fallbackRepo = mkdtempSync(join(tmpdir(), "engrm-reclassify-fallback-"));
    const targetRepo = mkdtempSync(join(tmpdir(), "engrm-reclassify-target-"));

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

    const obs = db.insertObservation({
      project_id: alchemy.id,
      type: "feature",
      title: "Implemented Huginn topology improvements",
      narrative: "Worked on Huginn admin topology rendering.",
      files_modified: JSON.stringify(["AIServer/admin/src/pages/site/TopologyCanvas.tsx"]),
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });

    const result = reclassifyProjectMemory(db, {
      cwd: targetRepo,
      user_id: "david",
    });

    expect(result.project).toBe("huginn");
    expect(result.moved).toBe(1);
    const movedObs = db.getObservationById(obs.id);
    const targetProject = db.getProjectByCanonicalId("github.com/dr12hes/huginn");
    expect(movedObs?.project_id).toBe(targetProject?.id);

    rmSync(fallbackRepo, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  });

  test("supports dry run", () => {
    const fallbackRepo = mkdtempSync(join(tmpdir(), "engrm-reclassify-fallback-"));
    const targetRepo = mkdtempSync(join(tmpdir(), "engrm-reclassify-target-"));

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

    const alchemy = db.upsertProject({
      canonical_id: "github.com/dr12hes/alchemy",
      name: "alchemy",
      local_path: fallbackRepo,
    });

    const obs = db.insertObservation({
      project_id: alchemy.id,
      type: "feature",
      title: "Implemented Huginn topology improvements",
      narrative: "Worked on Huginn admin topology rendering.",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });

    const result = reclassifyProjectMemory(db, {
      cwd: targetRepo,
      user_id: "david",
      dry_run: true,
    });

    expect(result.moved).toBe(0);
    expect(db.getObservationById(obs.id)?.project_id).toBe(alchemy.id);

    rmSync(fallbackRepo, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  });
});
