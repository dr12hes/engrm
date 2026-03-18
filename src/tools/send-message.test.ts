import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { MemDatabase } from "../storage/sqlite.js";
import { sendMessage } from "./send-message.js";

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
    sentinel: {
      enabled: false,
      mode: "advisory",
      provider: "openai",
      model: "gpt-4o-mini",
      api_key: "",
      base_url: "",
      skip_patterns: [],
      daily_limit: 100,
      tier: "free",
    },
    observer: {
      enabled: true,
      mode: "per_event",
      model: "sonnet",
    },
    transcript_analysis: {
      enabled: false,
    },
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-send-message-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
  config = makeConfig();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("sendMessage", () => {
  test("saves a lightweight message with only a title", async () => {
    const result = await sendMessage(db, config, {
      title: "Please re-check sync before release",
      cwd: tmpDir,
    });

    expect(result.success).toBe(true);
    expect(result.observation_id).toBeGreaterThan(0);

    const obs = db.getObservationById(result.observation_id!);
    expect(obs?.type).toBe("message");
    expect(obs?.title).toBe("Please re-check sync before release");
  });
});
