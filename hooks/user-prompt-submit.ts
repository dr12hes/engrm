#!/usr/bin/env bun
/**
 * UserPromptSubmit hook for Claude Code.
 *
 * Captures the raw user request before Claude processes it so Engrm can
 * reconstruct prompt chronology, startup intent, and project history.
 *
 * This hook never blocks the prompt. It stores silently and exits 0.
 */

import { detectProject } from "../src/storage/projects.js";
import { parseStdinJson, bootstrapHook, runHook } from "../src/hooks/common.js";

interface UserPromptSubmitEvent {
  session_id: string;
  hook_event_name: string;
  cwd: string;
  prompt: string;
}

async function main(): Promise<void> {
  const event = await parseStdinJson<UserPromptSubmitEvent>();
  if (!event?.prompt?.trim()) process.exit(0);

  const boot = bootstrapHook("user-prompt-submit");
  if (!boot) process.exit(0);

  const { config, db } = boot;

  try {
    const detected = detectProject(event.cwd);
    const project = db.upsertProject({
      canonical_id: detected.canonical_id,
      name: detected.name,
      local_path: event.cwd,
      remote_url: detected.remote_url ?? null,
    });

    db.upsertSession(
      event.session_id,
      project.id,
      config.user_id,
      config.device_id,
      "claude-code"
    );

    db.insertUserPrompt({
      session_id: event.session_id,
      project_id: project.id,
      prompt: event.prompt,
      cwd: event.cwd,
      user_id: config.user_id,
      device_id: config.device_id,
      agent: "claude-code",
    });

    const compactPrompt = event.prompt.replace(/\s+/g, " ").trim();
    if (compactPrompt.length >= 8) {
      const summary = db.upsertSessionSummary({
        session_id: event.session_id,
        project_id: project.id,
        user_id: config.user_id,
        request: compactPrompt,
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
      });
      db.addToOutbox("summary", summary.id);
    }
  } finally {
    db.close();
  }
}

runHook("user-prompt-submit", main);
