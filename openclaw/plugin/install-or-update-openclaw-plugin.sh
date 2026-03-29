#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="engrm"
PACKAGE_NAME="engrm-openclaw-plugin"

repair_openclaw_plugin_config() {
  python3 - <<'PY'
from pathlib import Path
import json

config_path = Path.home() / ".openclaw" / "openclaw.json"
if not config_path.exists():
    raise SystemExit(0)

obj = json.loads(config_path.read_text())
plugins = obj.setdefault("plugins", {})

allow = plugins.setdefault("allow", [])
allow = ["engrm" if item == "engrm-openclaw-plugin" else item for item in allow]
if "engrm" not in allow:
    allow.append("engrm")
plugins["allow"] = allow

entries = plugins.setdefault("entries", {})
if "engrm-openclaw-plugin" in entries and "engrm" not in entries:
    entries["engrm"] = entries.pop("engrm-openclaw-plugin")
elif "engrm-openclaw-plugin" in entries and "engrm" in entries:
    entries.pop("engrm-openclaw-plugin")

config_path.write_text(json.dumps(obj, indent=2) + "\n")
print("Repaired OpenClaw plugin config to stable id 'engrm'.")
PY
}

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw is not installed or not on PATH"
  exit 1
fi

if openclaw plugins list 2>/dev/null | grep -qE '(^|[[:space:]])engrm([[:space:]]|$)'; then
  echo "Updating existing Engrm OpenClaw plugin..."
  openclaw plugins update "$PLUGIN_ID"
else
  echo "Installing Engrm OpenClaw plugin..."
  openclaw plugins install "$PACKAGE_NAME"
fi

repair_openclaw_plugin_config

echo "Engrm OpenClaw plugin install/update complete."
