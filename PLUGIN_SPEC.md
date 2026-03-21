# Engrm Plugin Spec

This document defines an open plugin model for Engrm.

The goal is simple:

- let external tools and plugins produce memory that Engrm can understand
- let Engrm expose memory in a way that other plugins and agents can consume
- keep the live tool surface thin while making memory richer and more reusable

This spec is designed for cross-device, cross-agent workflows. It is intentionally tool-agnostic and can sit above MCP, CLI, local file scans, HTTP APIs, or agent-native hooks.

---

## Design Goals

- **Memory-aware integrations**: plugins should not just call tools; they should produce reusable memory.
- **Tool-surface discipline**: raw tool schemas and raw outputs should not dominate context.
- **Cross-agent portability**: the same plugin concepts should work for OpenClaw, Claude Code, Codex, and future MCP-compatible agents.
- **Structured outcomes**: memory should be shaped into durable objects such as bugfixes, decisions, discoveries, features, risks, and next actions.
- **Project awareness**: plugins should attribute work to project, repo, branch, campaign, or workflow context whenever possible.
- **Safe interoperability**: plugins should declare what they capture, what they emit, and what should remain local or redacted.

---

## Core Model

An Engrm plugin has four responsibilities:

1. **Connector**
   - how the plugin talks to an external system
   - examples: MCP server, CLI command, local file scan, git, HTTP API

2. **Reducer**
   - how raw output is compressed into a smaller, memory-worthy shape
   - examples: summarise a diff, dedupe repeated findings, strip boilerplate

3. **Extractor**
   - how reduced output becomes durable memory objects
   - examples: bugfix, decision, discovery, feature, risk, next action

4. **Presenter**
   - how those memory objects should appear later
   - examples: startup brief, Briefs page, Sentinel, Delivery Review, project rollups

This is the key difference between an Engrm plugin and a generic tool integration: a plugin is responsible not just for access, but for memory quality.

---

## Plugin Manifest

Each plugin should expose a manifest with at least the following fields:

```json
{
  "id": "engrm.openclaw-content",
  "name": "OpenClaw Content",
  "version": "0.1.0",
  "kind": "workflow",
  "connectors": ["mcp", "cli"],
  "produces": ["change", "decision", "discovery", "next_action"],
  "surfaces": ["briefs", "startup", "insights"],
  "project_scopes": ["project", "repo", "campaign"],
  "sensitivity": {
    "default_mode": "local_first",
    "can_redact": true,
    "supports_sync": true
  }
}
```

### Required fields

- `id`: stable unique identifier
- `name`: human-readable plugin name
- `version`: semver-compatible version
- `kind`: one of `source`, `memory`, `workflow`
- `connectors`: supported access methods
- `produces`: memory object types the plugin can emit
- `surfaces`: Engrm surfaces the plugin expects to feed

### Recommended fields

- `project_scopes`: project attribution dimensions the plugin understands
- `sensitivity`: capture and sync expectations
- `capabilities`: optional finer-grained features such as `diff_scan`, `thread_summary`, `risk_classification`

---

## Memory Object Contract

Plugins should emit structured memory objects, not only free-form text blobs.

Recommended shape:

```json
{
  "type": "bugfix",
  "title": "Prevented SSH scanner from overwriting AP device type",
  "summary": "Protected AP classifications during priority upsert so connectors can correct scanner mistakes.",
  "facts": [
    "Scanner had been overwriting AP device type with switch",
    "Priority upsert now preserves AP classification"
  ],
  "project": "alchemy",
  "repo": "alchemy",
  "source": "openclaw",
  "plugin_id": "engrm.repo-scan",
  "session_id": "session_123",
  "source_refs": [
    {
      "kind": "file",
      "value": "app/services/scanner.py"
    }
  ],
  "tags": ["device-classification", "bugfix"],
  "sensitivity": "internal"
}
```

### Recommended fields

- `type`
- `title`
- `summary`
- `facts`
- `project`
- `repo`
- `source`
- `plugin_id`
- `session_id`
- `source_refs`
- `tags`
- `sensitivity`

### Memory object types

Common types Engrm expects:

- `bugfix`
- `feature`
- `change`
- `decision`
- `discovery`
- `risk`
- `next_action`
- `summary`
- `message`

Plugins may define subtype tags, but should map to at least one common type for portability.

---

## Capture Rules

Plugins should prefer the following order:

1. capture concrete outcomes
2. capture reusable facts
3. capture the smallest useful evidence pointer
4. avoid saving raw noisy output unless explicitly requested

Good:

