# Changelog

All notable changes to this repository should be documented here.

## Unreleased

## 0.4.8

### Added

- first-class local prompt chronology capture via Claude `UserPromptSubmit`
- first-class local tool chronology capture via `PostToolUse`
- new local MCP inspection tools:
  - `capture_status`
  - `activity_feed`
  - `memory_console`
  - `project_memory_index`
  - `workspace_memory_index`
  - `recent_requests`
  - `recent_tools`
  - `recent_sessions`
  - `session_story`
- public Engrm plugin spec and initial plugin foundation for memory-aware integrations

### Changed

- startup context now includes recent requests, recent tools, recent session rollups, and project signal counts
- local sync summaries now carry prompt/tool capture metadata for downstream hosted surfaces
- CLI `status` and `doctor` now show whether raw chronology capture is actually active on the machine
- public/default server URL is now `https://engrm.dev`, with legacy public Candengo hosts normalized automatically
- CLI connectivity and auth validation now use API-key-compatible Engrm endpoints instead of the broken `/v1/account/me` check

## 0.4.7

### Added

- structured fact derivation during observation capture so useful facts are saved even when the agent does not provide them explicitly
- session value signals and session insights for decisions, lessons, discoveries, completed work, next steps, and delivery-review readiness

### Changed

- startup briefs and local context injection now prioritize higher-value memory objects over generic digest/blob entries
- local search now boosts exact title and fact matches and returns richer top-hit previews
- retrospective extraction produces stronger `Request`, `Learned`, `Completed`, and `Next Steps` sections with less file-operation noise
- sync summary payloads now include richer section items and value-signal metadata for downstream dashboard use
- `engrm status` and `memory_stats` now surface recent lessons, completed work, next steps, and summary coverage instead of only raw counts

## 0.4.6

### Added

- MCP Registry packaging metadata via `mcpName` and `server.json`

### Changed

- npm package description now leads with shared memory across devices, sessions, and coding agents
- prepared Engrm for official MCP Registry publishing
## 0.4.5

### Changed

- Claude `SessionStart` startup brief now picks the richest recent session summary, deduplicates repeated clauses, and suppresses irrelevant stale-decision warnings

## 0.4.4

### Changed

- Claude `SessionStart` splash now shows a visible startup brief with `Learned`, `Completed`, `Next Steps`, and a `Watch` line instead of only the thin status banner

## 0.4.3

### Added

- packaged OpenClaw skill bundles for `engrm-memory`, `engrm-delivery-review`, and `engrm-sentinel`
- packaged Codex / OpenAI skill bundles for `engrm-memory`, `engrm-delivery-review`, and `engrm-sentinel`
- submission guides for ClawHub and OpenAI skills registries

### Changed

- improved startup context injection so new sessions receive denser project briefs with `Investigated`, `Learned`, `Completed`, and `Next Steps`
- updated the public agent support docs and roadmap to reflect the current launch surface

### Added

- Codex MCP registration and hook registration
- Codex `SessionStart` and `Stop` integration
- `send_message`, `recent_activity`, and `memory_stats` MCP tools
- public agent support matrix in [AGENT_SUPPORT.md](AGENT_SUPPORT.md)
- GitHub publish-readiness docs and CI scaffolding

### Changed

- README now documents Claude Code and Codex support separately
- recent activity now shows project attribution for cross-project views
- `message` observations now pass quality scoring as intended

## 0.4.2

### Added

- Codex MCP registration and `SessionStart` / `Stop` hook support
- `send_message`, `recent_activity`, and `memory_stats` MCP tools
- public repo guardrails for docs and internal-note hygiene

### Changed

- fixed visibility filtering for personal observations across retrieval paths
- preserved remote timestamps and sensitivity during pull sync
- cleaned the public repository surface and documentation for release
- clarified that npm users run Engrm on Node.js without needing Bun installed
