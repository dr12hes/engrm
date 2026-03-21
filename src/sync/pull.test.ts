import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "../storage/sqlite.js";
import type { Config } from "../config.js";
import { pullFromVector } from "./pull.js";
import type {
  VectorClient,
  VectorChangeFeedResponse,
  VectorSearchResult,
} from "./client.js";

let db: MemDatabase;
let tmpDir: string;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    candengo_url: "https://candengo.com",
    candengo_api_key: "cvk_test123",
    site_id: "test-site",
    namespace: "dev-memory",
    user_id: "david",
    user_email: "",
    device_id: "laptop-abc",
    teams: [],
    sync: { enabled: true, interval_seconds: 30, batch_size: 50 },
    search: { default_limit: 10, local_boost: 1.2, scope: "all" },
    scrubbing: {
      enabled: true,
      custom_patterns: [],
      default_sensitivity: "shared",
    },
  };
}

function makeChange(
  id: number,
  overrides: Partial<VectorSearchResult> = {}
): VectorSearchResult {
  return {
    source_id:
      overrides.source_id ?? `other-user-other-device-obs-${id}`,
    content: overrides.content ?? `Title ${id}\n\nNarrative for ${id}`,
    score: 1.0,
    metadata: overrides.metadata ?? {
      project_canonical: "github.com/test/repo",
      project_name: "repo",
      type: "discovery",
      title: `Title ${id}`,
      user_id: "other-user",
      device_id: "other-device",
      agent: "claude-code",
      quality: 0.7,
    },
  };
}

