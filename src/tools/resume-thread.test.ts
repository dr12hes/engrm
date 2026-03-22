import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { resumeThread } from "./resume-thread.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-resume-thread-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("resumeThread", () => {
  test("prefers explicit handoff and recent recall for the current project", async () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.upsertSession("sess-1", project.id, "david", "laptop", "claude-code");
    db.insertSessionSummary({
      session_id: "sess-1",
      project_id: project.id,
      user_id: "david",
      request: "Review EventService routing and explicit notifications",
      investigated: null,
      learned: null,
      completed: "Wired the explicit event list into the events page",
      next_steps: null,
      current_thread: "Review EventService routing and explicit notifications",
    });
    db.insertUserPrompt({
      session_id: "sess-1",
      project_id: project.id,
      prompt: "please review eventservice as a thought we had addressed that issue",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertChatMessage({
      session_id: "sess-1",
      project_id: project.id,
      role: "user",
      content: "We want only explicit notification events to appear in the events page.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "message",
      title: "Handoff: Resume EventService notification routing · 2026-03-22 18:20Z",
      narrative: "Current thread: Review EventService routing and explicit notifications",
      concepts: JSON.stringify(["handoff", "session-handoff"]),
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
      source_tool: "create_handoff",
    });

    const result = await resumeThread(db, {
      user_id: "david",
      device_id: "desktop",
    } as any, {
      cwd: "/tmp/repo",
      user_id: "david",
      current_device_id: "desktop",
    });

    expect(result.project_name).toBe("repo");
    expect(result.repair_attempted).toBe(false);
    expect(result.resume_confidence).toBe("strong");
    expect(result.resume_basis).toContain("explicit handoff available");
    expect(result.resume_basis).toContain("current thread recovered");
    expect(result.current_thread).toContain("EventService");
    expect(result.latest_request).toContain("EventService");
    expect(result.handoff?.title).toContain("Handoff:");
    expect(result.chat_coverage_state).toBe("transcript-backed");
    expect(result.recent_chat[0]?.content).toContain("explicit notification events");
    expect(result.recall_hits.length).toBeGreaterThan(0);
    expect(result.suggested_tools).toContain("search_recall");
    expect(result.suggested_tools).toContain("load_handoff");
  });

  test("suggests recall repair when chat continuity is only partial", async () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.upsertSession("sess-2", project.id, "david", "desktop", "claude-code");
    db.insertSessionSummary({
      session_id: "sess-2",
      project_id: project.id,
      user_id: "david",
      request: "Pick back up the OpenClaw routing thread",
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      current_thread: "Pick back up the OpenClaw routing thread",
    });
    db.insertChatMessage({
      session_id: "sess-2",
      project_id: project.id,
      role: "assistant",
      content: "We still need to check the OpenClaw event routing assumptions.",
      user_id: "david",
      device_id: "desktop",
      agent: "claude-code",
      source_kind: "hook",
      remote_source_id: "history:sess-2:123:abc",
    });

    const result = await resumeThread(db, {
      user_id: "david",
      device_id: "desktop",
    } as any, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.repair_attempted).toBe(true);
    expect(result.repair_result).not.toBeNull();
    expect(result.resume_confidence).toBe("usable");
    expect(result.chat_coverage_state).toBe("history-backed");
    expect(result.resume_basis).toContain("history-backed chat continuity");
    expect(result.suggested_tools).toContain("repair_recall");
    expect(result.suggested_tools).toContain("refresh_chat_recall");
  });
});
