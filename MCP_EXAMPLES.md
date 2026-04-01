# Engrm MCP Examples

This file gives concrete example flows for Engrm's current public MCP starter set.

It is designed for:

- registry submissions
- MCP listings
- screenshots / demos
- agent instructions

## Why Engrm Is Different

Engrm is not trying to expose the biggest tool surface.

The current strategy is:

- thin tools
- thick memory
- cross-device continuity
- cross-agent reuse

The goal is not to dump raw tool output into the model.
The goal is to turn useful local work into durable memory that can be recalled later by Claude Code, Codex, OpenClaw, and related systems.

## Public Starter Set

- `capture_git_worktree`
- `capture_repo_scan`
- `capture_openclaw_content`
- `tool_memory_index`
- `agent_memory_index`
- `capture_quality`
- `list_recall_items`
- `load_recall_item`
- `resume_thread`
  - optional `agent` filter when you want the Claude, Codex, or OpenClaw thread specifically
  - surfaced directly in startup/workbench when multi-agent continuity is active
- `repair_recall`

## Hermes Remote Setup

For Hermes-style remote MCP deployment, Engrm can run over Streamable HTTP with bearer auth.

Example `settings.json` additions:

```json
{
  "http": {
    "enabled": true,
    "port": 3767,
    "bearer_tokens": ["replace-with-a-long-random-token"]
  },
  "fleet": {
    "project_name": "shared-experience",
    "namespace": "ns_fleet_shared",
    "api_key": "cvk_fleet_shared"
  }
}
```

Example launch:

```bash
ENGRM_HTTP_PORT=3767 engrm serve --http
```

Example Hermes MCP stanza:

```json
{
  "mcpServers": {
    "engrm": {
      "url": "http://engrm:3767/mcp",
      "headers": {
        "Authorization": "Bearer replace-with-a-long-random-token"
      }
    }
  }
}
```

## Recall Protocol

The recommended continuity flow is:

1. `resume_thread`
2. `list_recall_items`
3. `load_recall_item`
4. `repair_recall`

Use it like this:

- start with `resume_thread` when you want one direct recovery answer
- switch to `list_recall_items` when you want an index-first, deterministic path
- use `load_recall_item` to open one exact candidate instead of guessing with search
- run `repair_recall` when recall is still thin, hook-only, or clearly under-captured
- when `resume_thread` already shows a strong `load_recall_item("...")` hint, you can jump straight to that exact item without listing first
- the workbench tools now do the same thing, so `memory_console` or `session_context` can also hand you the best exact recall key directly

## Explicit Save Protocol

When the user says some result should be remembered, prominent, reusable, or
easy to resume later, use an explicit write tool instead of waiting for a later
digest.

Use it like this:

- `save_observation`
  - for a durable engineering memory item right now
- `create_handoff` / `refresh_handoff`
  - for active-thread continuity
- `capture_openclaw_content`
  - for OpenClaw-style research, posting, outcomes, and next actions

Example prompts:

- "Save this bugfix as reusable memory."
- "Create a handoff before I switch machines."
- "Save this OpenClaw research and posting run as reusable memory."

## Explicit Handoff Flow

Use this when you are moving between machines and want a reliable resume point:

1. `create_handoff`
2. `refresh_handoff`
3. `recent_handoffs`
4. `load_handoff`

Example prompts:

- "Create a handoff for what I am working on before I leave this laptop."
- "Refresh the rolling handoff draft for this current session."
- "Show my recent handoffs for this repo."
- "Load the latest handoff so I can pick this thread back up."

What makes this better than a plain summary:

- the handoff stays separate from durable engineering memory
- there is a rolling draft handoff during the session, not just an end snapshot
- it can include a little chat context when the session is still thin
- recent handoffs show which machine they came from and how fresh they are
- when the current device is known, resume tools prefer a handoff from another machine over the newest local one
- before Claude compacts, Engrm refreshes both the rolling draft and transcript-backed chat recall so the active thread survives compaction more cleanly

## Demo Flow

For a quick public demo or MCP listing video:

1. `capture_quality`
2. `agent_memory_index`
3. `list_recall_items`
4. `load_recall_item`
5. `resume_thread`
6. `tool_memory_index`
7. `capture_git_worktree` or `capture_repo_scan`
8. `session_tool_memory`
9. `session_story`

This proves the full loop:

- capture current work
- compare agent continuity on the same repo
- jump straight into the best exact recall item for a specific agent
- recover the live thread honestly
- reduce it into durable memory
- inspect which tool/plugin produced it
- inspect the resulting session memory

If you want to show continuity rather than just capture, add:

6. `create_handoff`
7. `recent_handoffs`
8. `activity_feed`
9. `resume_thread`
10. `refresh_chat_recall`
11. `repair_recall`

That demo shows:

- deliberate cross-device resume points
- one direct “resume the thread” action for OpenClaw/Claude
- synced chat recall kept separate from durable memory
- one merged feed across prompts, tools, chat, handoffs, and observations
- transcript-backed chat recovery for long sessions
- history-backed chat recovery when transcript/session matching is messy on a real machine
- hybrid semantic chat recall for “what were we just talking about?” moments

## Example Prompt Set

Use prompts like these in demos, screenshots, and listings:

- "Capture this current git worktree as memory before I switch tasks."
- "Run a lightweight repo scan focused on auth and validation."
- "Show which tools are actually creating durable memory in this repo."
- "Tell me whether raw chronology is healthy on this machine."
- "Save this OpenClaw research and posting run as reusable memory."
- "List the best recall items for this repo before you resume anything."
- "Load recall item `handoff:12`."
- "Resume the current thread and tell me how fresh that resume point is."
- "Repair recall for this repo before trying to resume the thread."

