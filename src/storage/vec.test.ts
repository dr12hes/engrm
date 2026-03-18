import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "./sqlite.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-vec-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// All tests conditional on sqlite-vec being available
describe("sqlite-vec integration", () => {
  test("vecAvailable is true when extension loads", () => {
    expect(db.vecAvailable).toBe(true);
  });

  test("vec_observations table exists", () => {
    if (!db.vecAvailable) return;
    const tables = db.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_observations'"
      )
      .all();
    expect(tables.length).toBe(1);
  });

  test("vecInsert and searchVec round-trip", () => {
    if (!db.vecAvailable) return;

    // Create a project + observation
    const project = db.upsertProject({
      canonical_id: "test/project",
      name: "test",
    });

    const obs = db.insertObservation({
      project_id: project.id,
      type: "bugfix",
      title: "Fix auth bug",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });

    // Insert embedding
    const vec = new Float32Array(384);
    vec[0] = 1.0;
    vec[1] = 0.5;
    db.vecInsert(obs.id, vec);

    // Search with same vector — should find it
    const results = db.searchVec(vec, project.id, ["active"], 5);
    expect(results.length).toBe(1);
    expect(results[0]!.observation_id).toBe(obs.id);
    expect(results[0]!.distance).toBe(0); // exact match
  });

  test("searchVec filters by project", () => {
    if (!db.vecAvailable) return;

    const proj1 = db.upsertProject({ canonical_id: "p1", name: "p1" });
    const proj2 = db.upsertProject({ canonical_id: "p2", name: "p2" });

    const obs1 = db.insertObservation({
      project_id: proj1.id,
      type: "bugfix",
      title: "P1 fix",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });
    const obs2 = db.insertObservation({
      project_id: proj2.id,
      type: "bugfix",
      title: "P2 fix",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });

    const vec = new Float32Array(384);
    vec[0] = 1.0;
    db.vecInsert(obs1.id, vec);
    db.vecInsert(obs2.id, vec);

    // Search scoped to project 1
    const results = db.searchVec(vec, proj1.id, ["active"], 5);
    expect(results.length).toBe(1);
    expect(results[0]!.observation_id).toBe(obs1.id);
  });

  test("searchVec excludes superseded observations", () => {
    if (!db.vecAvailable) return;

    const project = db.upsertProject({ canonical_id: "test/proj", name: "test" });

    const obs1 = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Old decision",
      quality: 0.7,
      user_id: "david",
      device_id: "laptop",
    });
    const obs2 = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "New decision",
      quality: 0.9,
      user_id: "david",
      device_id: "laptop",
    });

    const vec = new Float32Array(384);
    vec[0] = 1.0;
    db.vecInsert(obs1.id, vec);
    db.vecInsert(obs2.id, vec);

    // Supersede obs1 with obs2
    db.supersedeObservation(obs1.id, obs2.id);

    // Search should only return obs2
    const results = db.searchVec(vec, null, ["active"], 5);
    expect(results.length).toBe(1);
    expect(results[0]!.observation_id).toBe(obs2.id);
  });

  test("vecDelete removes embedding", () => {
    if (!db.vecAvailable) return;

    const project = db.upsertProject({ canonical_id: "t/p", name: "t" });
    const obs = db.insertObservation({
      project_id: project.id,
      type: "bugfix",
      title: "Test",
      quality: 0.8,
      user_id: "u",
      device_id: "d",
    });

    const vec = new Float32Array(384);
    vec[0] = 1.0;
    db.vecInsert(obs.id, vec);
    expect(db.searchVec(vec, null, ["active"], 5).length).toBe(1);

    db.vecDelete(obs.id);
    expect(db.searchVec(vec, null, ["active"], 5).length).toBe(0);
  });

  test("getUnembeddedObservations returns unembedded only", () => {
    if (!db.vecAvailable) return;

    const project = db.upsertProject({ canonical_id: "t/p", name: "t" });

    const obs1 = db.insertObservation({
      project_id: project.id,
      type: "bugfix",
      title: "Embedded",
      quality: 0.8,
      user_id: "u",
      device_id: "d",
    });
    db.insertObservation({
      project_id: project.id,
      type: "bugfix",
      title: "Not embedded",
      quality: 0.8,
      user_id: "u",
      device_id: "d",
    });

    // Embed only obs1
    const vec = new Float32Array(384);
    db.vecInsert(obs1.id, vec);

    const unembedded = db.getUnembeddedObservations(10);
    expect(unembedded.length).toBe(1);
    expect(unembedded[0]!.title).toBe("Not embedded");

    expect(db.getUnembeddedCount()).toBe(1);
  });

  test("searchVec returns empty when vecAvailable but no embeddings", () => {
    if (!db.vecAvailable) return;
    const vec = new Float32Array(384);
    const results = db.searchVec(vec, null, ["active"], 5);
    expect(results.length).toBe(0);
  });
});
