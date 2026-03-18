# Agent Support

This file is the source of truth for Engrm's current agent integration surface.

## Current State

Engrm now supports both Claude Code and Codex as first-class integrations.

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

## Feature Matrix

| Capability | Claude Code | Codex | Notes |
|---|---|---|---|
| MCP server registration | ✓ | ✓ | Auto-registered by `engrm init` |
| Session-start memory injection | ✓ | ✓ | Uses native hook in both agents |
| Stop hook / session digest | ✓ | ✓ | Codex uses `hooks/codex-stop.ts` wrapper |
| Manual save/search/timeline tools | ✓ | ✓ | Shared via MCP |
| Cross-device/team notes (`send_message`) | ✓ | ✓ | Shared via MCP |
| Capture visibility (`recent_activity`) | ✓ | ✓ | Shared via MCP |
| Memory health stats (`memory_stats`) | ✓ | ✓ | Shared via MCP |
| Per-tool automatic observation capture | ✓ | Partial | Full in Claude hooks, not publicly exposed in Codex hooks |
| Sentinel pre-write auditing | ✓ | No | Codex public hooks do not expose pre-write interception |
| Pre-compact memory reinjection | ✓ | No | Codex public hooks do not expose compaction lifecycle |
| Elicitation result capture | ✓ | No | No public Codex equivalent today |

## What Changed In This Pass

Implemented:
- Codex MCP registration in `~/.codex/config.toml`
- Codex `SessionStart` and `Stop` hook registration in `~/.codex/hooks.json`
- non-fatal independent registration so Claude can succeed without Codex and vice versa
- transcript-path-aware stop flow so Codex stop events can feed transcript analysis correctly
- trust and collaboration MCP tools:
  - `send_message`
  - `recent_activity`
  - `memory_stats`

Improved:
- cross-project recent activity now includes project attribution
- `message` observations now meet the quality threshold as intended

## Honest Website Copy

Safe claims now:
- "Works with Claude Code and Codex"
- "Automatic session-start memory injection in Claude Code and Codex"
- "Automatic end-of-session summaries in Claude Code and Codex"
- "Deep automatic tool-level capture and Sentinel auditing in Claude Code"
- "Codex support currently includes MCP, session-start memory, and stop/session summaries"

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
