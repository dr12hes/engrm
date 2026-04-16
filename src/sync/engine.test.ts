import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "../storage/sqlite.js";
import type { Config } from "../config.js";
import { SyncEngine } from "./engine.js";

let db: MemDatabase;
let tmpDir: string;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    candengo_url: overrides.candengo_url ?? "",
    candengo_api_key: overrides.candengo_api_key ?? "",
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
  tmpDir = mkdtempSync(join(tmpdir(), "candengo-engine-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SyncEngine", () => {
  test("is not configured when no API key", () => {
    const engine = new SyncEngine(db, makeConfig());
    expect(engine.isConfigured()).toBe(false);
  });

  test("is configured when API key and URL provided", () => {
    const engine = new SyncEngine(
      db,
      makeConfig({
        candengo_url: "https://candengo.com",
        candengo_api_key: "cvk_test123",
      })
    );
    expect(engine.isConfigured()).toBe(true);
  });

  test("start is no-op when not configured", () => {
    const engine = new SyncEngine(db, makeConfig());
    engine.start();
    expect(engine.isRunning()).toBe(false);
    engine.stop(); // should not throw
  });

  test("start and stop work cleanly when configured", () => {
    const engine = new SyncEngine(
      db,
      makeConfig({
        candengo_url: "https://candengo.com",
        candengo_api_key: "cvk_test123",
      })
    );
    engine.start();
    expect(engine.isRunning()).toBe(true);
    engine.stop();
    expect(engine.isRunning()).toBe(false);
  });

  test("stop is idempotent", () => {
    const engine = new SyncEngine(db, makeConfig());
    engine.stop();
    engine.stop();
    // Should not throw
  });

  test("start with sync disabled is no-op", () => {
    const config = makeConfig({
      candengo_url: "https://candengo.com",
      candengo_api_key: "cvk_test123",
    });
    config.sync.enabled = false;
    const engine = new SyncEngine(db, config);
    engine.start();
    expect(engine.isRunning()).toBe(false);
    engine.stop();
  });

  test("records last_push_epoch when a push succeeds", async () => {
    class TestEngine extends SyncEngine {
      async pushNow(): Promise<void> {
        this["db"].setSyncState("last_push_epoch", String(Math.floor(Date.now() / 1000)));
      }
    }

    const engine = new TestEngine(
      db,
      makeConfig({
        candengo_url: "https://candengo.com",
        candengo_api_key: "cvk_test123",
      })
    );
    await engine.pushNow();
    expect(db.getSyncState("last_push_epoch")).toBeTruthy();
  });

  test("records last_pull_epoch when a pull receives data", async () => {
    class TestEngine extends SyncEngine {
      async pullNow(): Promise<void> {
        this["db"].setSyncState("last_pull_epoch", String(Math.floor(Date.now() / 1000)));
      }
    }

    const engine = new TestEngine(
      db,
      makeConfig({
        candengo_url: "https://candengo.com",
        candengo_api_key: "cvk_test123",
      })
    );
    await engine.pullNow();
    expect(db.getSyncState("last_pull_epoch")).toBeTruthy();
  });
});
