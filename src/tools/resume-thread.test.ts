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
      next_steps:
        "Verify only explicit notification events appear in the events page.\nExpose the rule path to chat for follow-up questions.",
      current_thread: "Review EventService routing and explicit notifications",
      recent_tool_names: JSON.stringify(["Edit", "Bash"]),
      hot_files: JSON.stringify(["AIServer/app/services/eventservice.py", "AIServer/app/routers/events.py"]),
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
    expect(result.resume_freshness).toBe("live");
    expect(result.resume_source_session_id).toBe("sess-1");
    expect(result.resume_source_device_id).toBe("laptop");
    expect(result.resume_confidence).toBe("strong");
    expect(result.resume_basis).toContain("explicit handoff available");
    expect(result.resume_basis).toContain("current thread recovered");
    expect(result.resume_basis).toContain("recent tool trail available");
    expect(result.resume_basis).toContain("next actions available");
    expect(result.best_recall_key).toBe("handoff:1");
    expect(result.best_recall_kind).toBe("handoff");
    expect(result.best_recall_title).toContain("Resume EventService notification routing");
    expect(result.current_thread).toContain("EventService");
    expect(result.latest_request).toContain("EventService");
    expect(result.handoff?.title).toContain("Handoff:");
    expect(result.tool_trail).toEqual(["Edit", "Bash"]);
    expect(result.next_actions[0]).toContain("Verify only explicit notification events appear");
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
    expect(result.resume_source_session_id).toBe("sess-2");
    expect(result.resume_source_device_id).toBe("desktop");
    expect(result.resume_confidence).toBe("usable");
    expect(result.chat_coverage_state).toBe("history-backed");
    expect(result.resume_basis).toContain("history-backed chat continuity");
    expect(result.best_recall_key).toBe("session:sess-2");
    expect(result.best_recall_kind).toBe("thread");
    expect(result.suggested_tools).toContain("repair_recall");
    expect(result.suggested_tools).toContain("load_recall_item");
    expect(result.suggested_tools).toContain("refresh_chat_recall");
  });

  test("can resume a specific agent thread when multiple agents are active", async () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.upsertSession("claude-sess", project.id, "david", "laptop", "claude-code");
    db.insertSessionSummary({
      session_id: "claude-sess",
      project_id: project.id,
      user_id: "david",
      request: "Review Claude-side event routing",
      investigated: null,
      learned: null,
      completed: "Claude routing notes captured",
      next_steps: "Verify the Claude recall path still prefers the handoff.",
      current_thread: "Review Claude-side event routing",
    });
    db.insertChatMessage({
      session_id: "claude-sess",
      project_id: project.id,
      role: "assistant",
      content: "Claude still needs the explicit handoff to win the resume flow.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
    });
    db.insertObservation({
      session_id: "claude-sess",
      project_id: project.id,
      type: "message",
      title: "Handoff: Resume Claude-side event routing · 2026-03-24 18:20Z",
      narrative: "Current thread: Review Claude-side event routing",
      concepts: JSON.stringify(["handoff", "session-handoff"]),
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
      source_tool: "create_handoff",
    });

    db.upsertSession("codex-sess", project.id, "david", "desktop", "codex-cli");
    db.insertSessionSummary({
      session_id: "codex-sess",
      project_id: project.id,
      user_id: "david",
      request: "Audit Codex-side event routing",
      investigated: null,
      learned: null,
      completed: null,
      next_steps: "Verify the Codex resume flow stays separate.",
      current_thread: "Audit Codex-side event routing",
    });
    db.insertChatMessage({
      session_id: "codex-sess",
      project_id: project.id,
      role: "assistant",
      content: "Codex is following a different routing thread here.",
      user_id: "david",
      device_id: "desktop",
      agent: "codex-cli",
      source_kind: "transcript",
      transcript_index: 1,
    });

    const result = await resumeThread(db, {
      user_id: "david",
      device_id: "desktop",
    } as any, {
      cwd: "/tmp/repo",
      user_id: "david",
      current_device_id: "desktop",
      agent: "claude-code",
    });

    expect(result.target_agent).toBe("claude-code");
    expect(result.resume_source_session_id).toBe("claude-sess");
    expect(result.resume_source_device_id).toBe("laptop");
    expect(result.best_recall_key).toBe("handoff:1");
    expect(result.best_recall_kind).toBe("handoff");
    expect(result.current_thread).toContain("Claude-side event routing");
    expect(result.recent_chat.every((item) => item.content.includes("Claude") || item.content.includes("handoff"))).toBe(true);
  });
});
