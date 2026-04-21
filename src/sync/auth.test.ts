import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getApiKey, getAuthFingerprint, getBaseUrl, buildSourceId, parseSourceId, recoverOutboxAfterAuthChange, recoverOutboxAfterSuccessfulAuth } from "./auth.js";
import type { Config } from "../config.js";
import { MemDatabase } from "../storage/sqlite.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    candengo_url: overrides.candengo_url ?? "https://candengo.com",
    candengo_api_key: overrides.candengo_api_key ?? "cvk_test123",
    site_id: overrides.site_id ?? "test-site",
    namespace: overrides.namespace ?? "dev-memory",
    user_id: overrides.user_id ?? "david",
    device_id: overrides.device_id ?? "laptop-abc",
    user_email: "",
    teams: [],
    sync: { enabled: true, interval_seconds: 30, batch_size: 50 },
    search: { default_limit: 10, local_boost: 1.2, scope: "all" },
    scrubbing: { enabled: true, custom_patterns: [], default_sensitivity: "shared" },
    sentinel: { enabled: false, mode: "advisory", provider: "openai", model: "gpt-4o-mini", api_key: "", base_url: "", skip_patterns: [], daily_limit: 100, tier: "free" },
    observer: { enabled: true, mode: "per_event", model: "sonnet" },
    transcript_analysis: { enabled: false },
    http: { enabled: false, port: 3767, bearer_tokens: [] },
    fleet: { project_name: "shared-experience", namespace: "", api_key: "" },
    tool_profile: "full",
  };
}

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-sync-auth-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  delete process.env.ENGRM_TOKEN;
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getApiKey", () => {
  test("returns env var when set", () => {
    process.env.ENGRM_TOKEN = "cvk_from_env";
    expect(getApiKey(makeConfig())).toBe("cvk_from_env");
  });

  test("falls back to config when env var not set", () => {
    expect(getApiKey(makeConfig())).toBe("cvk_test123");
  });

  test("returns null when both empty", () => {
    expect(getApiKey(makeConfig({ candengo_api_key: "" }))).toBeNull();
  });

  test("ignores env var without cvk_ prefix", () => {
    process.env.ENGRM_TOKEN = "not_a_valid_key";
    expect(getApiKey(makeConfig())).toBe("cvk_test123");
  });
});

describe("getBaseUrl", () => {
  test("normalizes legacy public URL to engrm.dev", () => {
    expect(getBaseUrl(makeConfig())).toBe("https://engrm.dev");
  });

  test("preserves custom hosts", () => {
    expect(getBaseUrl(makeConfig({ candengo_url: "https://vector.internal.company.com" }))).toBe(
      "https://vector.internal.company.com"
    );
  });

  test("returns null for empty URL", () => {
    expect(getBaseUrl(makeConfig({ candengo_url: "" }))).toBeNull();
  });
});

