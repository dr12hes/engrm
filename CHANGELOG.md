# Changelog

All notable changes to this repository should be documented here.

## Unreleased

- aligned `server.json` and public metadata with Engrm's real MCP surface, so registries and installers no longer imply stdio-only support when Hermes-ready remote HTTP is available too

## 0.4.42

- fixed the Hermes HTTP handshake by making Engrm’s `/mcp` endpoint compatible with SSE-style MCP clients as well as Streamable HTTP, so Hermes no longer fails to connect with `400 Bad Request` during initial negotiation
- surfaced OpenClaw MCP registration in `engrm status`, `engrm doctor`, and `capture_status`, so the native plugin and the newer OpenClaw MCP registry are both visible in diagnostics
- added `openclaw/install-or-update-openclaw-mcp.sh`, so a Hermes-style Engrm HTTP endpoint can be registered into OpenClaw with one command instead of manual JSON edits
- documented the same-host Hermes/OpenClaw case and the mixed-global-npm-prefix pitfall, so operators do not accidentally leave LaunchAgents pinned to an older Engrm install after updating npm

## 0.4.40

- fixed Hermes HTTP transport reuse by switching the remote MCP path onto a stateful Streamable HTTP session model, so authenticated SSE negotiation no longer crashes with `500` before initialization

## 0.4.39

- added Hermes-ready remote MCP support with Streamable HTTP serving, bearer-token auth, reserved `shared-experience` fleet routing, and extra outbound fleet scrubbing for hostnames, IPs, and MACs
- surfaced Hermes diagnostics in `engrm status`, `engrm doctor`, and `capture_status`, so remote MCP and fleet configuration are visible without inspecting raw settings files
- added Hermes deployment examples to the public docs and MCP examples, so remote container deployment no longer depends on tribal knowledge

- added Streamable HTTP MCP serving for Hermes-style deployments via `engrm serve --http` or `ENGRM_HTTP_PORT`, while keeping the existing stdio transport unchanged for Claude Code, Codex, and local agent use
- HTTP mode now validates bearer tokens before routing requests into the MCP transport, so multiple remote Hermes clients can be gated safely with static connection tokens
- added fleet routing config in `settings.json` with reserved project-name handling, so a project like `shared-experience` can sync to a dedicated Candengo namespace/key while normal projects stay org-scoped
- fleet writes now get an extra outbound scrub pass that redacts hostnames, IPs, and MAC addresses before they leave the machine
- sync push/pull now understand multiple namespaces, so fleet projects can travel on a separate shared lane without breaking the main org-scoped sync loop
- kept the stable OpenClaw plugin ID as `engrm` while leaving `engrm-openclaw-plugin` as the npm package name, so OpenClaw config and allowlists do not break during updates
- clarified that `openclaw plugins install engrm-openclaw-plugin` is the package install path, while `openclaw plugins update engrm` remains the stable operational update command
- the helper install/update script now repairs `plugins.allow` and `plugins.entries` back to the stable `engrm` plugin ID after package install/update, so future OpenClaw updates do not invalidate local config again
- the helper install/update script now also seeds a minimal `plugins.installs.engrm` record, so newer OpenClaw builds stop warning that the local Engrm plugin is untracked
- added a repo guard for the OpenClaw plugin contract, so package name, manifest/runtime plugin id, and install/update docs cannot silently drift back into the same breakage pattern
- wired the OpenClaw plugin contract check into the normal release/publish path via `npm run check:release`, so a future publish cannot skip the build/public-doc/plugin-contract safety checks
- when `claude-code` is active on a shared repo, recall previews, exact-open hints, and default `resume_thread` behavior now bias toward the Claude thread instead of whichever agent wrote most recently, so Claude startup and memory recovery feel less cross-agent muddled
- added first-cut OpenCode support with local MCP registration, a lightweight continuity plugin, installer docs, and CLI/doctor/capture-status visibility, so Engrm can now be wired into OpenCode without guessing the config by hand

## 0.4.38

### Fixed

- startup/search recovery is now resilient when local FTS still throws: the OpenClaw startup brief falls back to recent observations instead of crashing, and the shared MCP search path falls back to vec-only or empty results instead of taking recall down entirely
- added regression coverage proving `searchObservations()` survives FTS failures cleanly, so prompt-search issues are much less likely to turn into repeated startup-brief crashes

