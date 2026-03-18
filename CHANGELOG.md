# Changelog

All notable changes to this repository should be documented here.

## Unreleased

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
