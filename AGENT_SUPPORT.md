# Agent Support

This file is the source of truth for Engrm's current agent integration surface.

## Current State

Engrm now supports Claude Code and Codex as first-class direct integrations, and OpenClaw through packaged skill bundles.

Claude Code remains the deepest integration because its public hooks surface exposes:
- session start
- pre-tool use
- post-tool use
- pre-compact
- elicitation result
- stop

Codex now supports:
- MCP tool access
- session-start context injection
- stop/session summary hooks

Codex does not yet expose the same public lifecycle hook surface as Claude Code, so some features remain Claude-only for now.

OpenClaw currently uses skills rather than direct native hooks:
- `engrm-memory`
- `engrm-delivery-review`
- `engrm-sentinel`

That means OpenClaw can use Engrm's MCP and workflow guidance today, but it does not yet have native hook parity with Claude Code.

Important distinction:
- OpenClaw is still expected to use direct Engrm MCP write tools like
  `save_observation`, `create_handoff`, `refresh_handoff`, and
  `capture_openclaw_content` when something should be preserved deliberately.
- End-of-session digest capture is a helpful background path, not the only save
  mechanism.

## Feature Matrix

| Capability | Claude Code | Codex | OpenClaw | Notes |
|---|---|---|---|---|
| MCP server registration | ✓ | ✓ | Via skills / MCP | `engrm init` auto-registers Claude + Codex |
| Session-start memory injection | ✓ | ✓ | Skill-guided | Native in Claude/Codex, workflow-guided in OpenClaw |
| Stop hook / session digest | ✓ | ✓ | Skill-guided | Codex uses `hooks/codex-stop.ts` wrapper |
| Manual save/search/timeline tools | ✓ | ✓ | ✓ | Shared via MCP |
| Cross-device/team notes (`send_message`) | ✓ | ✓ | ✓ | Shared via MCP |
| Capture visibility (`recent_activity`) | ✓ | ✓ | ✓ | Shared via MCP |
| Memory health stats (`memory_stats`) | ✓ | ✓ | ✓ | Shared via MCP |
| Thin capture tools (`capture_git_worktree`, `capture_repo_scan`, `capture_openclaw_content`) | ✓ | ✓ | Via skills / MCP | Same MCP tools, different workflow entry points |
| Per-tool automatic observation capture | ✓ | Partial | Partial | Full in Claude hooks; others rely on public surfaces |
| Sentinel pre-write auditing | ✓ | No | No | Public hook surfaces do not expose pre-write interception |
| Pre-compact memory reinjection | ✓ | No | No | Not exposed outside Claude Code today |
| Elicitation result capture | ✓ | No | No | No public equivalent today |

## What Changed In This Pass

Implemented:
- Codex MCP registration in `~/.codex/config.toml`
- Codex `SessionStart` and `Stop` hook registration in `~/.codex/hooks.json`
- OpenClaw skill bundles in `openclaw/skills/`
- non-fatal independent registration so Claude can succeed without Codex and vice versa
- transcript-path-aware stop flow so Codex stop events can feed transcript analysis correctly
- trust and collaboration MCP tools:
  - `send_message`
  - `recent_activity`
  - `memory_stats`

Improved:
- cross-project recent activity now includes project attribution
- `message` observations now meet the quality threshold as intended
- cross-agent validation now has a dedicated MCP surface via `agent_memory_index`, so Claude Code, Codex, and OpenClaw-style sessions can be compared directly on the same repo

## Honest Website Copy

Safe claims now:
- "Works with Claude Code, Codex, OpenCode, and OpenClaw workflows"
- "Automatic session-start memory injection in Claude Code and Codex"
- "Automatic end-of-session summaries in Claude Code and Codex"
- "OpenCode support is available through Engrm MCP plus a local continuity plugin"
- "OpenClaw support is available through Engrm skills"
- "Deep automatic tool-level capture and Sentinel auditing in Claude Code"
- "Codex support currently includes MCP, session-start memory, and stop/session summaries"
- "Engrm can compare continuity and capture quality across agents on the same project"

Claims to reserve until supported:
- "Full Claude parity in Codex"
- "Real-time Codex Sentinel blocking"
- "Per-tool automatic Codex capture"

## Remaining Gaps To Close

What improved in this pass:
- trust layer: users can now inspect recent capture and memory health
- collaboration depth: users can now send cross-device or team notes through MCP

Still to add:
- review/publish workflow for shared observations
- memory correction / moderation UX
- richer team dashboards and knowledge-health metrics
- measurable evals proving Engrm improved coding outcomes
- deeper OpenCode-native capture beyond compaction/session continuity