## 0.4.37

### Fixed

- hardened FTS query sanitization in both the main MCP search path and the OpenClaw plugin path, so prompts containing markdown backticks, quotes, slashes, paths, and dates no longer break SQLite `MATCH ?` queries
- added a regression test covering markdown-heavy, path-heavy, and date-heavy prompt text so startup brief search stops regressing into repeated OpenClaw startup failures

## 0.4.36

### Fixed

- `resume_thread` and `repair_recall` now tolerate sqlite-vec chat-index edge cases during transcript/history rehydration, so weak recall repair no longer takes down the main thread-resume path
- `memory_console` now returns the `provenance_type_mix` data its MCP output expects, so the console view no longer crashes while formatting provenance summaries
- `capture_quality` MCP output now defines and prints provenance type-mix lines correctly, so the workspace capture-quality report no longer fails at render time

## 0.4.35

### Changed

- `agent_memory_index` now includes an exact `load_recall_item("...")` jump per agent, `resume_thread` now accepts an optional `agent`, and startup/workbench hints now surface `resume_thread(agent="...")`, so Claude Code, Codex, and OpenClaw can recover their own thread more directly on shared repos
- unread cross-device message counts now exclude handoffs and rolling handoff drafts, and `memory_stats` now reports inbox notes separately from handoffs, so Engrm no longer treats continuity artifacts like personal/team inbox traffic
- `recent_activity` and activity-style views now classify `message` observations as inbox notes, saved handoffs, or rolling drafts, so recent views stop flattening all continuity artifacts into one vague type
- startup, `memory_console`, `project_memory_index`, and `session_context` now surface recent inbox notes separately from handoffs, so visible continuity views can show real cross-device notes without muddying handoff state
- recall previews and exact recall loading now carry source-agent provenance, so handoffs, threads, and chat snippets stay clearly attributable when multiple agents touch the same repo

## 0.4.34

### Changed

- new `agent_memory_index` MCP tool compares continuity and capture health across Claude Code, Codex, OpenClaw, and other agents on the same repo or workspace, so cross-agent validation is explicit instead of inferred
- `memory_console`, `project_memory_index`, `session_context`, and startup hints now surface active agents and suggest `agent_memory_index` when multiple agents are active on the same repo, so cross-agent comparison shows up in the normal continuity flow
- `agent_memory_index` now includes the best exact recall jump per agent, so cross-agent comparison can hand off directly into `load_recall_item("...")`
- `resume_thread` now accepts an optional `agent` filter, so Claude Code, Codex, and OpenClaw can deliberately recover their own thread on a shared repo instead of only using the blended project default
- startup, `memory_console`, `project_memory_index`, `session_context`, and `agent_memory_index` now surface a direct `resume_thread(agent="...")` hint when multi-agent continuity is active
- unread cross-device message counts now exclude handoffs and rolling handoff drafts, so the startup badge and `check_messages` reflect real inbox notes instead of normal continuity artifacts
- `memory_stats` now separates inbox notes from handoffs, so the operational view no longer implies that all `message` observations are cross-device inbox items
- `recent_activity` and activity-style views now classify `message` observations as notes, saved handoffs, or rolling drafts, so recent surfaces stop flattening all continuity artifacts into the same vague type
- startup, `memory_console`, `project_memory_index`, and `session_context` now surface recent inbox notes separately from handoffs, so visible continuity views can show real cross-device notes without muddying handoff state
- recall previews and exact recall loading now carry source-agent provenance, so handoffs, threads, and chat snippets stay clearly attributable when multiple agents touch the same repo
- startup handoff now shows a compact recall preview with exact keys like `handoff:*`, `session:*`, and `chat:*`, so the deterministic recall protocol is visible before an agent even reaches for MCP
- `resume_thread` now returns the best exact recall key to open next and server output shows the matching `load_recall_item("...")` call, so the main continuity tool can hand off directly into deterministic item loading
- `memory_console`, `project_memory_index`, and `session_context` now expose and print the same best exact recall key, so the MCP workbench itself can suggest one direct `load_recall_item("...")` jump instead of only showing recall previews

## 0.4.32

### Added

- new `list_recall_items` MCP tool gives Engrm a directory-style recall index of handoffs, session threads, chat snippets, and memory entries, so agents can list strong candidates first and then open an exact item instead of guessing
- new `load_recall_item` MCP tool opens one exact key returned by `list_recall_items`, completing a deterministic list-first, load-exact recall protocol

