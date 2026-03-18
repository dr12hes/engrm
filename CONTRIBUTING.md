# Contributing

Thanks for helping improve Engrm.

## Before You Start

- Read the [README](README.md) for the current product surface.
- Check [AGENT_SUPPORT.md](AGENT_SUPPORT.md) before changing agent-specific behavior.
- Open an issue first for large feature work, integration changes, or product-surface changes.

## Development

Requirements:
- Node.js 18+
- Bun for local development and tests

End users installing via npm or `npx engrm ...` do not need Bun. Bun is only required for maintainers working from source, running tests, or producing builds.

Common commands:

```bash
bun install
bun test
bun run bin/build.mjs
```

Run the MCP server locally:

```bash
bun run src/server.ts
```

Run the CLI locally:

```bash
bun run src/cli.ts status
```

## Project Conventions

- Use `rg` for search and keep edits minimal.
- Prefer ASCII unless the file already uses Unicode intentionally.
- Add tests for user-visible behavior and integration logic.
- Keep agent-support claims honest. If a feature works only in Claude Code or only partially in Codex, document that clearly.
- Do not silently broaden data capture, sync visibility, or privacy scope.
- This is a public-facing repository. Do not commit internal planning, competitor analysis, market notes, pricing strategy, launch strategy, or agent scratchpad files.
- Public root-level Markdown should stay limited to the curated set already in the repo unless there is a clear user-facing need.
- If you need private notes, keep them outside this repository or in an untracked local folder such as `notes/` or `scratch/`.

## Pull Requests

Please include:
- what changed
- why it changed
- how you verified it
- any user-facing limitations or follow-up work

For integration changes, mention impact on:
- Claude Code
- Codex
- MCP registry / skill packaging

## Licensing

By contributing, you agree that your contributions are made under the repository license: [FSL-1.1-ALv2](LICENSE).
