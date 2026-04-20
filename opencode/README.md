# Engrm OpenCode Support

Engrm supports OpenCode in two layers:

- Engrm as an MCP server in `opencode.json`
- a lightweight local OpenCode plugin that improves continuity during compaction

This keeps the OpenCode integration safe:

- MCP stays responsible for durable memory, handoffs, chat recall, and resume tools
- the plugin only adds OpenCode-native continuity behavior where hooks make sense

## Install

Run:

```bash
./opencode/install-or-update-opencode-plugin.sh
```

This will:

- copy the local plugin to `~/.config/opencode/plugins/engrm.js`
- add or update an `engrm` MCP server in `~/.config/opencode/opencode.json`

## Config Shape

The MCP entry written by the helper script matches:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
      "engrm": {
        "type": "local",
        "command": ["node", "/absolute/path/to/engrm/dist/server.js"],
        "enabled": true,
        "timeout": 5000
      }
  }
}
```

An example file also lives at:

- `opencode/opencode.example.json`

## What The Plugin Does

The first OpenCode plugin is intentionally conservative.

- logs plugin initialization through OpenCode's app log
- watches `session.created` and `session.compacted`
- injects Engrm continuity guidance into `experimental.session.compacting`

It does not try to replace Engrm MCP tools or perform undocumented runtime tricks.

## Use With Engrm

Inside OpenCode, the most useful Engrm tools remain:

- `resume_thread`
- `list_recall_items`
- `load_recall_item`
- `repair_recall`
- `search_recall`
- `save_observation`
- `create_handoff`

The plugin exists to make OpenCode compaction preserve that workflow better, not to fork it.