### Changed

- startup and workbench suggestions now surface `list_recall_items` ahead of lower-level recall tools, making Engrm's continuity flow more deterministic and easier to explain publicly
- `memory_console`, `project_memory_index`, and `session_context` now expose recall-index readiness directly and suggest `load_recall_item` as the exact follow-on step after listing candidates
- `memory_console`, `project_memory_index`, and `session_context` now preview a few exact recall keys and titles directly, so the list-first / load-exact protocol is easier to follow without a separate exploratory step
- injected context now includes a compact recall index, and startup hints now point at `load_recall_item`, so the list-first / load-exact protocol is visible to both the model and the operator
- public MCP descriptions and docs now present a clearer continuity protocol: `resume_thread` first, `list_recall_items` for deterministic directory-style recall, `load_recall_item` for exact opens, and `repair_recall` when continuity is still thin

## 0.4.31

### Changed

- `resume_thread` now includes `next_actions`, source session/device cues, and a `live / recent / stale` freshness signal, so the default continuity tool reads more like a coworker handoff than a generic recap
- `memory_console`, `project_memory_index`, and `session_context` now expose that same resume-readiness state and next actions, so the main MCP workbench can tell whether a repo is actually ready for a confident resume before you call `resume_thread`
- startup handoff now shows the same `live / recent / stale` resume cue with source device/session details, so the first visible Engrm handoff is closer to the same continuity model as the MCP tools
- public MCP docs, examples, and listing metadata now position Engrm around both durable capture and live continuity, with `resume_thread` and `repair_recall` included in the starter surface

## 0.4.30

### Added

- new `repair_recall` MCP tool can rehydrate recent project/session recall from transcript files or Claude `history.jsonl`, so OpenClaw-style recall failures are easier to repair in one pass instead of one session at a time
- new `resume_thread` MCP tool builds one clear resume point from handoff, current thread, recent chat, and unified recall, so OpenClaw does not need to guess which continuity tool to call first

### Changed

- `memory_console`, `project_memory_index`, `session_context`, `capture_quality`, and server text output now treat chat recall as `transcript-backed`, `history-backed`, `hook-only`, or `none`, instead of flattening everything non-transcript into the same bucket
- startup and workbench hints now suggest `repair_recall` when recent chat exists but full transcript-backed continuity is still missing
- startup and workbench hints now also surface `resume_thread` as the quickest “get me back into the live thread” path
- chat/recall hints and coverage output now show `history` explicitly alongside `transcript` and `hook`, making OpenClaw-style recovery paths much easier to understand
- `resume_thread` now reports resume confidence and basis cues, so agents can tell whether they are resuming from a strong handoff, usable live recall, or only a thin fallback
- `resume_thread` can now attempt recall repair before building the resume point, so one call can both recover weak chat continuity and return a stronger thread summary

## 0.4.29

### Added

- transcript/chat recall now falls back to Claude `history.jsonl` when session transcript files are missing or session IDs drift, so OpenClaw-style sessions can still recover recent prompts into chat recall and prompt chronology

### Changed

- chat recall surfaces now distinguish capture origin as `transcript`, `history`, or `hook`, so recovered history-backed chat is visible instead of masquerading as thin hook-edge recall
- `search_chat` now prefers fresher transcript/history-backed matches over stale hook-only chat when both are plausible, and treats “what were we just talking about?” style prompts as recent-thread recovery
- `search_recall` now penalizes older memory slightly, boosts very recent chat harder, and prefers results from the most recent active session so live continuity is less likely to get drowned by week-old project memory

## 0.4.28

### Added

- chat recall now has a sqlite-vec semantic lane too, so new chat messages can be embedded locally and searched by meaning rather than exact wording alone

### Changed

- `search_chat` now uses hybrid lexical + semantic ranking when local embeddings and sqlite-vec are available, while still falling back cleanly to lexical recall on thinner machines
- transcript-backed chat hydration and hook-captured chat writes now feed the semantic chat lane too, so unified recall can find recent conversation more like a real chat memory instead of a plain text grep

## 0.4.27

### Added

- `search_recall` now searches durable memory and live chat recall together, so “what were we just talking about?” no longer depends on choosing `search` versus `search_chat` first

