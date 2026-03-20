## Restart Handoff

Current branch:
- `codex/public-single-commit`

Published:
- `engrm@0.4.8`

Installed/updated:
- local machine updated to `0.4.8`
- OpenClaw box `devid@192.168.5.81` updated to `0.4.8`

Main work completed in this checkpoint:
- first-class local prompt capture via `UserPromptSubmit`
- first-class local tool chronology capture via `PostToolUse`
- richer startup/context injection with:
  - recent requests
  - recent tools
  - recent sessions
  - project signals
- new MCP/local inspection tools:
  - `capture_status`
  - `activity_feed`
  - `memory_console`
  - `project_memory_index`
  - `workspace_memory_index`
  - `recent_requests`
  - `recent_tools`
  - `recent_sessions`
  - `session_story`
- plugin foundation and public plugin spec:
  - `PLUGIN_SPEC.md`
  - `src/plugins/*`
- sync summary payload now includes prompt/tool capture metadata
- CLI/status/doctor now:
  - show raw chronology readiness
  - normalize legacy public hostnames to `https://engrm.dev`
  - use correct API-key-compatible auth checks

Known current real-machine state:
- `engrm status` now shows `Server: https://engrm.dev`
- `engrm doctor` no longer fails with the old `/v1/account/me` 404
- on this machine, capture is still reported as `observations-only so far`
- `capture_status` currently shows:
  - hooks registered
  - schema current
  - but `recent_user_prompts = 0`
  - and `recent_tool_events = 0`

Meaning:
- the new capture/model/tooling is implemented
- but we still need a fresh real session after restart/reload to confirm the new raw chronology hooks are firing in practice

Best next commands after restart:
- `capture_status`
- `memory_console`
- `activity_feed`
- `recent_sessions`
- `session_story`

Best next product step:
- restart the client
- run one fresh real session
- confirm prompts/tools now populate
- then keep improving startup output from the richer local chronology

Validation at checkpoint:
- targeted tests passed: `147 pass, 0 fail`
- `bun run build` passed
- `npm pack --dry-run` passed for `engrm@0.4.8`

Do not commit:
- `.mcpregistry_github_token`
- `.mcpregistry_registry_token`
