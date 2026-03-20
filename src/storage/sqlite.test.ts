import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "./sqlite.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-sqlite-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MemDatabase — projects", () => {
  test("upsertProject creates a new project", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
      local_path: "/tmp/repo",
      remote_url: "git@github.com:org/repo.git",
    });
    expect(project.id).toBeGreaterThan(0);
    expect(project.canonical_id).toBe("github.com/org/repo");
    expect(project.name).toBe("repo");
  });

  test("upsertProject updates existing project", () => {
    const first = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
      local_path: "/old/path",
    });
    const second = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
      local_path: "/new/path",
    });
    expect(second.id).toBe(first.id);
    expect(second.local_path).toBe("/new/path");
  });

  test("getProjectByCanonicalId returns project", () => {
    db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    const found = db.getProjectByCanonicalId("github.com/org/repo");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("repo");
  });

  test("getProjectByCanonicalId returns null for missing", () => {
    expect(db.getProjectByCanonicalId("nonexistent")).toBeNull();
  });

  test("getProjectById returns project", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    const found = db.getProjectById(project.id);
    expect(found).not.toBeNull();
    expect(found!.canonical_id).toBe("github.com/org/repo");
  });
});

describe("MemDatabase — observations", () => {
  let projectId: number;

  beforeEach(() => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    projectId = project.id;
  });

  test("insertObservation creates observation", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Fix auth bug",
      quality: 0.7,
      user_id: "david",
      device_id: "laptop-abc",
    });
    expect(obs.id).toBeGreaterThan(0);
    expect(obs.type).toBe("bugfix");
    expect(obs.title).toBe("Fix auth bug");
    expect(obs.lifecycle).toBe("active");
    expect(obs.sensitivity).toBe("shared");
  });

  test("insertObservation with all fields", () => {
    const obs = db.insertObservation({
      session_id: "sess-123",
      project_id: projectId,
      type: "decision",
      title: "Choose PostgreSQL",
      narrative: "We chose PG for its JSON support",
      facts: '["PG supports JSONB", "Better indexing"]',
      concepts: '["database", "postgresql"]',
      files_read: '["docs/db.md"]',
      files_modified: '["src/db.ts"]',
      quality: 0.9,
      lifecycle: "active",
      sensitivity: "personal",
      user_id: "david",
      device_id: "laptop-abc",
      agent: "claude-code",
    });
    expect(obs.narrative).toBe("We chose PG for its JSON support");
    expect(obs.sensitivity).toBe("personal");
  });

  test("getObservationById returns observation", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "discovery",
      title: "Found memory leak",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });
    const found = db.getObservationById(obs.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Found memory leak");
  });

  test("getObservationById returns null for missing", () => {
    expect(db.getObservationById(99999)).toBeNull();
  });

  test("getObservationsByIds returns multiple", () => {
    const obs1 = db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Fix 1",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });
    const obs2 = db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Fix 2",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });
    const results = db.getObservationsByIds([obs1.id, obs2.id]);
    expect(results.length).toBe(2);
  });

  test("getObservationsByIds returns empty for empty input", () => {
    expect(db.getObservationsByIds([])).toEqual([]);
  });

  test("getObservationsByIds hides personal observations from other users", () => {
    const own = db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "My personal note",
      quality: 0.5,
      sensitivity: "personal",
      user_id: "david",
      device_id: "laptop-abc",
    });
    const other = db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Alice personal note",
      quality: 0.5,
      sensitivity: "personal",
      user_id: "alice",
      device_id: "desktop-xyz",
    });

    const results = db.getObservationsByIds([own.id, other.id], "david");
    expect(results.map((obs) => obs.id)).toEqual([own.id]);
  });

  test("getRecentObservations returns observations within window", () => {
    db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Recent fix",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });

    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
    const recent = db.getRecentObservations(projectId, oneDayAgo);
    expect(recent.length).toBe(1);
    expect(recent[0]!.title).toBe("Recent fix");
  });

  test("getActiveObservationCount counts correctly", () => {
    db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Fix 1",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertObservation({
      project_id: projectId,
      type: "discovery",
      title: "Find 1",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });
    expect(db.getActiveObservationCount()).toBe(2);
  });

  test("getActiveObservationCount filters by user", () => {
    db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Fix by david",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Fix by alice",
      quality: 0.5,
      user_id: "alice",
      device_id: "desktop-xyz",
    });
    expect(db.getActiveObservationCount("david")).toBe(1);
    expect(db.getActiveObservationCount("alice")).toBe(1);
  });
});

