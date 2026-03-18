import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "../storage/sqlite.js";
import type { Config } from "../config.js";
import { buildVectorDocument } from "./push.js";

let db: MemDatabase;
let tmpDir: string;
let projectId: number;

function makeConfig(): Config {
  return {
    candengo_url: "https://candengo.com",
    candengo_api_key: "cvk_test123",
    site_id: "test-site",
    namespace: "dev-memory",
    user_id: "david",
    device_id: "laptop-abc",
    user_email: "",
    teams: [],
    sync: { enabled: true, interval_seconds: 30, batch_size: 50 },
    search: { default_limit: 10, local_boost: 1.2, scope: "all" },
    scrubbing: { enabled: true, custom_patterns: [], default_sensitivity: "shared" },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "candengo-push-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
  const project = db.upsertProject({
    canonical_id: "github.com/test/repo",
    name: "repo",
  });
  projectId = project.id;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildVectorDocument", () => {
  test("produces correct structure", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Fixed auth bug",
      narrative: "The auth was broken due to a type mismatch",
      facts: '["fact1", "fact2"]',
      concepts: '["auth", "debugging"]',
      quality: 0.8,
      user_id: "david",
      device_id: "laptop-abc",
      agent: "claude-code",
    });

    const doc = buildVectorDocument(obs, makeConfig(), {
      canonical_id: "github.com/test/repo",
      name: "repo",
    });

    expect(doc.site_id).toBe("test-site");
    expect(doc.namespace).toBe("dev-memory");
    expect(doc.source_type).toBe("bugfix");
    expect(doc.source_id).toBe(`david-laptop-abc-obs-${obs.id}`);
    expect(doc.content).toContain("Fixed auth bug");
    expect(doc.content).toContain("The auth was broken");
    expect(doc.content).toContain("- fact1");
    expect(doc.content).toContain("- fact2");
    expect(doc.metadata.project_canonical).toBe("github.com/test/repo");
    expect(doc.metadata.quality).toBe(0.8);
    expect(doc.metadata.user_id).toBe("david");
  });

  test("handles observation with no narrative or facts", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "change",
      title: "Simple change",
      quality: 0.3,
      user_id: "david",
      device_id: "laptop-abc",
    });

    const doc = buildVectorDocument(obs, makeConfig(), {
      canonical_id: "github.com/test/repo",
      name: "repo",
    });

    expect(doc.content).toBe("Simple change");
    expect(doc.metadata.title).toBe("Simple change");
  });

  test("includes files_modified in metadata", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "change",
      title: "Edit file",
      files_modified: '["src/main.ts", "src/utils.ts"]',
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });

    const doc = buildVectorDocument(obs, makeConfig(), {
      canonical_id: "github.com/test/repo",
      name: "repo",
    });

    expect(doc.metadata.files_modified).toEqual([
      "src/main.ts",
      "src/utils.ts",
    ]);
  });
});
