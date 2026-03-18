# Engrm OpenClaw Skills

This directory contains the first Engrm skill bundle for OpenClaw and ClawHub.

Why skills first:

- OpenClaw can install plain `SKILL.md` bundles directly from ClawHub.
- Engrm already exposes its value through MCP tools and structured memory flows.
- We do not need new OpenClaw runtime code yet, only strong guidance for when to
  query memory, review delivery, and surface Sentinel lessons.

Included skills:

- `engrm-memory`
- `engrm-delivery-review`
- `engrm-sentinel`

Packaging:

- Run `python3 openclaw/package_openclaw_skills.py`
- Bundles will be written to `openclaw/dist/`
- Each bundle contains the skill folder exactly as ClawHub/OpenClaw expects

Publish support:

- See `openclaw/CLAWHUB_SUBMISSION.md` for listing copy and submission notes.
- Each skill directory also includes a small `README.md` for marketplace copy.

Suggested publish paths:

- Publish each skill to ClawHub as its own bundle.
- Keep the repo folder layout stable so a later OpenClaw plugin can reference
  these same skills if we decide to ship one.

When to add a plugin later:

- if we need OpenClaw-native commands or tools
- if we want packaged install/config behavior
- if we want plugin-gated skill activation tied to OpenClaw config