describe("MemDatabase — user prompts", () => {
  let projectId: number;

  beforeEach(() => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    projectId = project.id;
  });

  test("insertUserPrompt stores prompt chronology", () => {
    const first = db.insertUserPrompt({
      session_id: "sess-1",
      project_id: projectId,
      prompt: "Investigate the auth redirect loop",
      cwd: "/tmp/repo",
      user_id: "david",
      device_id: "laptop-abc",
    });

    const second = db.insertUserPrompt({
      session_id: "sess-1",
      project_id: projectId,
      prompt: "Now fix the cookie domain handling too",
      cwd: "/tmp/repo",
      user_id: "david",
      device_id: "laptop-abc",
    });

    expect(first.prompt_number).toBe(1);
    expect(second.prompt_number).toBe(2);

    const prompts = db.getSessionUserPrompts("sess-1");
    expect(prompts.map((item) => item.prompt_number)).toEqual([1, 2]);
    expect(prompts[0]?.prompt).toContain("auth redirect loop");
    expect(prompts[1]?.prompt).toContain("cookie domain");
  });

  test("insertUserPrompt deduplicates immediate duplicate prompt in a session", () => {
    const first = db.insertUserPrompt({
      session_id: "sess-1",
      project_id: projectId,
      prompt: "Review the startup memory output",
      cwd: "/tmp/repo",
      user_id: "david",
      device_id: "laptop-abc",
    });

    const second = db.insertUserPrompt({
      session_id: "sess-1",
      project_id: projectId,
      prompt: "Review the startup memory output",
      cwd: "/tmp/repo",
      user_id: "david",
      device_id: "laptop-abc",
    });

    expect(second.id).toBe(first.id);
    expect(db.getSessionUserPrompts("sess-1")).toHaveLength(1);
  });

  test("getRecentUserPrompts scopes by project and user", () => {
    db.insertUserPrompt({
      session_id: "sess-1",
      project_id: projectId,
      prompt: "Fix auth flow",
      cwd: "/tmp/repo",
      user_id: "david",
      device_id: "laptop-abc",
    });

    db.insertUserPrompt({
      session_id: "sess-2",
      project_id: projectId,
      prompt: "Alice private prompt",
      cwd: "/tmp/repo",
      user_id: "alice",
      device_id: "desktop-xyz",
    });

    const prompts = db.getRecentUserPrompts(projectId, 10, "david");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.prompt).toBe("Fix auth flow");
  });
});

