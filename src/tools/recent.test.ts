import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getRecentActivity } from "./recent.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-recent-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getRecentActivity", () => {
  test("returns project attribution for cross-project activity", () => {
    const alphaDir = join(tmpDir, "alpha");
    const betaDir = join(tmpDir, "beta");
    mkdirSync(alphaDir);
    mkdirSync(betaDir);

    const alpha = db.upsertProject({
      canonical_id: "local/alpha",
      name: "alpha",
      local_path: alphaDir,
    });
    const beta = db.upsertProject({
      canonical_id: "local/beta",
      name: "beta",
      local_path: betaDir,
    });

    db.insertObservation({
      project_id: alpha.id,
      type: "bugfix",
      title: "Alpha fix",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertObservation({
      project_id: beta.id,
      type: "decision",
      title: "Beta decision",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });

    const result = getRecentActivity(db, {
      project_scoped: false,
      limit: 10,
    });

    expect(result.observations).toHaveLength(2);
    expect(result.observations.map((obs) => obs.project_name)).toContain("alpha");
    expect(result.observations.map((obs) => obs.project_name)).toContain("beta");
  });

  test("scopes to the current project by default", () => {
    const projectDir = join(tmpDir, "workspace");
    mkdirSync(projectDir);

    const project = db.upsertProject({
      canonical_id: "local/workspace",
      name: "workspace",
      local_path: projectDir,
    });
    const other = db.upsertProject({
      canonical_id: "local/other",
      name: "other",
      local_path: join(tmpDir, "other"),
    });

    db.insertObservation({
      project_id: project.id,
      type: "bugfix",
      title: "Workspace fix",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertObservation({
      project_id: other.id,
      type: "bugfix",
      title: "Other fix",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });

    const result = getRecentActivity(db, {
      cwd: projectDir,
    });

    expect(result.project).toBe("workspace");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.title).toBe("Workspace fix");
  });
});
