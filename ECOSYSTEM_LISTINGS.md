# Engrm Ecosystem Listings

This file tracks where Engrm is already published, where it is submitted, and which channels become worth pursuing once the hosted MCP surface is ready.

## Live Now

- GitHub repo: `https://github.com/dr12hes/engrm`
- npm CLI: `engrm`
- npm OpenClaw plugin: `engrm-openclaw-plugin`
- OpenClaw install command: `openclaw plugins install engrm-openclaw-plugin`

## Submitted / Pending Review

- OpenClaw community plugins page
  - PR: `https://github.com/clawmax/openclaw-docs-i18n/pull/1`
  - Positioning: shared memory across devices, sessions, and agents

## Ready To Publish Next

- ClawHub skills
  - `engrm-memory`
  - `engrm-delivery-review`
  - `engrm-sentinel`
  - Publish path: `clawhub publish <path>`

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
- continuity across OpenClaw, Claude Code, and Codex

Then add:
- startup briefs
- saved session memory
- Delivery Review
- Sentinel

Avoid leading with:
- generic "AI memory"
- raw observation counts
- dashboard/admin terminology