describe("MemDatabase — tool events", () => {
  let projectId: number;

  beforeEach(() => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    projectId = project.id;
  });

  test("insertToolEvent stores raw tool chronology", () => {
    const first = db.insertToolEvent({
      session_id: "sess-tools",
      project_id: projectId,
      tool_name: "Edit",
      tool_input_json: "{\"file_path\":\"src/auth.ts\"}",
      tool_response_preview: "Edited src/auth.ts",
      file_path: "src/auth.ts",
      user_id: "david",
      device_id: "laptop-abc",
    });

    expect(first.id).toBeGreaterThan(0);
    expect(first.tool_name).toBe("Edit");
    expect(first.file_path).toBe("src/auth.ts");
  });

  test("getSessionToolEvents returns chronological order", () => {
    db.insertToolEvent({
      session_id: "sess-tools",
      project_id: projectId,
      tool_name: "Read",
      tool_response_preview: "Read config",
      user_id: "david",
      device_id: "laptop-abc",
      created_at_epoch: 100,
    });
    db.insertToolEvent({
      session_id: "sess-tools",
      project_id: projectId,
      tool_name: "Edit",
      tool_response_preview: "Edited config",
      user_id: "david",
      device_id: "laptop-abc",
      created_at_epoch: 200,
    });

    const events = db.getSessionToolEvents("sess-tools");
    expect(events.map((event) => event.tool_name)).toEqual(["Read", "Edit"]);
  });

  test("getRecentToolEvents scopes by project and user", () => {
    db.insertToolEvent({
      session_id: "sess-tools",
      project_id: projectId,
      tool_name: "Bash",
      command: "bun test",
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertToolEvent({
      session_id: "sess-tools-2",
      project_id: projectId,
      tool_name: "Bash",
      command: "npm run build",
      user_id: "alice",
      device_id: "desktop-xyz",
    });

    const events = db.getRecentToolEvents(projectId, 10, "david");
    expect(events).toHaveLength(1);
    expect(events[0]?.command).toBe("bun test");
  });
});

describe("MemDatabase — FTS5 search", () => {
  let projectId: number;

  beforeEach(() => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    projectId = project.id;

    db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Fix OAuth token refresh",
      narrative: "Token was expiring during long requests",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertObservation({
      project_id: projectId,
      type: "discovery",
      title: "Database connection pool exhaustion",
      narrative: "Pool was limited to 5 connections, needed 20",
      quality: 0.6,
      user_id: "david",
      device_id: "laptop-abc",
    });
  });

  test("searchFts finds by title keyword", () => {
    const results = db.searchFts("OAuth", projectId);
    expect(results.length).toBe(1);
  });

  test("searchFts finds by narrative keyword", () => {
    const results = db.searchFts("expiring", projectId);
    expect(results.length).toBe(1);
  });

  test("searchFts returns empty for no match", () => {
    const results = db.searchFts("nonexistent", projectId);
    expect(results.length).toBe(0);
  });

  test("searchFts scoped to project", () => {
    const otherProject = db.upsertProject({
      canonical_id: "github.com/other/repo",
      name: "other",
    });
    db.insertObservation({
      project_id: otherProject.id,
      type: "bugfix",
      title: "Fix OAuth in other project",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });

    const scoped = db.searchFts("OAuth", projectId);
    expect(scoped.length).toBe(1);

    const all = db.searchFts("OAuth", null);
    expect(all.length).toBe(2);
  });

  test("searchFts respects limit", () => {
    const results = db.searchFts("connection OR OAuth", projectId, undefined, 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test("searchFts hides personal observations from other users", () => {
    db.insertObservation({
      project_id: projectId,
      type: "decision",
      title: "Alice private OAuth note",
      narrative: "Private context",
      quality: 0.7,
      sensitivity: "personal",
      user_id: "alice",
      device_id: "desktop-xyz",
    });

    const results = db.searchFts("OAuth", projectId, undefined, 10, "david");
    expect(results.length).toBe(1);
  });
});

describe("MemDatabase — pin/unpin", () => {
  let projectId: number;

  beforeEach(() => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    projectId = project.id;
  });

  test("pin active observation", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "decision",
      title: "Use PostgreSQL",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop-abc",
    });
    expect(db.pinObservation(obs.id, true)).toBe(true);
    const updated = db.getObservationById(obs.id);
    expect(updated!.lifecycle).toBe("pinned");
  });

  test("unpin pinned observation", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "decision",
      title: "Use PostgreSQL",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.pinObservation(obs.id, true);
    expect(db.pinObservation(obs.id, false)).toBe(true);
    const updated = db.getObservationById(obs.id);
    expect(updated!.lifecycle).toBe("active");
  });

  test("cannot pin archived observation", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Old fix",
      quality: 0.5,
      lifecycle: "archived",
      user_id: "david",
      device_id: "laptop-abc",
    });
    expect(db.pinObservation(obs.id, true)).toBe(false);
  });

  test("cannot unpin non-pinned observation", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Fix",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });
    expect(db.pinObservation(obs.id, false)).toBe(false);
  });

  test("pin nonexistent observation returns false", () => {
    expect(db.pinObservation(99999, true)).toBe(false);
  });
});

