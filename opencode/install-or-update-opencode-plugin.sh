#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ENGRM_OPENCODE_SCRIPT_DIR="$SCRIPT_DIR"

python3 - <<'PY'
from pathlib import Path
import json
import shutil
import os

root = Path(os.environ["ENGRM_OPENCODE_SCRIPT_DIR"]).resolve()
repo = root.parent
plugin_source = repo / "opencode" / "plugin" / "engrm-opencode.js"
config_dir = Path.home() / ".config" / "opencode"
plugins_dir = config_dir / "plugins"
config_path = config_dir / "opencode.json"

plugins_dir.mkdir(parents=True, exist_ok=True)
shutil.copy2(plugin_source, plugins_dir / "engrm.js")

if config_path.exists():
    try:
        config = json.loads(config_path.read_text())
    except Exception:
        config = {}
else:
    config = {}

config.setdefault("$schema", "https://opencode.ai/config.json")
mcp = config.setdefault("mcp", {})
mcp["engrm"] = {
    "type": "local",
    "command": ["engrm", "serve"],
    "enabled": True,
    "timeout": 5000,
}

config_path.write_text(json.dumps(config, indent=2) + "\n")

print(f"Installed plugin -> {plugins_dir / 'engrm.js'}")
print(f"Updated config   -> {config_path}")
PY

echo "OpenCode Engrm integration install/update complete."
