# Changelog

All notable changes to this repository should be documented here.

## Unreleased

### Added

- `activity_feed` now includes the separate chat lane as first-class `chat` events in both project-scoped and session-scoped chronology views

### Changed

- MCP docs and examples now describe `activity_feed` as the merged continuity surface across prompts, tools, chat, handoffs, observations, and summaries
- injected session context can now carry a compact `Recent Chat` section for the current project, so cross-device resume has conversational continuity as well as reduced memory
- startup handoff can now fall back to a compact `Chat trail` when recent prompt lines are absent, so thin in-flight sessions still read like a live coworker update
- `create_handoff` now auto-includes a few chat snippets for thin sessions, while keeping already-rich sessions terse unless chat is explicitly requested
- startup `Next look` hints now point at `load_handoff` and `recent_chat` when Engrm already knows those continuity lanes are available

## 0.4.23

### Added

- explicit handoff MCP tools:
  - `create_handoff`
  - `recent_handoffs`
  - `load_handoff`
- explicit handoffs are stored as syncable `message` observations so they can move across devices immediately
- `session_story` now separates explicit handoffs from reusable observations
- `activity_feed` now surfaces explicit handoffs as first-class feed events

### Changed

- startup handoff can now surface the latest explicit saved handoff as a resume cue
- the local workbench now suggests handoff tools alongside the existing inspection flow
- chat lane messages are now queued for sync and can be pulled into another device's local chat store
- fresh and mixed installs now self-heal chat sync support, including `chat_messages.remote_source_id` and `sync_outbox` support for `chat_message` records

## 0.4.22

### Added

- rolling session handoff cues are now persisted during the session from both prompt-time and tool-time updates using a shared session-handoff builder

### Changed

- stop-hook summaries now upsert into the same session summary record instead of overwriting rolling handoff metadata
- mixed old installs now self-heal missing `session_summaries` handoff columns on startup
- startup and assistant checkpoint extraction now suppress more weak wrapper lines like `All clean...`, `Here's the real picture`, and `TL;DR`
- this makes Engrm's startup handoff more resilient across upgrades and more representative of the actual current work thread

## 0.4.21

### Added

- synced session summaries now retain lightweight handoff metadata:
  - `capture_state`
  - `recent_tool_names`
  - `hot_files`
  - `recent_outcomes`

### Changed

- remote summary docs pulled from another device now hydrate local handoff cues instead of only the plain `request / completed` text
- startup handoff can now fall back to synced `recent_tool_names` and `recent_outcomes` when local raw tool chronology is missing
- this improves live-ish multi-device continuity by making another machine feel more current even before it has the originating device's raw local tool/event tables

## 0.4.20

### Added

- live high-signal observations can now update the rolling session summary during `PostToolUse`, so in-flight sessions have a better chance of sharing meaningful "what moved" context across devices before stop

### Changed

- rolling session summaries now ignore low-signal file-op titles like `Modified foo.ts` when promoting live observations into handoff memory
- this improves the multi-device handoff path by letting strong `feature`, `bugfix`, `change`, `refactor`, `discovery`, and `decision` observations enrich the current session summary as work happens

## 0.4.19

### Changed

- final assistant output can now contribute full structured `Investigated`, `Learned`, `Completed`, and `Next Steps` sections to the session summary instead of being flattened into a thin checkpoint
- generic assistant status phrases like `Here's where things stand` are no longer used as checkpoint titles
- startup handoff `Pull detail` IDs now match the actual visible handoff-index rows
- this improves the quality and trustworthiness of startup handoff by preserving richer recent work instead of showing vague status wrappers

## 0.4.18

### Added

- rolling prompt-time session summary updates, so a live session can publish what it is about before it ends

### Changed

- remote summary documents pulled from Vector now upsert local `session_summaries`, so summaries created on another device actually land in the local handoff path
- repeated remote summary updates are no longer blocked just because the related observation copy was already imported
- this improves Engrm's multi-device promise by making recent session intent and summaries more likely to appear across devices during active work, not just after a perfect local capture sequence

## 0.4.17

### Changed

- stop-hook session summaries now create a fallback summary from recent prompts and assistant checkpoints when heuristic observation capture is thin
- assistant checkpoints are now created before retrospective summary generation, so recent delivered work is more likely to appear in the same session summary
- this improves the multi-device handoff path by ensuring recent sessions leave behind shared summary memory instead of disappearing when they produce no other observations

## 0.4.16

### Added

- public MCP starter-set documentation and examples for:
  - `capture_git_worktree`
  - `capture_repo_scan`
  - `capture_openclaw_content`
  - `tool_memory_index`
  - `capture_quality`
- `MCP_EXAMPLES.md` with concrete starter flows, reducer outputs, and demo prompts
- reusable MCP listing/submission copy in `ECOSYSTEM_LISTINGS.md`

### Changed

- startup handoff index now prefers fresher, stronger items instead of surfacing stale decisions too aggressively
- startup handoff index now collapses near-duplicate titles instead of only exact string matches
- public MCP metadata in `server.json` now matches the current package version and positioning

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