describe("MemDatabase — sessions", () => {
  test("upsertSession creates new session", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    const session = db.upsertSession(
      "sess-001",
      project.id,
      "david",
      "laptop-abc"
    );
    expect(session.session_id).toBe("sess-001");
    expect(session.status).toBe("active");
    expect(session.observation_count).toBe(0);
  });

  test("upsertSession returns existing session", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    const first = db.upsertSession(
      "sess-001",
      project.id,
      "david",
      "laptop-abc"
    );
    const second = db.upsertSession(
      "sess-001",
      project.id,
      "david",
      "laptop-abc"
    );
    expect(second.id).toBe(first.id);
  });

  test("observation increments session count", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    db.upsertSession("sess-001", project.id, "david", "laptop-abc");

    db.insertObservation({
      session_id: "sess-001",
      project_id: project.id,
      type: "bugfix",
      title: "Fix",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });

    const updated = db.db
      .query<{ observation_count: number }, [string]>(
        "SELECT observation_count FROM sessions WHERE session_id = ?"
      )
      .get("sess-001");
    expect(updated!.observation_count).toBe(1);
  });

  test("completeSession sets status and timestamp", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    db.upsertSession("sess-001", project.id, "david", "laptop-abc");
    db.completeSession("sess-001");

    const session = db.db
      .query<{ status: string; completed_at_epoch: number | null }, [string]>(
        "SELECT status, completed_at_epoch FROM sessions WHERE session_id = ?"
      )
      .get("sess-001");
    expect(session!.status).toBe("completed");
    expect(session!.completed_at_epoch).not.toBeNull();
  });

  test("getRecentSessions returns session rollup with prompt/tool counts", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    db.upsertSession("sess-001", project.id, "david", "laptop-abc");
    db.insertUserPrompt({
      session_id: "sess-001",
      project_id: project.id,
      prompt: "Fix auth flow",
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertToolEvent({
      session_id: "sess-001",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "src/auth.ts",
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertSessionSummary({
      session_id: "sess-001",
      project_id: project.id,
      user_id: "david",
      request: "Fix auth flow",
      investigated: null,
      learned: null,
      completed: "Added retry",
      next_steps: null,
    });

    const sessions = db.getRecentSessions(project.id, 10, "david");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.prompt_count).toBe(1);
    expect(sessions[0]?.tool_event_count).toBe(1);
    expect(sessions[0]?.request).toBe("Fix auth flow");
  });
});

describe("MemDatabase — sync outbox", () => {
  test("addToOutbox creates entry", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    const obs = db.insertObservation({
      project_id: project.id,
      type: "bugfix",
      title: "Fix",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });

    // addToOutbox is called by insertObservation... but let's verify direct call
    db.addToOutbox("observation", obs.id);

    const entries = db.db
      .query<{ record_type: string; record_id: number; status: string }, []>(
        "SELECT record_type, record_id, status FROM sync_outbox ORDER BY id DESC LIMIT 1"
      )
      .get();
    expect(entries!.record_type).toBe("observation");
    expect(entries!.record_id).toBe(obs.id);
    expect(entries!.status).toBe("pending");
  });
});

describe("MemDatabase — sync state", () => {
  test("getSyncState returns null for missing key", () => {
    expect(db.getSyncState("nonexistent")).toBeNull();
  });

  test("setSyncState and getSyncState round-trip", () => {
    db.setSyncState("last_sync", "1234567890");
    expect(db.getSyncState("last_sync")).toBe("1234567890");
  });

  test("setSyncState overwrites existing", () => {
    db.setSyncState("key", "old");
    db.setSyncState("key", "new");
    expect(db.getSyncState("key")).toBe("new");
  });
});

