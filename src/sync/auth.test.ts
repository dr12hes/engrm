import { describe, expect, test, afterEach } from "bun:test";
import { getApiKey, getBaseUrl, buildSourceId, parseSourceId } from "./auth.js";
import type { Config } from "../config.js";

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
  };
}

afterEach(() => {
  delete process.env.ENGRM_TOKEN;
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