- a reduced diff summary
- a normalized risk finding
- a posted-thread outcome
- a decision with rationale

Bad:

- entire terminal transcripts by default
- giant raw API payloads
- repeated wrapper prompts
- duplicated cron metadata

---

## Project Attribution

To make memory useful later, plugins should attribute work to the strongest available scope:

1. `project`
2. `repo`
3. `branch`
4. `campaign`
5. `service`
6. `environment`

If exact attribution is unknown, plugins should leave the field empty rather than inventing a value.

---

## Presentation Hooks

Plugins should declare which Engrm surfaces they are designed to feed.

### `startup`
- concise context restoration
- prioritize decisions, active bugfixes, recent discoveries, and next actions

### `briefs`
- typed factual lanes such as bugfixes, features, changes, decisions, discoveries

### `sentinel`
- real-time risk findings, repeated mistakes, policy or safety guidance

### `delivery_review`
- plan-vs-delivery evidence when a plugin can identify explicit requested work

### `insights`
- project rollups, trends, repeated patterns, and value metrics

Not every plugin needs every surface.

---

## Interoperability Modes

This spec supports three broad plugin classes:

### 1. Source plugins
- bring data in from an external source
- examples: git, repo scan, CI, issue tracker

### 2. Memory plugins
- transform or enrich memory already inside Engrm
- examples: dedupe, fact extraction, project rollups, risk clustering

### 3. Workflow plugins
- model a repeated work pattern end to end
- examples: OpenClaw content pipeline, release readiness, debug session analysis

---

## Sensitivity and Trust

Plugins should clearly state:

- whether they read local-only data
- whether they sync data upstream
- whether they redact or hash sensitive material
- whether they require explicit user opt-in

Recommended sensitivity values:

- `public`
- `internal`
- `confidential`
- `local_only`

Plugins should avoid sending secrets, credentials, or raw regulated data unless that behavior is explicitly intended and documented.

---

## Relationship To MCP and Thin-Tool Runtimes

This spec is compatible with MCP and with thin-tool patterns such as runtime CLI wrappers.

Engrm should not try to replace those systems.

## Current First-Party Thin Tools

The spec is now backed by shipped first-party thin tools:

- `capture_git_worktree`
  - reads the current repo diff locally
  - reduces it through `engrm.git-diff`
- `capture_repo_scan`
  - runs a lightweight repo scan
  - reduces it through `engrm.repo-scan`
- `capture_openclaw_content`
  - reduces OpenClaw posted/researched/outcome work
  - saves it through `engrm.openclaw-content`

These are useful reference implementations for external plugin authors because they show the intended shape:

- thin MCP surface
- reducer-backed memory output
- plugin provenance preserved in memory
- visible through local inspection tools like `tool_memory_index` and `session_tool_memory`

Instead:

- MCP or CLI runtimes provide access
- Engrm plugins reduce, extract, and present what matters
- memory objects become the durable cross-device, cross-agent layer

This is the core idea:

- **thin tools**
- **thick memory**

---

## MCP Support

Engrm now exposes a small MCP surface for plugin-aware integrations:

- `plugin_catalog`
  - lists the built-in plugin manifests and the surfaces they feed

- `save_plugin_memory`
  - saves reduced plugin output as a durable Engrm memory object with stable provenance

- `capture_git_diff`
  - first built-in reducer for git diffs; converts a raw diff into an Engrm memory object and saves it

Third-party integrations do not need to adopt the whole ecosystem at once. The smallest useful path is:

1. inspect `plugin_catalog`
2. reduce their output into a durable title/summary/facts shape
3. save it via `save_plugin_memory`

---

## First Recommended Plugin Types

- `engrm.git-diff`
  - reduce diffs into bugfixes, features, risky edits, migrations, reversions

- `engrm.repo-scan`
  - reduce file and codebase scans into discoveries, risks, and structural notes

- `engrm.openclaw-content`
  - turn content workflow output into posted outcomes, research notes, and next actions

- `engrm.issue-tracker`
  - map tickets and comments into decisions, active work, blockers, and follow-ups

- `engrm.ci-release`
  - convert test/build/deploy output into shipped outcomes, regressions, and release notes

---

## Versioning

This spec starts at:

- `engrm-plugin-spec: 0.1`

Until `1.0`, breaking changes are allowed, but should be documented clearly in `CHANGELOG.md`.

---

## Status

This is an open working spec for the Engrm ecosystem.

It is intended to guide:

- first-party Engrm plugins
- third-party plugin authors
- integrations that want to make their tool output memory-aware

Feedback and proposals are welcome via the Engrm repo.
