# Engrm Codex Skills

This directory contains the first Engrm skill bundle for Codex and OpenAI skill
catalog submission.

Why this shape:

- Codex supports folder-based skills with `SKILL.md`.
- The official `openai/skills` catalog is also skill-folder oriented.
- Engrm already provides its value through MCP tools, startup memory, delivery
  review, and Sentinel guidance, so a skill bundle is the fastest useful
  artifact.

Included skills:

- `engrm-memory`
- `engrm-delivery-review`
- `engrm-sentinel`

Packaging:

- Run `python3 codex/package_codex_skills.py`
- Bundles will be written to `codex/dist/`

Publish support:

- See `codex/OPENAI_SKILLS_SUBMISSION.md` for listing copy and notes.
- Each skill directory includes a small `README.md` suitable for catalog copy.
