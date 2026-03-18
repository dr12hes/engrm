# Engrm OpenAI / Codex Skills Submission

This file is the source of truth for publishing Engrm skills into Codex-facing
registries and the `openai/skills` ecosystem.

## Skills to publish

- `engrm-memory`
- `engrm-delivery-review`
- `engrm-sentinel`

## Positioning

Engrm gives coding agents:

- cross-device and cross-agent memory reuse
- delivery review that compares the brief with what appears to have been delivered
- Sentinel and pack-aware safety guidance for risky coding work

## Recommended descriptions

### engrm-memory

Use Engrm memory deliberately before coding, during coding, and after coding so
Codex can reuse prior decisions, bugfixes, discoveries, and project context.

### engrm-delivery-review

Use Engrm to compare the brief, plan, and decisions against what actually
happened in the session. Good for spotting drift, partial delivery, and weak
decision trails.

### engrm-sentinel

Use Engrm packs and Sentinel context to surface likely mistakes, risky coding
patterns, and lessons that would have prevented them earlier.

## Suggested tags

- codex
- memory
- delivery-review
- safety
- mcp
- coding-agent

## Packaging

Generate bundles with:

```bash
python3 codex/package_codex_skills.py
```

Output:

- `codex/dist/engrm-memory.zip`
- `codex/dist/engrm-delivery-review.zip`
- `codex/dist/engrm-sentinel.zip`

## Notes

- These skills are intentionally portable and should work well both in Codex and
  in broader skill registries that accept `SKILL.md` bundles.
- If we later need deeper Codex-native behavior, we can add richer integration
  without changing the skill names or core story.