## Example: `capture_git_worktree`

Use when:

- there is a meaningful local diff
- you want to preserve the intent before it disappears into commit history

Example input:

```json
{
  "cwd": "/path/to/repo",
  "summary": "Guard missing token validation"
}
```

Reducer output from the current Engrm plugin path:

```json
{
  "plugin_id": "engrm.git-diff",
  "type": "bugfix",
  "title": "Guard missing token validation",
  "summary": "Reduced a git diff into a bugfix memory object covering src/auth.ts with a footprint of +2 / -1.",
  "facts": [
    "Touched src/auth.ts",
    "Diff footprint: +2 / -1",
    "Touches authentication or credential flow"
  ],
  "tags": [
    "git-diff"
  ],
  "source": "git",
  "surfaces": [
    "startup",
    "briefs",
    "delivery_review",
    "insights"
  ]
}
```

Why it matters:

- tiny input
- repo-local execution
- durable memory object instead of raw diff spam

## Example: `capture_repo_scan`

Use when:

- you need a quick architecture or risk scan
- you want findings to become reusable memory instead of one-off analysis

Example input:

```json
{
  "cwd": "/path/to/repo",
  "focus": ["auth", "validation"],
  "summary": "Quick repo scan focused on auth and validation hotspots"
}
```

Reducer output from the current Engrm plugin path:

```json
{
  "plugin_id": "engrm.repo-scan",
  "type": "pattern",
  "title": "Quick repo scan focused on auth and validation hotspots",
  "summary": "Quick repo scan focused on auth and validation hotspots",
  "facts": [
    "Repo scan findings: 1 risks, 1 discoveries, 0 patterns, 1 changes",
    "high Outstanding TODO/FIXME markers found in 6 files (src/server.ts)",
    "Auth/session logic concentrated in 5 files (src/auth.ts)",
    "Test-related files present across 8 files (src/tools/capture-repo-scan.test.ts)"
  ],
  "tags": [
    "repo-scan",
    "risk-finding",
    "discovery",
    "severity:high"
  ],
  "source": "repo-scan",
  "surfaces": [
    "startup",
    "briefs",
    "sentinel",
    "insights"
  ]
}
```

Live lightweight scan output against this repo looked like:

```json
{
  "cwd": "/Volumes/Data/devs/candengo-mem",
  "findings": [
    {
      "kind": "risk",
      "title": "Outstanding TODO/FIXME markers found in 3 files",
      "severity": "medium",
      "file": "./src/tools/capture-repo-scan.ts"
    },
    {
      "kind": "discovery",
      "title": "Auth/session logic concentrated in 8 files",
      "file": "./src/server.ts"
    },
    {
      "kind": "pattern",
      "title": "Routing/API structure appears in 8 files",
      "file": "./src/sync/client.ts"
    }
  ]
}
```

Why it matters:

- small focus-driven scan
- fast enough for live use
- reduced into reusable memory, not just a terminal report

## Example: `capture_openclaw_content`

Use when:

- OpenClaw work is content/research/ops shaped, not coding-session shaped
- you want posted outcomes and next actions to survive across devices and sessions

Example input:

```json
{
  "title": "Thursday teaser thread",
  "posted": [
    "Posted 5-tweet teaser thread about faster observation capture"
  ],
  "researched": [
    "Reviewed competing memory-tool positioning on MCP registries"
  ],
  "outcomes": [
    "Clearer public positioning around thin tools and thick memory"
  ],
  "next_actions": [
    "Measure engagement and refine registry copy"
  ],
  "links": [
    "https://x.com/engrm_dev/status/example"
  ]
}
```

Reducer output from the current Engrm plugin path:

```json
{
  "plugin_id": "engrm.openclaw-content",
  "type": "decision",
  "title": "Thursday teaser thread",
  "summary": "Posted:\n- Posted 5-tweet teaser thread about faster observation capture\n\nResearched:\n- Reviewed competing memory-tool positioning on MCP registries\n\nOutcomes:\n- Clearer public positioning around thin tools and thick memory\n\nNext Actions:\n- Measure engagement and refine registry copy",
  "facts": [
    "Posted: 1",
    "Researched: 1",
    "Outcomes: 1",
    "Next actions: 1",
    "Posted 5-tweet teaser thread about faster observation capture",
    "Reviewed competing memory-tool positioning on MCP registries",
    "Clearer public positioning around thin tools and thick memory",
    "Measure engagement and refine registry copy"
  ],
  "tags": [
    "openclaw-content",
    "posted",
    "researched",
    "outcomes",
    "next-actions"
  ],
  "source": "openclaw",
  "surfaces": [
    "briefs",
    "startup",
    "insights"
  ]
}
```

Why it matters:

- proves the thin-tool pattern is not limited to code
- preserves real work that would otherwise be forced into a fake coding summary

## Example: `tool_memory_index`

Use when:

- you want to judge whether a tool is creating durable memory
- you want to see which plugins are actually paying their way

What to look for:

- source tool
- observation count
- memory type mix
- plugin mix
- sample titles

This is the main inspection tool for judging whether Engrm's MCP surface is useful or just noisy.

## Example: `capture_quality`

Use when:

- you need to know whether prompt/tool chronology is healthy on this machine
- you want to know whether memory quality problems are caused by weak capture or weak ranking

What to look for:

- `rich / partial / summary-only / legacy`
- workspace prompt/tool/checkpoint totals
- provenance by tool
- top projects with raw capture

This is the first thing to check before blaming memory quality on retrieval alone.
