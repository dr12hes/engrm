import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "../storage/sqlite.js";
import type { Config } from "../config.js";
import { saveObservation, type SaveObservationInput } from "./save.js";

let db: MemDatabase;
let tmpDir: string;
let config: Config;

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    candengo_url: "https://api.candengo.com",
    candengo_api_key: "test-key",
    site_id: "test-site",
    namespace: "test-ns",
    user_id: "david",
    device_id: "laptop-abc",
    user_email: "",
    teams: [],
    sync: { enabled: true, interval_seconds: 30, batch_size: 50 },
    search: { default_limit: 10, local_boost: 1.2, scope: "all" },
    scrubbing: {
      enabled: true,
      custom_patterns: [],
      default_sensitivity: "shared",
    },
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-save-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
  config = makeConfig();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("saveObservation", () => {
  test("saves valid observation", async () => {
    const result = await saveObservation(db, config, {
      type: "bugfix",
      title: "Fix authentication bug",
      narrative: "The token was not being refreshed properly on expiry, causing 401 errors",
      cwd: "/Volumes/Data/devs/engrm",
    });
    expect(result.success).toBe(true);
    expect(result.observation_id).toBeGreaterThan(0);
    expect(result.quality_score).toBeGreaterThan(0);
  });

  test("rejects invalid type", async () => {
    const result = await saveObservation(db, config, {
      type: "invalid",
      title: "Test",
      cwd: "/tmp",
    });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Invalid type");
  });

  test("rejects empty title", async () => {
    const result = await saveObservation(db, config, {
      type: "bugfix",
      title: "",
      cwd: "/tmp",
    });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Title is required");
  });

  test("rejects whitespace-only title", async () => {
    const result = await saveObservation(db, config, {
      type: "bugfix",
      title: "   ",
      cwd: "/tmp",
    });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Title is required");
  });

  test("rejects low-quality observation", async () => {
    // A bare "change" type with no enrichment scores 0.05 < threshold 0.1
    const result = await saveObservation(db, config, {
      type: "change",
      title: "Minor tweak",
      cwd: "/tmp",
    });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Quality score");
  });

  test("scrubs secrets from title", async () => {
    const result = await saveObservation(db, config, {
      type: "bugfix",
      title: "Fix sk-abc123def456ghi789jkl012mno in config",
      narrative: "Found the API key hardcoded, which is a discovery worth noting for the team",
      cwd: "/tmp",
    });
    expect(result.success).toBe(true);

    const obs = db.getObservationById(result.observation_id!);
    expect(obs!.title).toContain("[REDACTED_API_KEY]");
    expect(obs!.title).not.toContain("sk-abc123");
  });

  test("scrubs secrets from narrative", async () => {
    const result = await saveObservation(db, config, {
      type: "discovery",
      title: "Found hardcoded credentials",
      narrative: "Database URL was postgresql://admin:secret@db.example.com/prod",
      cwd: "/tmp",
    });
    expect(result.success).toBe(true);

    const obs = db.getObservationById(result.observation_id!);
    expect(obs!.narrative).toContain("[REDACTED_DB_URL]");
  });

  test("skips scrubbing when disabled", async () => {
    const noScrubConfig = makeConfig({
      scrubbing: {
        enabled: false,
        custom_patterns: [],
        default_sensitivity: "shared",
      },
    });

    const result = await saveObservation(db, noScrubConfig, {
      type: "bugfix",
      title: "Fix sk-abc123def456ghi789jkl012mno",
      narrative: "This is a long narrative about the API key that was found in the config file and needs to be addressed",
      cwd: "/tmp",
    });
    expect(result.success).toBe(true);

    const obs = db.getObservationById(result.observation_id!);
    expect(obs!.title).toContain("sk-abc123");
  });

  test("upgrades sensitivity when secrets detected", async () => {
    const result = await saveObservation(db, config, {
      type: "discovery",
      title: "Found API key sk-abc123def456ghi789jkl012mno in env",
      narrative: "Important discovery worth documenting for the team context and future reference",
      cwd: "/tmp",
    });
    expect(result.success).toBe(true);

    const obs = db.getObservationById(result.observation_id!);
    expect(obs!.sensitivity).toBe("personal");
  });

  test("detects duplicates within 24h", async () => {
    // Save first observation
    const first = await saveObservation(db, config, {
      type: "bugfix",
      title: "Fix authentication token refresh",
      narrative: "Long enough narrative to pass quality: the token refresh mechanism was broken due to race condition",
      cwd: "/Volumes/Data/devs/engrm",
    });
    expect(first.success).toBe(true);

    // Save near-duplicate
    const second = await saveObservation(db, config, {
      type: "bugfix",
      title: "Fix authentication token refresh",
      narrative: "Same fix described differently but still about the token refresh race condition issue",
      cwd: "/Volumes/Data/devs/engrm",
    });
    expect(second.success).toBe(true);
    expect(second.merged_into).toBe(first.observation_id);
  });

  test("adds observation to sync outbox", async () => {
    const result = await saveObservation(db, config, {
      type: "decision",
      title: "Choose PostgreSQL over MySQL",
      narrative: "PostgreSQL has better JSON support and more advanced indexing capabilities for our use case",
      cwd: "/tmp",
    });
    expect(result.success).toBe(true);

    const outbox = db.db
      .query<{ record_id: number }, [number]>(
        "SELECT record_id FROM sync_outbox WHERE record_id = ? AND record_type = 'observation'"
      )
      .get(result.observation_id!);
    expect(outbox).not.toBeNull();
  });

  test("stores facts and concepts as JSON", async () => {
    const result = await saveObservation(db, config, {
      type: "decision",
      title: "Choose PostgreSQL",
      facts: ["Supports JSONB", "Better indexing"],
      concepts: ["database", "postgresql"],
      cwd: "/tmp",
    });
    expect(result.success).toBe(true);

    const obs = db.getObservationById(result.observation_id!);
    expect(JSON.parse(obs!.facts!)).toEqual(["Supports JSONB", "Better indexing"]);
    expect(JSON.parse(obs!.concepts!)).toEqual(["database", "postgresql"]);
  });

  test("derives structured facts when none are provided", async () => {
    const result = await saveObservation(db, config, {
      type: "bugfix",
      title: "Fix authentication token refresh",
      narrative:
        "Token refresh was failing after expiry because the retry path skipped the new credentials. Added a guard to rebuild the auth header before retrying.",
      files_modified: ["/tmp/project/src/auth.ts", "/tmp/project/src/http/client.ts"],
      cwd: "/tmp/project",
    });
    expect(result.success).toBe(true);

    const obs = db.getObservationById(result.observation_id!);
    const facts = JSON.parse(obs!.facts!);
    expect(facts).toContain("Fix authentication token refresh");
    expect(facts.some((fact: string) => fact.includes("Token refresh was failing after expiry"))).toBe(true);
    expect(facts.some((fact: string) => fact.includes("Touched src/auth.ts, src/http/client.ts"))).toBe(true);
  });

  test("saves with session_id", async () => {
    const result = await saveObservation(db, config, {
      type: "bugfix",
      title: "Fix auth bug",
      narrative: "Important fix that required significant investigation and multiple file changes",
      session_id: "sess-123",
      cwd: "/tmp",
    });
    expect(result.success).toBe(true);

    const obs = db.getObservationById(result.observation_id!);
    expect(obs!.session_id).toBe("sess-123");
  });

  test("converts absolute file paths to project-relative", async () => {
    const result = await saveObservation(db, config, {
      type: "bugfix",
      title: "Fix path handling",
      narrative: "Important fix to ensure file paths are stored relative to the project root directory",
      files_read: ["/projects/myapp/src/auth.ts", "/projects/myapp/README.md"],
      files_modified: ["/projects/myapp/src/auth.ts"],
      cwd: "/projects/myapp",
    });
    expect(result.success).toBe(true);

    const obs = db.getObservationById(result.observation_id!);
    const filesRead = JSON.parse(obs!.files_read!);
    const filesModified = JSON.parse(obs!.files_modified!);
    expect(filesRead).toEqual(["src/auth.ts", "README.md"]);
    expect(filesModified).toEqual(["src/auth.ts"]);
  });

  test("leaves already-relative paths unchanged", async () => {
    const result = await saveObservation(db, config, {
      type: "bugfix",
      title: "Fix with relative paths",
      narrative: "Another important fix that tests the relative path handling for already relative paths",
      files_modified: ["src/auth.ts", "lib/utils.ts"],
      cwd: "/tmp",
    });
    expect(result.success).toBe(true);

    const obs = db.getObservationById(result.observation_id!);
    const filesModified = JSON.parse(obs!.files_modified!);
    expect(filesModified).toEqual(["src/auth.ts", "lib/utils.ts"]);
  });

  test("keeps paths outside project root as-is", async () => {
    const result = await saveObservation(db, config, {
      type: "discovery",
      title: "Found external dependency issue",
      narrative: "Discovered a problem in an external file outside the project root directory boundary",
      files_read: ["/usr/local/lib/node_modules/pkg/index.js"],
      cwd: "/projects/myapp",
    });
    expect(result.success).toBe(true);

    const obs = db.getObservationById(result.observation_id!);
    const filesRead = JSON.parse(obs!.files_read!);
    expect(filesRead).toEqual(["/usr/local/lib/node_modules/pkg/index.js"]);
  });

  test("all valid types accepted", async () => {
    const types = [
      "bugfix",
      "discovery",
      "decision",
      "pattern",
      "change",
      "feature",
      "refactor",
      "digest",
    ];

    for (const type of types) {
      const result = await saveObservation(db, config, {
        type,
        title: `Test ${type} observation`,
        narrative: "Detailed narrative to ensure quality threshold is met for all observation types",
        facts: ["fact1", "fact2"],
        cwd: "/tmp",
      });
      // Some low-scoring types may not meet threshold, but they shouldn't fail with "Invalid type"
      if (!result.success) {
        expect(result.reason).not.toContain("Invalid type");
      }
    }
  });
});
