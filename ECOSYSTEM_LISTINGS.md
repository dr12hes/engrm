# Engrm Ecosystem Listings

This file tracks where Engrm is already published, where it is submitted, and which channels become worth pursuing once the hosted MCP surface is ready.

## Live Now

- GitHub repo: `https://github.com/dr12hes/engrm`
- npm CLI: `engrm`
- npm OpenClaw plugin: `engrm-openclaw-plugin`
- OpenClaw install command: `openclaw plugins install engrm-openclaw-plugin`
- ClawHub skills:
  - `engrm-memory`
  - `engrm-delivery-review`
  - `engrm-sentinel`

## Submitted / Pending Review

- OpenClaw community plugins page
  - PR: `https://github.com/clawmax/openclaw-docs-i18n/pull/1`
  - Positioning: shared memory across devices, sessions, and agents
- ToolSDK MCP registry
  - PR: `https://github.com/toolsdk-ai/toolsdk-mcp-registry/pull/208`
  - Positioning: shared memory across devices, sessions, and coding systems

## Best Next Registry Targets

### Official MCP Registry

Why:
- strongest long-term MCP visibility
- can flow into other MCP-aware ecosystems

What it needs:
- publishable MCP server metadata
- namespace ownership verification
- registry submission using the MCP publisher flow

Best fit for Engrm:
- publish once the Engrm MCP server surface and metadata are stable enough to list cleanly

### Smithery

Why:
- strong MCP discovery for hosted servers
- good fit once Engrm has a polished remote MCP endpoint

What it needs:
- streamable HTTP transport
- OAuth if auth is required
- server card or scan-friendly metadata

Best fit for Engrm:
- publish once the hosted Engrm MCP endpoint is productized, not just local/stdin-first

### PulseMCP

Why:
- broad MCP directory exposure
- accepts manual submissions

Best fit for Engrm:
- good visibility play once the remote MCP listing is ready

### ToolSDK MCP Registry

Why:
- searchable registry with strong developer audience
- supports PR-based submissions

What it needs:
- JSON config entry in their registry repo
- clean package/runtime/auth metadata

Best fit for Engrm:
- good target for the npm MCP package and later hosted endpoint

### ToolHive Catalog

Why:
- another real registry surface for MCP users

What it needs:
- remote server URL or public container image
- tools listed in catalog metadata

Best fit for Engrm:
- better once Engrm has a remote endpoint or packaged container story

## Positioning To Reuse Everywhere

Lead with:
- shared memory across devices, sessions, and agents
- thin tools, thick memory
- continuity across OpenClaw, Claude Code, and Codex

Then add:
- startup handoff
- saved session memory
- MCP tools that create reusable memory
- Delivery Review
- Sentinel

Avoid leading with:
- generic "AI memory"
- raw observation counts
- dashboard/admin terminology

## Current Public MCP Starter Set

This is the MCP surface we should be comfortable pointing people at first:

- `capture_git_worktree`
  - save a meaningful local diff before it disappears into commit history
- `capture_repo_scan`
  - capture a lightweight architecture / implementation / risk scan as reusable memory
- `capture_openclaw_content`
  - save posted work, research, outcomes, and next actions from OpenClaw workflows
- `tool_memory_index`
  - show which tools are actually producing durable memory and which plugins they exercise
- `capture_quality`
  - check whether raw chronology is healthy enough to trust memory quality on this machine

Why this set:

- thin schemas
- local-first execution
- durable memory output
- easy to validate after capture

## Example MCP Prompts

Use prompts like these in listings, screenshots, and demos:

- "Capture this current git worktree as memory before I switch tasks."
- "Run a lightweight repo scan focused on auth and validation."
- "Show which tools are creating durable memory in this repo."
- "Tell me whether raw capture is healthy on this machine."
- "Save this OpenClaw research and posting run as reusable memory."

## Validation Flow To Demo Publicly

Use this sequence when recording or testing Engrm for MCP directories:

1. `capture_quality`
2. `tool_memory_index`
3. `capture_git_worktree` or `capture_repo_scan`
4. `session_tool_memory`
5. `session_story`

That proves the full loop:

- capture something meaningful
- reduce it into durable memory
- inspect which tool/plugin produced it
- inspect the resulting session story

Reference material:

- `README.md`
- `MCP_EXAMPLES.md`
- `server.json`