### Changed

- `memory_console`, `project_memory_index`, and `session_context` now expose chat recall coverage too, so the main workbench can show whether project recall is transcript-backed, hook-only, or absent without opening the dedicated chat tools
- startup and workbench suggestions now prioritize `refresh_chat_recall` when chat continuity is present but still hook-only
- startup and workbench suggestions now also prioritize `search_recall` when recent prompts, chat, or observations exist, so the unified recall lane is easier to discover

## 0.4.26

### Added

- `memory_console`, `project_memory_index`, and `session_context` now expose a continuity state:
  - `fresh`
  - `thin`
  - `cold`

### Changed

- local MCP text output now prints continuity summaries directly, so thin repos are described honestly instead of forcing stale memory to look active
- startup handoff now prints the same `fresh / thin / cold` continuity state and leans toward `recent_chat`, `recent_handoffs`, and `refresh_chat_recall` when continuity is not yet fresh
- `recent_chat` and `search_chat` now report transcript-vs-hook coverage and session spread, and they nudge toward `refresh_chat_recall` when recall is still hook-only
- `capture_quality` now reports transcript-backed versus hook-only chat recall across the workspace and per project, so OpenClaw recall problems are easier to spot before digging into individual sessions

## 0.4.25

### Added

- `refresh_chat_recall` MCP tool can now hydrate the separate chat lane from the current Claude transcript for long sessions

### Changed

- long sessions can now fill the chat lane from transcript-backed messages, and chat views label whether each message came from a transcript import or hook-edge capture
- `PreCompact` now refreshes transcript-backed chat recall and the rolling handoff draft before Claude compacts, so context compression preserves the current thread instead of acting like the conversation vanished

## 0.4.24

### Added

- `activity_feed` now includes the separate chat lane as first-class `chat` events in both project-scoped and session-scoped chronology views
- `refresh_handoff` MCP tool now refreshes a rolling live handoff draft for the current session without creating a new saved handoff
- `refresh_chat_recall` MCP tool can now hydrate the separate chat lane from the current Claude transcript for long sessions
- rolling cross-device handoff drafts now update throughout the session and sync as a distinct continuity layer
- the MCP workbench now exposes saved-vs-draft handoff split in:
  - `memory_console`
  - `project_memory_index`
  - `session_context`
- `session_story` and `activity_feed` now distinguish saved handoffs from rolling draft handoffs

### Changed

- MCP docs and examples now describe `activity_feed` as the merged continuity surface across prompts, tools, chat, handoffs, observations, and summaries
- long sessions can now fill the chat lane from transcript-backed messages, and chat views label whether each message came from a transcript import or hook-edge capture
- injected session context can now carry a compact `Recent Chat` section for the current project, so cross-device resume has conversational continuity as well as reduced memory
- injected context now surfaces `Recent Handoffs`, giving the model an explicit cross-device resume lane before raw chronology
- `PreCompact` now refreshes transcript-backed chat recall and the rolling handoff draft before Claude compacts, so context compression preserves the current thread instead of acting like the conversation vanished
- startup handoff can now fall back to a compact `Chat trail` when recent prompt lines are absent, so thin in-flight sessions still read like a live coworker update
- `create_handoff` now auto-includes a few chat snippets for thin sessions, while keeping already-rich sessions terse unless chat is explicitly requested
- startup `Next look` hints now point at `load_handoff` and `recent_chat` when Engrm already knows those continuity lanes are available
- handoff views now show source device and freshness, so resume cues read like real cross-device handoffs instead of anonymous saved notes
- when Engrm knows the current device, `recent_handoffs` and `load_handoff` now prefer another machine's resume point over the newest local handoff
- prompt-time, tool-time, and stop-time updates now refresh one rolling syncable handoff draft per session so live work can move across devices before an explicit handoff is saved
- rolling handoff drafts now stay visible across startup, injected context, workbench tools, session views, and feed views as a consistent continuity model

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
- OpenClaw-facing guidance now explicitly teaches the direct save path: `save_observation` for durable memory, `create_handoff` / `refresh_handoff` for continuity, and `capture_openclaw_content` for OpenClaw-shaped work, instead of implying that end-of-session digests are the only persistence route
- `save_observation` and `capture_openclaw_content` tool descriptions now make it clear they are direct write paths to memory during a session, not just post-hoc reducers
