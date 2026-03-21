# Changelog

All notable changes to this repository should be documented here.

## Unreleased

## 0.4.15

### Changed

- startup splash now reads more like a teammate handoff than a memory banner
- startup labels are more conversational and work-oriented:
  - `Handoff`
  - `Asked recently`
  - `What you're on`
  - `What's moved`
  - `Tool trail`
  - `Recent threads`
  - `Signal mix`
  - `Next look`
  - `Pull detail`
- startup glyphs now use a more console-like Engrm style instead of emoji-style markers:
  - `■` bugfix
  - `▲` feature
  - `≈` refactor
  - `●` change
  - `□` discovery
  - `◇` decision

## 0.4.14

### Added

- startup splash now behaves more like a real memory index:
  - type legend
  - compact context index with IDs and file hints
  - explicit fetch-by-ID hint for deeper inspection

### Changed

- startup context economics now includes loaded observation count as well as estimated read cost
- startup presentation is now better aligned with the thin-tool memory workbench and local inspection flow

## 0.4.13

### Added

- lightweight thin-tool MCP capture flows for:
  - `capture_git_worktree`
  - `capture_repo_scan`
  - `capture_openclaw_content`
- tool-centric local inspection:
  - `tool_memory_index`
  - `session_tool_memory`
- plugin-aware inspection in local memory tools so Engrm can show which plugins are actually producing durable memory
- assistant checkpoint typing in local capture quality views so `assistant-stop` memory is separated into decisions, delivered changes, and generic changes more honestly

### Changed

- local workbench suggestions now point users toward thin capture tools when a repo has enough signal to justify them
- `capture_quality`, `project_memory_index`, `memory_console`, and `session_context` now expose a much clearer picture of which tools and plugins are paying their way
- plugin-produced memory is now visible in both workspace-level and session-level tool inspection, not just buried in observation concepts

## 0.4.12

### Changed

- fixed sqlite-vec loading on macOS/Bun installs by passing the underlying `better-sqlite3` handle to `sqlite-vec`, so `engrm doctor` and local semantic search correctly detect embeddings on Macs using the wrapped database adapter

## 0.4.11

### Added

- richer session-context and summary-sync metadata:
  - `capture_state`
  - `recent_request_prompts`
  - `recent_tool_commands`
  - `recent_outcomes`
  - `hot_files`

### Changed

- startup context now suppresses fake repeated next steps and only shows recent tools when they add new information
- retrospective extraction no longer promotes already-completed work into `Next Steps`
- legacy Engrm databases now infer schema version from existing columns/tables so mixed old installs recover cleanly instead of failing duplicate-column migrations
- summary sync payloads and local session inspection tools now expose richer chronology and file/outcome signals for hosted Briefs/dashboard surfaces

## 0.4.10

### Added

- capture-state diagnostics for local session inspection:
  - `rich`
  - `partial`
  - `summary-only`
  - `legacy`
- `recent_sessions` and `session_story` now report capture quality and missing chronology gaps
- `capture_status`, `status`, and `doctor` now surface partial raw chronology instead of treating capture as only on/off
- lightweight `PostToolUse` diagnostics now record the latest hook timestamp, parse status, and tool name

### Changed

- startup context now suppresses duplicate current-request lines and surfaces recent repo outcomes more prominently
- injected project memory now includes recent outcomes and hides malformed prompt fragments and empty recent-session shells
- project memory consoles and indexes now surface higher-signal recent outcomes instead of weak file-operation titles
- git-aware project attribution is used more consistently so new captures follow the repo owning touched files
- `PostToolUse` now persists raw tool chronology before slower observer work, keeping tool-event capture reliable
- inline observer work is limited to higher-value tool types and uses the SDK timeout so normal `Edit`/`Write` hooks stay fast
- sync pull now tolerates remote `summary` and missing-type records instead of crashing local pull

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