describe("MemDatabase — timeline", () => {
  let projectId: number;

  beforeEach(() => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    projectId = project.id;
  });

  test("getTimeline returns context around anchor", () => {
    // Insert 5 observations with distinct epochs
    const ids: number[] = [];
    const baseEpoch = Math.floor(Date.now() / 1000) - 100;
    for (let i = 0; i < 5; i++) {
      const result = db.db
        .query(
          `INSERT INTO observations (project_id, type, title, quality, lifecycle, sensitivity, user_id, device_id, agent, created_at, created_at_epoch)
           VALUES (?, 'bugfix', ?, 0.5, 'active', 'shared', 'david', 'laptop-abc', 'claude-code', ?, ?)`
        )
        .run(projectId, `Fix ${i}`, new Date((baseEpoch + i) * 1000).toISOString(), baseEpoch + i);
      ids.push(Number(result.lastInsertRowid));
    }

    const timeline = db.getTimeline(ids[2]!, projectId, 2, 2);
    expect(timeline.length).toBe(5); // 2 before + anchor + 2 after
    const anchorIdx = timeline.findIndex((o) => o.id === ids[2]);
    expect(anchorIdx).toBe(2); // middle position
  });

  test("getTimeline returns empty for nonexistent anchor", () => {
    const timeline = db.getTimeline(99999, projectId);
    expect(timeline).toEqual([]);
  });

  test("getTimeline hides personal anchors from other users", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "decision",
      title: "Private implementation note",
      quality: 0.8,
      sensitivity: "personal",
      user_id: "alice",
      device_id: "desktop-xyz",
    });

    const timeline = db.getTimeline(obs.id, projectId, 1, 1, "david");
    expect(timeline).toEqual([]);
  });
});

describe("MemDatabase — session summaries", () => {
  let projectId: number;

  beforeEach(() => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    projectId = project.id;
  });

  test("insertSessionSummary creates and returns summary", () => {
    const summary = db.insertSessionSummary({
      session_id: "sess-001",
      project_id: projectId,
      user_id: "david",
      request: "Fix auth bug",
      investigated: "- Checked token flow",
      learned: "- Token refresh was missing",
      completed: "- Added refresh logic",
      next_steps: null,
    });
    expect(summary.id).toBeGreaterThan(0);
    expect(summary.session_id).toBe("sess-001");
    expect(summary.request).toBe("Fix auth bug");
  });

  test("getSessionSummary retrieves by session_id", () => {
    db.insertSessionSummary({
      session_id: "sess-002",
      project_id: projectId,
      user_id: "david",
      request: "Add feature",
      investigated: null,
      learned: null,
      completed: "- Done",
      next_steps: null,
    });
    const found = db.getSessionSummary("sess-002");
    expect(found).not.toBeNull();
    expect(found!.request).toBe("Add feature");
  });

  test("getSessionSummary returns null for missing", () => {
    expect(db.getSessionSummary("nonexistent")).toBeNull();
  });

  test("getRecentSummaries returns summaries ordered by most recent", () => {
    db.insertSessionSummary({
      session_id: "sess-a",
      project_id: projectId,
      user_id: "david",
      request: "First",
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
    });
    db.insertSessionSummary({
      session_id: "sess-b",
      project_id: projectId,
      user_id: "david",
      request: "Second",
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
    });
    const recent = db.getRecentSummaries(projectId, 2);
    expect(recent.length).toBe(2);
    // Both inserted in same epoch; order by id desc (second has higher id)
    expect(recent[0]!.id).toBeGreaterThan(recent[1]!.id);
  });
});

describe("MemDatabase — session metrics", () => {
  let projectId: number;

  beforeEach(() => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    projectId = project.id;
    db.upsertSession("sess-metrics", projectId, "david", "laptop-abc");
  });

  test("incrementSessionMetrics increments tool_calls_count", () => {
    db.incrementSessionMetrics("sess-metrics", { toolCalls: 1 });
    db.incrementSessionMetrics("sess-metrics", { toolCalls: 3 });
    const metrics = db.getSessionMetrics("sess-metrics");
    expect(metrics).not.toBeNull();
    expect(metrics!.tool_calls_count).toBe(4);
  });

  test("incrementSessionMetrics increments files_touched_count", () => {
    db.incrementSessionMetrics("sess-metrics", { files: 2 });
    const metrics = db.getSessionMetrics("sess-metrics");
    expect(metrics!.files_touched_count).toBe(2);
  });

  test("incrementSessionMetrics increments multiple fields", () => {
    db.incrementSessionMetrics("sess-metrics", { files: 1, toolCalls: 5, searches: 2 });
    const metrics = db.getSessionMetrics("sess-metrics");
    expect(metrics!.files_touched_count).toBe(1);
    expect(metrics!.tool_calls_count).toBe(5);
    expect(metrics!.searches_performed).toBe(2);
  });

  test("getSessionMetrics returns null for missing session", () => {
    expect(db.getSessionMetrics("nonexistent")).toBeNull();
  });
});