describe("auth fingerprint recovery", () => {
  test("returns a stable fingerprint when configured", () => {
    const fingerprint = getAuthFingerprint(makeConfig());
    expect(fingerprint).toBeTruthy();
    expect(fingerprint).toHaveLength(64);
  });

  test("requeues failed and syncing outbox items when auth changes", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });

    const obs1 = db.insertObservation({
      project_id: project.id,
      type: "change",
      title: "Test 1",
      user_id: "david",
      device_id: "laptop-abc",
      agent: "claude-code",
    });
    db.addToOutbox("observation", obs1.id);
    db.db.query("UPDATE sync_outbox SET status = 'failed', retry_count = 10, last_error = 'auth failed' WHERE record_id = ?").run(obs1.id);

    const obs2 = db.insertObservation({
      project_id: project.id,
      type: "change",
      title: "Test 2",
      user_id: "david",
      device_id: "laptop-abc",
      agent: "claude-code",
    });
    db.addToOutbox("observation", obs2.id);
    db.db.query("UPDATE sync_outbox SET status = 'syncing', next_retry_epoch = 1 WHERE record_id = ?").run(obs2.id);

    const result = recoverOutboxAfterAuthChange(db, makeConfig());
    expect(result.fingerprintChanged).toBe(true);
    expect(result.failedReset).toBe(1);
    expect(result.syncingReset).toBe(1);
    expect(result.staleSyncingReset).toBe(0);

    const rows = db.db
      .query<{ record_id: number; status: string; retry_count: number }, []>(
        "SELECT record_id, status, retry_count FROM sync_outbox ORDER BY record_id"
      )
      .all();
    expect(rows[0]).toEqual({ record_id: obs1.id, status: "pending", retry_count: 0 });
    expect(rows[1]).toEqual({ record_id: obs2.id, status: "pending", retry_count: 0 });
  });

  test("does nothing when auth fingerprint has not changed", () => {
    const first = recoverOutboxAfterAuthChange(db, makeConfig());
    expect(first.fingerprintChanged).toBe(true);

    const second = recoverOutboxAfterAuthChange(db, makeConfig());
    expect(second.fingerprintChanged).toBe(false);
    expect(second.failedReset).toBe(0);
    expect(second.authFailedReset).toBe(0);
    expect(second.syncingReset).toBe(0);
    expect(second.staleSyncingReset).toBe(0);
  });

  test("requeues stale auth failures even when auth fingerprint is unchanged", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    const obs = db.insertObservation({
      project_id: project.id,
      type: "change",
      title: "Test stale auth failure",
      user_id: "david",
      device_id: "laptop-abc",
      agent: "claude-code",
    });
    db.addToOutbox("observation", obs.id);

    const first = recoverOutboxAfterAuthChange(db, makeConfig());
    expect(first.fingerprintChanged).toBe(true);

    db.db
      .query("UPDATE sync_outbox SET status = 'failed', retry_count = 4, last_error = 'Vector API error 401 on /v1/ingest: {\"detail\":\"Invalid or missing credentials\"}' WHERE record_id = ?")
      .run(obs.id);

    const second = recoverOutboxAfterAuthChange(db, makeConfig());
    expect(second.fingerprintChanged).toBe(false);
    expect(second.authFailedReset).toBe(1);

    const row = db.db
      .query<{ status: string; retry_count: number; last_error: string | null }, [number]>(
        "SELECT status, retry_count, last_error FROM sync_outbox WHERE record_id = ?"
      )
      .get(obs.id);
    expect(row?.status).toBe("pending");
    expect(row?.retry_count).toBe(0);
    expect(row?.last_error).toBeNull();
  });

  test("requeues stale syncing entries even when auth fingerprint is unchanged", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    const obs = db.insertObservation({
      project_id: project.id,
      type: "change",
      title: "Test stale syncing",
      user_id: "david",
      device_id: "laptop-abc",
      agent: "claude-code",
    });
    db.addToOutbox("observation", obs.id);

    const first = recoverOutboxAfterAuthChange(db, makeConfig());
    expect(first.fingerprintChanged).toBe(true);

    db.db
      .query("UPDATE sync_outbox SET status = 'syncing', next_retry_epoch = 1 WHERE record_id = ?")
      .run(obs.id);

    const second = recoverOutboxAfterAuthChange(db, makeConfig());
    expect(second.fingerprintChanged).toBe(false);
    expect(second.staleSyncingReset).toBe(1);

    const row = db.db
      .query<{ status: string; next_retry_epoch: number | null }, [number]>(
        "SELECT status, next_retry_epoch FROM sync_outbox WHERE record_id = ?"
      )
      .get(obs.id);
    expect(row?.status).toBe("pending");
    expect(row?.next_retry_epoch).toBeNull();
  });

  test("requeues auth failures after a successful auth flow", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    const obs = db.insertObservation({
      project_id: project.id,
      type: "change",
      title: "Test auth failure",
      user_id: "david",
      device_id: "laptop-abc",
      agent: "claude-code",
    });
    db.addToOutbox("observation", obs.id);
    db.db
      .query("UPDATE sync_outbox SET status = 'failed', retry_count = 5, last_error = 'Vector API error 401 on /v1/ingest: {\"detail\":\"Invalid or missing credentials\"}' WHERE record_id = ?")
      .run(obs.id);

    const result = recoverOutboxAfterSuccessfulAuth(db, makeConfig());
    expect(result.authFailedReset).toBe(1);

    const row = db.db
      .query<{ status: string; retry_count: number; last_error: string | null }, [number]>(
        "SELECT status, retry_count, last_error FROM sync_outbox WHERE record_id = ?"
      )
      .get(obs.id);
    expect(row?.status).toBe("pending");
    expect(row?.retry_count).toBe(0);
    expect(row?.last_error).toBeNull();
  });
});

describe("buildSourceId", () => {
  test("produces correct format", () => {
    const config = makeConfig({ user_id: "david", device_id: "laptop-abc" });
    expect(buildSourceId(config, 42)).toBe("david-laptop-abc-obs-42");
  });
});

describe("parseSourceId", () => {
  test("parses valid source ID", () => {
    const result = parseSourceId("david-laptop-abc-obs-42");
    expect(result).toEqual({
      userId: "david",
      deviceId: "laptop-abc",
      localId: 42,
      type: "obs",
    });
  });

  test("parses chat and summary source IDs", () => {
    expect(parseSourceId("david-laptop-abc-chat-7")).toEqual({
      userId: "david",
      deviceId: "laptop-abc",
      localId: 7,
      type: "chat",
    });
    expect(parseSourceId("david-laptop-abc-summary-9")).toEqual({
      userId: "david",
      deviceId: "laptop-abc",
      localId: 9,
      type: "summary",
    });
  });

  test("returns null for invalid format", () => {
    expect(parseSourceId("invalid")).toBeNull();
    expect(parseSourceId("")).toBeNull();
  });
});
