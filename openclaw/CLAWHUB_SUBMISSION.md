# Engrm ClawHub Submission

This file is the source of truth for packaging and publishing Engrm skills to
OpenClaw / ClawHub.

## Skills to publish

- `engrm-memory`
- `engrm-delivery-review`
- `engrm-sentinel`

## Positioning

Engrm is not just memory storage. The OpenClaw skill bundle teaches agents how
to:

- reuse cross-device and cross-agent memory
- review what was promised vs what appears to have been delivered
- apply Sentinel and pack lessons when code enters risky areas

## Recommended listing descriptions

### engrm-memory

Use Engrm before, during, and after coding so OpenClaw can reuse previous
decisions, bugfixes, discoveries, and project context instead of starting cold.

### engrm-delivery-review

Use Engrm to compare the brief, plan, and decisions against what actually
happened in the session. Good for spotting drift, partial delivery, and weak
decision trails.

### engrm-sentinel

Use Engrm packs and Sentinel context to surface likely mistakes, risky coding
patterns, and reusable lessons that would have prevented them earlier.

## Suggested tags

- memory
- coding
- delivery-review
- safety
- security
- mcp
- team-memory

## Packaging

Generate bundles with:

```bash
python3 openclaw/package_openclaw_skills.py
```

Output:

- `openclaw/dist/engrm-memory.zip`
- `openclaw/dist/engrm-delivery-review.zip`
- `openclaw/dist/engrm-sentinel.zip`

## Notes

- Skills are the right first publish artifact because Engrm already exposes its
  value via MCP tools and workflow guidance.
- A future OpenClaw plugin can reuse these same skill folders if we later need
  custom commands, deeper activation logic, or packaged tool behavior.
