#!/usr/bin/env bash
set -euo pipefail

SERVER_NAME="${ENGRM_OPENCLAW_MCP_NAME:-engrm}"
SERVER_URL="${1:-${ENGRM_OPENCLAW_MCP_URL:-}}"
SERVER_TOKEN="${2:-${ENGRM_OPENCLAW_MCP_TOKEN:-}}"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw is not installed or not on PATH"
  exit 1
fi

if [[ -z "${SERVER_URL}" || -z "${SERVER_TOKEN}" ]]; then
  echo "Usage: $0 <url> <bearer-token>"
  echo "Or set ENGRM_OPENCLAW_MCP_URL and ENGRM_OPENCLAW_MCP_TOKEN."
  exit 1
fi

if ! openclaw mcp --help >/dev/null 2>&1; then
  echo "This OpenClaw build does not support 'openclaw mcp'. Update OpenClaw first."
  exit 1
fi

json=$(python3 - "${SERVER_URL}" "${SERVER_TOKEN}" <<'PY'
import json, sys
url = sys.argv[1]
token = sys.argv[2]
print(json.dumps({
    "url": url,
    "headers": {
        "Authorization": f"Bearer {token}",
    },
}))
PY
)

openclaw mcp set "${SERVER_NAME}" "${json}"
echo "Registered OpenClaw MCP server '${SERVER_NAME}'."
openclaw mcp show "${SERVER_NAME}" --json
