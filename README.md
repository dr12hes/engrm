# Engrm

[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-purple)](https://modelcontextprotocol.io)

**The only AI memory that syncs across devices and agents.**

Cross-device persistent memory for OpenClaw, Claude Code, Codex, and any MCP-compatible agent. Start free with 2 devices.

[Get Started](https://engrm.dev) • [Documentation](https://engrm.dev/developers) • [Blog](https://engrm.dev/blog)

Docs: [Architecture](./ARCHITECTURE.md) • [Plugin Spec](./PLUGIN_SPEC.md) • [Roadmap](./ROADMAP.md) • [Security](./SECURITY.md)

---

## Why Engrm?

- **Cross-device sync** — Fix a bug on your laptop, continue on your desktop. No other memory tool does this.
- **Cross-agent compatible** — Works with OpenClaw, Claude Code, Codex, Cursor, Windsurf, Cline, Zed
- **Free tier** — 2 devices, 5,000 observations, full sync. £0 forever.
- **Offline-first** — Local SQLite + sqlite-vec. <50ms search. Works on a plane.
- **Delivery Review** — Compare what was promised vs what shipped
- **Sentinel** — Real-time code audit before changes land
- **Team memory** — Share insights across your whole team (Team plan)

---

## vs Other Memory Tools

| Feature | Engrm Free | Supermemory Pro | mem0 |
|---------|------------|-----------------|------|
| **Cost** | £0 | $20/mo | ~$2/mo + usage |
| **Cross-device** | ✅ 2 devices | ❌ Single device | ❌ Single device |
| **OpenClaw plugin** | ✅ Native | ✅ (Pro required) | ✅ (usage costs) |
| **Works with Claude/Codex** | ✅ | ❌ | ❌ |
| **Delivery Review** | ✅ | ❌ | ❌ |
| **Sentinel** | ✅ (Vibe+) | ❌ | ❌ |

[Read the full comparison →](https://engrm.dev/blog/engrm-openclaw-cross-device-memory)

---

## Installation

### For OpenClaw Users

```bash
# 1. Install the plugin
openclaw plugins install engrm-openclaw-plugin

# 2. Restart OpenClaw
# Quit and reopen, or restart gateway

# 3. Connect Engrm in chat
/engrm connect

# 4. Verify
/engrm status
```

**What works:**
- ✅ Session startup memory injection
- ✅ Automatic session capture
- ✅ Cross-device sync (unique to Engrm)
- ✅ `/engrm` slash commands
- ✅ Sentinel advisory mode (Vibe+ plans)

**Blog:** [Engrm Now Supports OpenClaw →](https://engrm.dev/blog/engrm-openclaw-cross-device-memory)

### For Claude Code / Codex

```bash
npx engrm init
```

This auto-configures MCP servers and hooks in `~/.claude.json` and `~/.codex/config.toml`.

**Alternative methods:**
```bash
# From a provisioning token (shown on engrm.dev after signup)
npx engrm init --token=cmt_your_token

# Self-hosted Candengo Vector
npx engrm init --url=https://vector.internal.company.com

# Manual setup (air-gapped environments)
npx engrm init --manual
```

For npm users, Engrm runs on Node.js 18+ and does not require Bun to be installed.

---

## How It Works

### Background Operation

Engrm works automatically:

- **Session start** — injects relevant project memory into context
- **While you work** — captures observations from tool use where the agent exposes that hook surface
- **Session end** — generates a session digest, syncs to cloud, and turns recent work into a denser project brief

```
━━━ Engrm Session Summary ━━━

📋 Request: Fix the OAuth redirect validation
🔍 Investigated: redirect_uri handling in auth.py
💡 Learned: scheme + host + port must all match registered URIs
✅ Completed: Stricter redirect_uri validation (auth.py)

🟢 Risk: Low (0.12)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Check Status

```bash
npx engrm status
```

```
Engrm Status

  User:        david
  Email:       david@example.com
  Device:      macbook-a1b2c3d4
  Plan:        Pro (£9.99/mo)
  Server:      https://engrm.dev
  MCP server:  registered
  Codex MCP:   registered
  Hooks:       registered (6 hooks)
  Codex hooks: registered (2 hooks)

  Observations:    1,247 active
  By type:         change: 412, discovery: 289, bugfix: 187, ...
  Sentinel:        enabled (advisory, 142/200 today)
  Sync:            push 2m ago, pull 5m ago
  Security:        3 findings (1 high, 2 medium)
```

### Architecture

**Claude Code session:**
```
 │
 ├─ SessionStart hook ──→ inject relevant memory into context
 │
 ├─ PreToolUse hook ────→ Sentinel audits Edit/Write (optional)
 │
 ├─ PostToolUse hook ───→ extract observations from tool results
 │
 ├─ PreCompact hook ────→ re-inject memory before context compression
 │
 ├─ ElicitationResult ──→ capture MCP form submissions
 │
 └─ Stop hook ──────────→ session digest + sync + summary
 │
 ▼
Local SQLite (FTS5 + sqlite-vec)
 │
 ▼ (sync every 30s)
Candengo Vector (cloud)
 │
 ▼
Available on all your devices + team members
```

**Codex session:**
```
 │
 ├─ SessionStart hook ──→ inject relevant memory into context
 │
 ├─ MCP tools ──────────→ search, save, inspect, message, stats
 │
 └─ Stop hook ──────────→ session digest + sync + summary
```

### Agent Capability Matrix

| Capability | Claude Code | Codex | OpenClaw |
|-----------|-------------|-------|----------|
| MCP server tools | ✓ | ✓ | Via skills / MCP |
| Session-start context injection | ✓ | ✓ | Via skill-guided workflow |
| Stop/session summary hook | ✓ | ✓ | Via skill-guided workflow |
| Per-tool automatic capture | ✓ | Partial via MCP/manual flows only | Manual / skill-guided |
| Pre-write Sentinel hook | ✓ | Not yet exposed by Codex public hooks | Not exposed |
| Pre-compact reinjection | ✓ | Not exposed | Not exposed |
| ElicitationResult capture | ✓ | Not exposed | Not exposed |

See [AGENT_SUPPORT.md](AGENT_SUPPORT.md) for detailed comparison.

---

## Features

### MCP Tools

The MCP server exposes tools that supported agents can call directly:

| Tool | Purpose |
|------|---------|
| `search` | Find relevant observations from memory (hybrid FTS5 + vector) |
| `timeline` | Chronological context around an observation |
| `get_observations` | Fetch full details by ID |
| `save_observation` | Manually save something worth remembering |
| `install_pack` | Load a curated knowledge pack for your stack |
| `send_message` | Leave a cross-device or team note |
| `recent_activity` | Inspect what Engrm captured most recently |
| `memory_stats` | View high-level capture and sync health |
| `capture_status` | Check whether local hooks are registered and raw prompt/tool chronology is actually being captured |
| `activity_feed` | Inspect one chronological local feed across prompts, tools, chat, handoffs, observations, and summaries |
| `memory_console` | Show a high-signal local memory console for the current project, including continuity state |
| `project_memory_index` | Show typed local memory by project, including hot files, recent sessions, and continuity state |
| `workspace_memory_index` | Show cross-project local memory coverage across the whole workspace |
| `tool_memory_index` | Show which source tools and plugins are creating durable memory |
| `session_tool_memory` | Show which tools in one session produced reusable memory and which produced none |
| `recent_requests` | Inspect captured raw user prompt chronology |
| `recent_tools` | Inspect captured raw tool chronology |
| `recent_sessions` | List recent local sessions to inspect further |
| `session_story` | Show prompts, tools, observations, and summary for one session |
| `create_handoff` | Save an explicit syncable handoff so you can resume work on another device |
| `refresh_handoff` | Refresh the rolling live handoff draft for the current session without creating a new saved handoff |
| `recent_handoffs` | List recent saved handoffs for the current project or workspace |
| `load_handoff` | Open a saved handoff as a resume point for a new session |
| `refresh_chat_recall` | Rehydrate the separate chat lane from a Claude transcript when a long session feels under-captured |
| `agent_memory_index` | Compare continuity and capture health across Claude Code, Codex, OpenClaw, and other agents |
| `repair_recall` | Use when continuity feels thin; rehydrate recent recall from transcript or Claude history fallback |
| `list_recall_items` | Use first when continuity feels fuzzy; list the best current handoffs, threads, chat snippets, and memory entries |
| `load_recall_item` | Use after `list_recall_items`; load one exact recall item key |
| `resume_thread` | Use first when you want one direct "where were we?" answer from handoff, current thread, recent chat, and unified recall |
| `recent_chat` | Inspect the separate synced chat lane without mixing it into durable memory |
| `search_chat` | Search recent chat recall with hybrid lexical + semantic matching, separately from reusable memory observations |
| `search_recall` | Search durable memory and chat recall together when you do not want to guess the right lane |
| `plugin_catalog` | Inspect Engrm plugin manifests for memory-aware integrations |
| `save_plugin_memory` | Save reduced plugin output with stable Engrm provenance |
| `capture_git_diff` | Reduce a git diff into a durable memory object and save it |
| `capture_git_worktree` | Read the current git worktree diff and save reduced memory directly |
| `capture_repo_scan` | Run a lightweight repo scan and save reduced findings as memory |
| `capture_openclaw_content` | Save OpenClaw content, research, and follow-up work as plugin memory |

### Public MCP Starter Set

If you are evaluating Engrm as an MCP server, start with this small set first:

- `capture_git_worktree`
  - save a meaningful local git diff before it disappears into commit history
- `capture_repo_scan`
  - capture a quick architecture, implementation, or risk scan as reusable memory
- `capture_openclaw_content`
  - save posted content, research, outcomes, and next actions from OpenClaw work
- `tool_memory_index`
  - verify which tools are actually producing durable memory and which plugins they exercise
- `capture_quality`
  - check whether raw chronology is healthy across the workspace before judging memory quality
- `list_recall_items`
  - list the best current handoffs, session threads, chat snippets, and memory entries before opening one exact item
- `load_recall_item`
  - open one exact recall key from the index without falling back to fuzzy retrieval
- `resume_thread`
  - get one direct “where were we?” resume point with freshness, source, tool trail, and next actions
- `repair_recall`
  - repair weak project recall from transcript or Claude history fallback before you give up on continuity

These are the tools we should be comfortable pointing people to publicly first:

- thin input surface
- local-first execution
- durable memory output instead of raw transcript dumping
- easy local inspection after capture
- clear continuity recovery when switching devices or resuming long sessions

### Recall Protocol

When continuity feels fuzzy, the default path is:

1. `resume_thread`
2. `list_recall_items`
3. `load_recall_item`
4. `repair_recall`

How to use it:

- `resume_thread` is the fastest "get me back into the live thread" action
- `list_recall_items` is the deterministic directory-first path when you want to inspect candidates before opening one
- `load_recall_item` opens an exact handoff, thread, chat, or memory key returned by the index
- `repair_recall` is the repair step when continuity is still thin, hook-only, or under-captured

### Thin Tools, Thick Memory

Engrm now has a real thin-tool layer, not just a plugin spec.

Current first-party thin tools:

- `capture_git_worktree`
  - reads the current repo diff directly
  - reduces it through `engrm.git-diff`
- `capture_repo_scan`
  - runs a lightweight repo scan
  - reduces it through `engrm.repo-scan`
- `capture_openclaw_content`
  - captures posted/researched/outcome-style OpenClaw work
  - reduces it through `engrm.openclaw-content`

These tools are intentionally small:

- tiny input surface
- local-first execution
- reduced durable memory output
- visible in Engrm's local inspection tools so we can judge tool value honestly

### Explicit Handoffs

For long-running work across devices, Engrm now has an explicit handoff flow:

- `create_handoff`
  - snapshot the active thread into a syncable handoff message
- `refresh_handoff`
  - refresh the rolling live handoff draft for the current session
- `recent_handoffs`
  - list the latest saved handoffs
- `load_handoff`
  - reopen a saved handoff as a clear resume point in a new session

Recent handoffs now carry:

- source machine
- freshness
- current thread / recent outcomes
- optional chat snippets when the session is still thin

Rolling handoff drafts:

- are kept as one updatable syncable draft per session
- refresh during prompt-time and tool-time summary updates
- let another machine resume live work even before you save a deliberate handoff
- are refreshed again before Claude compacts, so the active thread survives context compression better

The local workbench now shows handoff split too:

- saved handoffs
- rolling drafts

`activity_feed` and `session_story` now keep that distinction visible too, so a live rolling draft does not masquerade as a deliberate saved handoff.

When Engrm knows your current device, handoff tools also prefer resume points from another machine before showing the newest local handoff again.

This is the deliberate version of multi-device continuity: useful when you want to move from laptop to home machine without waiting for an end-of-session summary.

The separate chat lane is still kept distinct from durable observations, but it can now sync too, so recent user/assistant conversation is recoverable on another machine without polluting the main memory feed.

For long sessions, Engrm now also supports transcript-backed chat hydration:

- `refresh_chat_recall`
  - reads the Claude transcript for the current session
  - fills gaps in the separate chat lane with transcript-backed messages
  - keeps those rows marked separately from hook-edge chat so recall can prefer the fuller thread

- `repair_recall`
  - scans recent sessions for the current project
  - rehydrates recall from transcript files when they exist
  - falls back to Claude `history.jsonl` when transcript/session alignment is missing
  - reports whether recovered chat is `transcript-backed`, `history-backed`, or still only `hook-only`

- `resume_thread`
  - gives OpenClaw or Claude one direct “where were we?” action
  - combines the best handoff, the current thread, recent outcomes, recent chat, and unified recall
  - reports whether the resume point is `strong`, `usable`, or `thin`
  - can attempt recall repair first when continuity is still weak
  - makes Engrm usable as the primary live continuity layer instead of forcing agents to choose between low-level recall tools

Before Claude compacts, Engrm now also:

- refreshes transcript-backed chat recall for the active session
- refreshes the rolling handoff draft
- then injects the preserved thread into the compacted context

So compaction should reduce prompt-window pressure without making the memory layer act like the conversation never happened.

### Local Memory Inspection

For local testing, Engrm now exposes a small inspection set that lets you see
what it actually captured before anything syncs upstream.

Recommended flow:

```text
1. capture_status
2. memory_console
3. resume_thread
4. activity_feed
5. recent_sessions
6. session_story
7. tool_memory_index
8. session_tool_memory
9. project_memory_index
10. workspace_memory_index
```

What each tool is good for:

- `capture_status` tells you whether prompt/tool hooks are live on this machine
- `capture_quality` shows whether chat recall is transcript-backed, history-backed, or still hook-only across the workspace
- `agent_memory_index` lets you compare Claude Code, Codex, and other agent sessions on the same repo, so cross-agent validation stops being guesswork
- when multiple agents are active on the same repo, startup plus the MCP workbench now surface the active agent set and suggest `agent_memory_index` automatically
- recall previews and `load_recall_item` now show source-agent provenance too, so exact recall stays readable when Claude, Codex, and OpenClaw all touch the same project
- `memory_console` gives the quickest project snapshot, including whether continuity is `fresh`, `thin`, or `cold`
- `resume_thread` is the fastest “get me back into the live thread” path when you want freshness, source, next actions, tool trail, chat, and one exact `load_recall_item(...)` suggestion in one place
- `list_recall_items` is the deterministic directory-first path when you want to inspect the best candidate handoffs/threads before opening one exact item
- `load_recall_item` completes that protocol by letting agents open one exact recall key directly after listing
- `memory_console`, `project_memory_index`, and `session_context` now also surface one best exact `load_recall_item(...)` jump, so the workbench can hand you the right deterministic next step instead of only showing recall counts
- `memory_console`, `project_memory_index`, and `session_context` now also show whether project chat recall is transcript-backed, history-backed, or only hook-captured
- `memory_console`, `project_memory_index`, and `session_context` also expose resume-readiness directly, so you can see whether a repo is `live`, `recent`, or `stale` before drilling deeper
- when chat continuity is only partial, the workbench and startup hints now prefer `repair_recall`, and still suggest `refresh_chat_recall` when a single session likely just needs transcript hydration
- the workbench and startup hints now also prefer `search_recall` as the first “what were we just talking about?” path when recent prompts/chat/observations exist
- `search_chat` now uses hybrid lexical + semantic ranking when sqlite-vec and local embeddings are available, so recent conversation recall is less dependent on exact wording
- `activity_feed` shows the merged chronology across prompts, tools, chat, handoffs, observations, and summaries
- `recent_sessions` helps you pick a session worth opening
- `session_story` reconstructs one session in detail, including handoffs and chat recall
- `tool_memory_index` shows which tools and plugins are actually producing durable memory
- `session_tool_memory` shows which tool calls in one session turned into reusable memory and which did not
- `project_memory_index` shows typed memory by repo, including continuity state and hot files
- `workspace_memory_index` shows coverage across all repos on the machine
- `recent_chat` / `search_chat` now report transcript-vs-history-vs-hook coverage too, and `search_chat` will also mark when semantic ranking was available, so weak OpenClaw recall is easier to diagnose and repair

### Thin Tool Workflow

The current practical flow for thin tools is:

```text
1. memory_console / project_memory_index
2. tool_memory_index
3. capture_git_worktree or capture_repo_scan
4. session_tool_memory
5. session_story
```

That lets you:

- see what Engrm already knows
- see which tools/plugins are producing value
- capture the current repo state with a thin tool
- verify whether that tool produced reusable memory

### MCP Examples

These are the kinds of prompts Engrm's current MCP slice is designed for:

- "Capture this current git worktree as memory before I switch tasks."
- "Run a lightweight repo scan focused on auth and validation."
- "Show which tools are actually creating durable memory in this repo."
- "Tell me whether raw prompt/tool capture is healthy on this machine."
- "Save this OpenClaw research/posting run as reusable memory."

For concrete example flows and reducer outputs, see [MCP_EXAMPLES.md](/Volumes/Data/devs/candengo-mem/MCP_EXAMPLES.md).

### Observation Types

| Type | What it captures |
|------|------------------|
| `discovery` | Learning about existing systems or codebases |
| `bugfix` | Something was broken, now fixed |
| `decision` | Architectural or design choice with rationale |
| `change` | Meaningful modification (feature, config, docs) |
| `feature` | New capability or functionality |
| `refactor` | Code restructured without behavior change |
| `pattern` | Recurring issue or technique |
| `digest` | Session summary (auto-generated) |

### Hybrid Search

Local FTS5 + sqlite-vec (all-MiniLM-L6-v2, 384 dims) combined with Candengo Vector's BGE-M3 semantic search. Results merged via Reciprocal Rank Fusion.

### Sentinel

LLM-powered review of every `Edit`/`Write` before it executes. Catches security issues, anti-patterns, and drift from team decisions.

```
⚠️ Sentinel: SQL query uses string concatenation instead of parameterized query
   Rule: sql-injection
   (Advisory mode — change allowed)
```

**Built-in rule packs:** security, auth, api, react, database.

```bash
npx engrm sentinel init-rules  # Install all rule packs
npx engrm sentinel rules        # List available packs
```

### Knowledge Packs

Pre-loaded knowledge for your tech stack. Detected automatically on session start.

**Available:** typescript-patterns, nextjs-patterns, node-security, python-django, react-gotchas, api-best-practices, web-security

```bash
npx engrm install-pack typescript-patterns
```

### Secret Scrubbing

Multi-layer regex scanning for API keys, passwords, tokens, and credentials. Sensitive content is redacted before storage and sync. Custom patterns configurable in `~/.engrm/settings.json`.

### Retention & Aging

Observations age gracefully: **active** (30 days, full weight) → **aging** (0.7x search weight) → **archived** (compacted into digests) → **purged** (after 12 months). Pinned observations never age.

---

## Pricing

**Free tier stays free forever.** No bait-and-switch.

Start with 2 devices and 5,000 observations. Upgrade when you need more.

| | Free | Vibe | Pro | Team |
|---|------|------|-----|------|
| **Price** | £0 | £5.99/mo | £9.99/mo | £12.99/seat/mo |
| **Observations** | 5,000 | 25,000 | 100,000 | Unlimited |
| **Devices** | 2 | 3 | 5 | Unlimited |
| **Cloud sync** | ✓ | ✓ | ✓ | ✓ |
| **Sentinel** | — | Advisory (50/day) | Advisory (200/day) | Blocking (unlimited) |
| **Retention** | 30 days | 90 days | 1 year | Unlimited |
| **Team namespace** | — | — | — | ✓ |

Sign up at [engrm.dev](https://engrm.dev).

---

## Self-Hosted

Point Engrm at your own [Candengo Vector](https://www.candengo.com) instance:

```bash
npx engrm init --url=https://vector.internal.company.com --token=cmt_...
```

Candengo Vector provides the backend: BGE-M3 hybrid search, multi-tenant namespaces, and team sync. See the [Candengo docs](https://www.candengo.com/docs) for deployment.

---

## Configuration

### `~/.engrm/settings.json`

Created by `engrm init`. Contains API credentials, sync settings, search preferences, secret scrubbing patterns, and Sentinel configuration.

### `.engrm-project.json`

Place in your project root to override project identity for non-git projects:

```json
{
  "project_id": "internal/design-system",
  "name": "Design System"
}
```

### Agent Auto-Registration

Engrm auto-registers in:

- `~/.claude.json` — MCP server (`engrm`)
- `~/.claude/settings.json` — 6 lifecycle hooks
- `~/.codex/config.toml` — MCP server (`engrm`) + `codex_hooks` feature flag
- `~/.codex/hooks.json` — SessionStart and Stop hooks

---

## Technical Stack

- **Runtime:** TypeScript, runs on Bun (dev) or Node.js 18+ (npm)
- **Local storage:** SQLite via `better-sqlite3`, FTS5 full-text search, `sqlite-vec` for embeddings
- **Embeddings:** all-MiniLM-L6-v2 via `@xenova/transformers` (384 dims, ~23MB)
- **Remote backend:** Candengo Vector (BGE-M3, Qdrant, hybrid dense+sparse search)
- **MCP:** `@modelcontextprotocol/sdk` (stdio transport)
- **AI extraction:** `@anthropic-ai/claude-agent-sdk` (optional, for richer observations)

---

## License

**FSL-1.1-ALv2** (Functional Source License) — part of the [Fair Source](https://fair.io) movement.

- ✅ Free to use, modify, and self-host
- ❌ You cannot offer this as a competing hosted service
- ✅ Each version converts to Apache 2.0 after 2 years
- ⚠️ Sentinel is a separate proprietary product

See [LICENSE](LICENSE) for full terms.

---

## Documentation

- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security: [SECURITY.md](SECURITY.md)
- Roadmap: [ROADMAP.md](ROADMAP.md)

**Maintainers:** run `node scripts/check-public-docs.mjs` to verify the repo only contains the approved public docs set at the root.

---

## Resources

- [Documentation](https://engrm.dev/developers)
- [Blog](https://engrm.dev/blog)
- [Pricing](https://engrm.dev/pricing)
- [Sentinel](https://engrm.dev/sentinel)

## Community

- [Twitter/X](https://twitter.com/engrm_dev)
- [GitHub Issues](https://github.com/dr12hes/engrm/issues)

---

**Found this useful?** ⭐ Star this repo to help other developers discover Engrm.

---

Built by the [Engrm](https://engrm.dev) team, powered by [Candengo Vector](https://www.candengo.com).