describe("MemDatabase — security findings", () => {
  let projectId: number;

  beforeEach(() => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    projectId = project.id;
  });

  test("insertSecurityFinding creates finding", () => {
    const finding = db.insertSecurityFinding({
      session_id: "sess-001",
      project_id: projectId,
      finding_type: "api_key",
      severity: "critical",
      pattern_name: "OpenAI API keys",
      snippet: "...key=[REDACTED_API_KEY]...",
      tool_name: "Edit",
      user_id: "david",
      device_id: "laptop-abc",
    });
    expect(finding.id).toBeGreaterThan(0);
    expect(finding.finding_type).toBe("api_key");
    expect(finding.severity).toBe("critical");
  });

  test("getSecurityFindings returns findings for project", () => {
    db.insertSecurityFinding({
      project_id: projectId,
      finding_type: "api_key",
      severity: "critical",
      pattern_name: "AWS access keys",
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertSecurityFinding({
      project_id: projectId,
      finding_type: "password",
      severity: "high",
      pattern_name: "Passwords in config",
      user_id: "david",
      device_id: "laptop-abc",
    });

    const all = db.getSecurityFindings(projectId);
    expect(all.length).toBe(2);

    const critical = db.getSecurityFindings(projectId, { severity: "critical" });
    expect(critical.length).toBe(1);
    expect(critical[0]!.finding_type).toBe("api_key");
  });

  test("getSecurityFindingsCount returns counts by severity", () => {
    db.insertSecurityFinding({
      project_id: projectId,
      finding_type: "api_key",
      severity: "critical",
      pattern_name: "AWS",
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertSecurityFinding({
      project_id: projectId,
      finding_type: "password",
      severity: "high",
      pattern_name: "Passwords",
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertSecurityFinding({
      project_id: projectId,
      finding_type: "password",
      severity: "high",
      pattern_name: "Passwords",
      user_id: "david",
      device_id: "laptop-abc",
    });

    const counts = db.getSecurityFindingsCount(projectId);
    expect(counts["critical"]).toBe(1);
    expect(counts["high"]).toBe(2);
    expect(counts["medium"]).toBe(0);
    expect(counts["low"]).toBe(0);
  });
});

describe("MemDatabase — observations by session", () => {
  test("getObservationsBySession returns session observations", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    db.upsertSession("sess-obs", project.id, "david", "laptop-abc");

    db.insertObservation({
      session_id: "sess-obs",
      project_id: project.id,
      type: "bugfix",
      title: "Fix 1",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertObservation({
      session_id: "sess-obs",
      project_id: project.id,
      type: "change",
      title: "Change 1",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertObservation({
      session_id: "other-sess",
      project_id: project.id,
      type: "discovery",
      title: "Other session",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });

    const results = db.getObservationsBySession("sess-obs");
    expect(results.length).toBe(2);
    expect(results[0]!.title).toBe("Fix 1");
  });
});

describe("MemDatabase — FTS delete", () => {
  test("ftsDelete removes from search index", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/org/repo",
      name: "repo",
    });
    const obs = db.insertObservation({
      project_id: project.id,
      type: "bugfix",
      title: "Unique searchable term xyzzy",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });

    // Should find it
    let results = db.searchFts("xyzzy", project.id);
    expect(results.length).toBe(1);

    // Delete from FTS
    db.ftsDelete(obs);

    // Should not find it
    results = db.searchFts("xyzzy", project.id);
    expect(results.length).toBe(0);
  });
});
