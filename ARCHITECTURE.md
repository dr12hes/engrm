# Architecture

Engrm is a local-first memory layer for AI coding agents.

## Core Flow

1. An agent starts a session.
2. Engrm injects relevant memory into that session when the agent exposes a supported lifecycle hook.
3. During work, the agent can call Engrm MCP tools to search, save, inspect, and share memory.
4. On session end, Engrm stores a session digest and syncs pending observations.

## Main Components

- CLI: setup, configuration, status, and diagnostics
- MCP server: shared tool interface for supported agents
- thin tool layer: small local capture tools that reduce repo/workflow state into memory
- Local database: SQLite with FTS5 and optional `sqlite-vec`
- Sync engine: pushes and pulls observations across devices and teams
- Hooks: agent-specific lifecycle integrations for Claude Code and Codex

## Thin Tool Layer

Engrm now uses a `thin tools, thick memory` approach for new integrations.

Current first-party thin tools:

- `capture_git_worktree`
- `capture_repo_scan`
- `capture_openclaw_content`

These tools intentionally keep the live MCP surface small:

- the tool reads local repo/workflow state
- a reducer turns that state into a memory-worthy object
- Engrm stores the reduced result with plugin provenance
- local inspection tools can then show which tool/plugin combinations are producing durable value

## Storage Model

Engrm keeps local SQLite as the source of truth.

- observations are stored locally first
- full-text search is always available offline
- vector search is used when embeddings are available
- sync propagates observations to remote storage for multi-device and team use
- provenance and plugin metadata are preserved so Engrm can later explain which tools and plugins created durable memory

## Agent Support

The current agent support matrix lives in [AGENT_SUPPORT.md](AGENT_SUPPORT.md).

In short:
- Claude Code has the deepest lifecycle integration today
- Codex supports MCP, session-start injection, and stop/session-summary flows
- future agent support is expected to grow through MCP and agent-specific adapters

## Remote Backend

Engrm can sync to Candengo Vector for:
- cross-device continuity
- team-shared memory
- remote semantic retrieval

## Design Principles

- local-first
- offline-capable
- agent-agnostic where possible
- explicit about capability differences between agents
- careful with privacy, sync behavior, and trust