function mockClient(
  pages: VectorChangeFeedResponse[]
): VectorClient {
  let callCount = 0;
  return {
    pullChanges: async (
      _cursor?: string,
      _limit?: number
    ): Promise<VectorChangeFeedResponse> => {
      const page = pages[callCount] ?? {
        changes: [],
        cursor: "end",
        has_more: false,
      };
      callCount++;
      return page;
    },
  } as unknown as VectorClient;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-pull-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("pullFromVector", () => {
  test("merges single page of changes", async () => {
    const client = mockClient([
      {
        changes: [makeChange(1), makeChange(2)],
        cursor: "cursor-1",
        has_more: false,
      },
    ]);

    const result = await pullFromVector(db, client, makeConfig());
    expect(result.received).toBe(2);
    expect(result.merged).toBe(2);
    expect(result.skipped).toBe(0);
  });

  test("loops on has_more", async () => {
    const client = mockClient([
      {
        changes: [makeChange(1), makeChange(2)],
        cursor: "cursor-1",
        has_more: true,
      },
      {
        changes: [makeChange(3)],
        cursor: "cursor-2",
        has_more: false,
      },
    ]);

    const result = await pullFromVector(db, client, makeConfig());
    expect(result.received).toBe(3);
    expect(result.merged).toBe(3);
  });

  test("loops through multiple pages", async () => {
    const client = mockClient([
      {
        changes: [makeChange(1)],
        cursor: "c1",
        has_more: true,
      },
      {
        changes: [makeChange(2)],
        cursor: "c2",
        has_more: true,
      },
      {
        changes: [makeChange(3)],
        cursor: "c3",
        has_more: false,
      },
    ]);

    const result = await pullFromVector(db, client, makeConfig());
    expect(result.received).toBe(3);
    expect(result.merged).toBe(3);
  });

  test("stops at MAX_PAGES safety limit", async () => {
    // Create 25 pages (MAX_PAGES = 20)
    const pages: VectorChangeFeedResponse[] = Array.from(
      { length: 25 },
      (_, i) => ({
        changes: [makeChange(i + 1)],
        cursor: `cursor-${i + 1}`,
        has_more: true,
      })
    );

    const client = mockClient(pages);
    const result = await pullFromVector(db, client, makeConfig());
    // Should stop at 20 pages
    expect(result.received).toBe(20);
    expect(result.merged).toBe(20);
  });

  test("skips observations from own device", async () => {
    const ownChange: VectorSearchResult = {
      source_id: "david-laptop-abc-obs-1",
      content: "Title\n\nNarrative",
      score: 1.0,
      metadata: {
        project_canonical: "github.com/test/repo",
        type: "discovery",
        title: "Title",
        user_id: "david",
        device_id: "laptop-abc",
        agent: "claude-code",
        quality: 0.7,
      },
    };

    const client = mockClient([
      {
        changes: [ownChange, makeChange(2)],
        cursor: "c1",
        has_more: false,
      },
    ]);

    const result = await pullFromVector(db, client, makeConfig());
    expect(result.received).toBe(2);
    expect(result.merged).toBe(1);
    expect(result.skipped).toBe(1);
  });

  test("skips duplicate remote_source_id", async () => {
    const client = mockClient([
      {
        changes: [makeChange(1)],
        cursor: "c1",
        has_more: false,
      },
    ]);

    // Pull once
    await pullFromVector(db, client, makeConfig());

    // Pull same change again
    const client2 = mockClient([
      {
        changes: [makeChange(1)],
        cursor: "c2",
        has_more: false,
      },
    ]);

    const result = await pullFromVector(db, client2, makeConfig());
    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("saves cursor after each page", async () => {
    const client = mockClient([
      {
        changes: [makeChange(1)],
        cursor: "cursor-page1",
        has_more: true,
      },
      {
        changes: [makeChange(2)],
        cursor: "cursor-page2",
        has_more: false,
      },
    ]);

    await pullFromVector(db, client, makeConfig());
    expect(db.getSyncState("pull_cursor")).toBe("cursor-page2");
  });

  test("handles empty response", async () => {
    const client = mockClient([
      {
        changes: [],
        cursor: "",
        has_more: false,
      },
    ]);

    const result = await pullFromVector(db, client, makeConfig());
    expect(result.received).toBe(0);
    expect(result.merged).toBe(0);
  });

  test("skips changes without project_canonical", async () => {
    const noProject: VectorSearchResult = {
      source_id: "other-other-obs-1",
      content: "Title\n\nNarrative",
      score: 1.0,
      metadata: {
        type: "discovery",
        title: "Title",
        user_id: "other",
        device_id: "other",
      },
    };

    const client = mockClient([
      {
        changes: [noProject],
        cursor: "c1",
        has_more: false,
      },
    ]);

    const result = await pullFromVector(db, client, makeConfig());
    expect(result.skipped).toBe(1);
    expect(result.merged).toBe(0);
  });

  test("preserves sensitivity and original timestamps from remote metadata", async () => {
    const createdAtEpoch = 1700000000;
    const createdAt = new Date(createdAtEpoch * 1000).toISOString();
    const client = mockClient([
      {
        changes: [
          makeChange(1, {
            metadata: {
              project_canonical: "github.com/test/repo",
              project_name: "repo",
              type: "decision",
              title: "Remote private note",
              user_id: "alice",
              device_id: "desktop-xyz",
              agent: "codex-cli",
              quality: 0.9,
              sensitivity: "personal",
              created_at_epoch: createdAtEpoch,
              created_at: createdAt,
            },
          }),
        ],
        cursor: "c1",
        has_more: false,
      },
    ]);

    await pullFromVector(db, client, makeConfig());

    const obs = db.db
      .query<{ sensitivity: string; created_at_epoch: number; created_at: string }, []>(
        "SELECT sensitivity, created_at_epoch, created_at FROM observations LIMIT 1"
      )
      .get();

    expect(obs?.sensitivity).toBe("personal");
    expect(obs?.created_at_epoch).toBe(createdAtEpoch);
    expect(obs?.created_at).toBe(createdAt);
  });

  test("imports remote summary docs into local session_summaries", async () => {
    const client = mockClient([
      {
        changes: [
          makeChange(1, {
            source_id: "other-user-other-device-summary-1",
            metadata: {
              project_canonical: "github.com/test/repo",
              project_name: "repo",
              type: "summary",
              title: "Session summary",
              user_id: "other-user",
              device_id: "other-device",
              session_id: "sess-remote-1",
              request: "Investigate auth regression",
              completed: "- Added auth guard",
              capture_state: "partial",
              recent_tool_names: ["Edit", "Bash"],
              hot_files: ["app/auth.py"],
              recent_outcomes: ["Added auth guard"],
            },
          }),
        ],
        cursor: "c1",
        has_more: false,
      },
    ]);

    await pullFromVector(db, client, makeConfig());

    const summary = db.getSessionSummary("sess-remote-1");
    expect(summary).not.toBeNull();
    expect(summary?.request).toBe("Investigate auth regression");
    expect(summary?.completed).toBe("- Added auth guard");
    expect(summary?.capture_state).toBe("partial");
    expect(summary?.recent_tool_names).toBe(JSON.stringify(["Edit", "Bash"]));
    expect(summary?.hot_files).toBe(JSON.stringify(["app/auth.py"]));
    expect(summary?.recent_outcomes).toBe(JSON.stringify(["Added auth guard"]));
  });

  test("updates local session summary when remote summary doc changes", async () => {
    const client1 = mockClient([
      {
        changes: [
          makeChange(1, {
            source_id: "other-user-other-device-summary-2",
            metadata: {
              project_canonical: "github.com/test/repo",
              project_name: "repo",
              type: "summary",
              title: "Session summary",
              user_id: "other-user",
              device_id: "other-device",
              session_id: "sess-remote-2",
              request: "Investigate auth regression",
            },
          }),
        ],
        cursor: "c1",
        has_more: false,
      },
    ]);

    await pullFromVector(db, client1, makeConfig());

    const client2 = mockClient([
      {
        changes: [
          makeChange(1, {
            source_id: "other-user-other-device-summary-2",
            metadata: {
              project_canonical: "github.com/test/repo",
              project_name: "repo",
              type: "summary",
              title: "Session summary",
              user_id: "other-user",
              device_id: "other-device",
              session_id: "sess-remote-2",
              request: "Investigate auth regression",
              completed: "- Added auth guard",
            },
          }),
        ],
        cursor: "c2",
        has_more: false,
      },
    ]);

    await pullFromVector(db, client2, makeConfig());

    const summary = db.getSessionSummary("sess-remote-2");
    expect(summary).not.toBeNull();
    expect(summary?.completed).toBe("- Added auth guard");
  });
});
