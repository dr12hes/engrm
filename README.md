# Engrm

**Cross-device memory for AI coding agents.** Every session remembers what you learned yesterday — on any machine, for every team member.

For npm users, Engrm runs on Node.js 18+ and does not require Bun to be installed.

```
npx engrm init
```

Public beta. The current source of truth for agent capability differences is [AGENT_SUPPORT.md](AGENT_SUPPORT.md).

---

## What It Does

Your AI agent forgets everything between sessions. Engrm fixes that.

- **Captures automatically** — hooks into Claude Code, and into Codex where its public hook surface allows
- **Remembers across devices** — fix a bug on your laptop, continue on your desktop with full context
- **Shares with your team** — one developer's hard-won insight becomes everyone's knowledge
- **Works offline** — local SQLite is the source of truth; syncs when connected
- **Guards your code** — Sentinel audits changes in real-time before they land

## Quick Start

### 1. Sign up

Visit [engrm.dev](https://engrm.dev) and create an account.

### 2. Install

```bash
npx engrm init
```

This opens your browser for authentication, writes config to `~/.engrm/`, and registers Engrm in both Claude Code and Codex when those configs are available. Takes about 30 seconds.

**Alternative methods:**
```bash
# From a provisioning token (shown on engrm.dev after signup)
npx engrm init --token=cmt_your_token

# Self-hosted Candengo Vector
npx engrm init --url=https://vector.internal.company.com

# Manual setup (air-gapped environments)
npx engrm init --manual
```

### 3. Use your agent normally

That's it. Engrm works in the background:

- **Session start** — injects relevant project memory into context
- **While you work** — captures observations from tool use where the agent exposes that hook surface
- **Session end** — generates a session digest, syncs to cloud, shows summary

```
━━━ Engrm Session Summary ━━━

📋 Request: Fix the OAuth redirect validation
🔍 Investigated: redirect_uri handling in auth.py
💡 Learned: scheme + host + port must all match registered URIs
✅ Completed: Stricter redirect_uri validation (auth.py)

🟢 Risk: Low (0.12)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 4. Check status

```bash
npx engrm status
```

```
Engrm Status

  User:        david
  Email:       david@example.com
  Device:      macbook-a1b2c3d4
  Plan:        Pro (£9.99/mo)
  Candengo:    https://www.candengo.com
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

---

## How It Works

```
Claude Code session
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

```
Codex session
  │
  ├─ SessionStart hook ──→ inject relevant memory into context
  │
  ├─ MCP tools ──────────→ search, save, inspect, message, stats
  │
  └─ Stop hook ──────────→ session digest + sync + summary
```

### Agent Support

| Capability | Claude Code | Codex |
|---|---|---|
| MCP server tools | ✓ | ✓ |
| Session-start context injection | ✓ | ✓ |
| Stop/session summary hook | ✓ | ✓ |
| Per-tool automatic capture | ✓ | Partial via MCP/manual flows only |
| Pre-write Sentinel hook | ✓ | Not yet exposed by Codex public hooks |
| Pre-compact reinjection | ✓ | Not exposed |
| ElicitationResult capture | ✓ | Not exposed |

### MCP Tools

The MCP server exposes tools that Claude can call directly:

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

### Observation Types

| Type | What it captures |
|------|-----------------|
| `discovery` | Learning about existing systems or codebases |
| `bugfix` | Something was broken, now fixed |
| `decision` | Architectural or design choice with rationale |
| `change` | Meaningful modification (feature, config, docs) |
| `feature` | New capability or functionality |
| `refactor` | Code restructured without behavior change |
| `pattern` | Recurring issue or technique |
| `digest` | Session summary (auto-generated) |

---

## Features

### Hybrid Search
Local FTS5 + sqlite-vec (all-MiniLM-L6-v2, 384 dims) combined with Candengo Vector's BGE-M3 semantic search. Results merged via Reciprocal Rank Fusion.

### Sentinel — Real-Time Code Audit
LLM-powered review of every Edit/Write before it executes. Catches security issues, anti-patterns, and drift from team decisions.

```
⚠️  Sentinel: SQL query uses string concatenation instead of parameterized query
   Rule: sql-injection
   (Advisory mode — change allowed)
```

5 built-in rule packs: `security`, `auth`, `api`, `react`, `database`.

```bash
npx engrm sentinel init-rules        # Install all rule packs
npx engrm sentinel rules             # List available packs
```

### Starter Packs
Pre-loaded knowledge for your tech stack. Detected automatically on session start.

Available: `typescript-patterns`, `nextjs-patterns`, `node-security`, `python-django`, `react-gotchas`, `api-best-practices`, `web-security`

```bash
npx engrm install-pack typescript-patterns
```

### Secret Scrubbing
Multi-layer regex scanning for API keys, passwords, tokens, and credentials. Sensitive content is redacted before storage and sync. Custom patterns configurable in `~/.engrm/settings.json`.

### Observation Lifecycle
Observations age gracefully: **active** (30 days, full weight) → **aging** (0.7x search weight) → **archived** (compacted into digests) → **purged** (after 12 months). Pinned observations never age.

---

## Pricing

| | Free | Vibe | Pro | Team |
|---|---|---|---|---|
| **Price** | £0 | £5.99/mo | £9.99/mo | £12.99/seat/mo |
| **Observations** | 5,000 | 25,000 | 100,000 | Unlimited |
| **Devices** | 2 | 3 | 5 | Unlimited |
| **Cloud sync** | ✓ | ✓ | ✓ | ✓ |
| **Sentinel** | — | Advisory (50/day) | Advisory (200/day) | Blocking (unlimited) |
| **Retention** | 30 days | 90 days | 1 year | Unlimited |
| **Team namespace** | — | — | — | ✓ |

Sign up at [engrm.dev](https://engrm.dev).

---

## Self-Hosting

Point Engrm at your own [Candengo Vector](https://www.candengo.com) instance:

```bash
npx engrm init --url=https://vector.internal.company.com --token=cmt_...
```

Candengo Vector provides the backend: BGE-M3 hybrid search, multi-tenant namespaces, and team sync. See the [Candengo docs](https://www.candengo.com/docs) for deployment.

---

## Configuration

### User config: `~/.engrm/settings.json`

Created by `engrm init`. Contains API credentials, sync settings, search preferences, secret scrubbing patterns, and Sentinel configuration.

### Project config: `.engrm.json` (optional)

Place in your project root to override project identity for non-git projects:

```json
{
  "project_id": "internal/design-system",
  "name": "Design System"
}
```

### Agent integration

Engrm auto-registers in:
- `~/.claude.json` — MCP server (`engrm`)
- `~/.claude/settings.json` — 6 lifecycle hooks
- `~/.codex/config.toml` — MCP server (`engrm`) + `codex_hooks` feature flag
- `~/.codex/hooks.json` — `SessionStart` and `Stop` hooks

---

## Tech Stack

- **Runtime**: TypeScript, runs on Bun (dev) or Node.js 18+ (npm)
- **Local storage**: SQLite via better-sqlite3, FTS5 full-text search, sqlite-vec for embeddings
- **Embeddings**: all-MiniLM-L6-v2 via @xenova/transformers (384 dims, ~23MB)
- **Remote backend**: Candengo Vector (BGE-M3, Qdrant, hybrid dense+sparse search)
- **MCP**: @modelcontextprotocol/sdk (stdio transport)
- **AI extraction**: @anthropic-ai/claude-agent-sdk (optional, for richer observations)

---

## License

**FSL-1.1-ALv2** (Functional Source License) — part of the [Fair Source](https://fair.io) movement.

- Free to use, modify, and self-host
- You cannot offer this as a competing hosted service
- Each version converts to Apache 2.0 after 2 years
- Sentinel is a separate proprietary product

See [LICENSE](LICENSE) for full terms.

---

## Project

- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security: [SECURITY.md](SECURITY.md)
- Roadmap: [ROADMAP.md](ROADMAP.md)

Maintainers: run `node scripts/check-public-docs.mjs` to verify the repo only contains the approved public docs set at the root.

---

Built by the [Engrm](https://engrm.dev) team, powered by [Candengo Vector](https://www.candengo.com).
