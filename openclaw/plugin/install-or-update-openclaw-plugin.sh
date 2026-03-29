#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="engrm"
PACKAGE_NAME="engrm-openclaw-plugin"

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
