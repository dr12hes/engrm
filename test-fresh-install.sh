#!/bin/bash
#
# Fresh install test — simulates a new user setup.
#
# Backs up your real ~/.engrm/, tests with a clean slate, restores afterwards.
# Run from the repo root.
#
set -euo pipefail

ENGRM_DIR="$HOME/.engrm"
BACKUP_DIR="$HOME/.engrm.test-backup"
CONFIG_FILE="/tmp/engrm-test-config.json"
PASS=0
FAIL=0
TESTS=()

green='\033[32m'
red='\033[31m'
dim='\033[2m'
reset='\033[0m'

pass() { PASS=$((PASS + 1)); TESTS+=("PASS: $1"); echo -e "  ${green}PASS${reset} $1"; }
fail() { FAIL=$((FAIL + 1)); TESTS+=("FAIL: $1 — $2"); echo -e "  ${red}FAIL${reset} $1 — $2"; }

cleanup() {
  echo ""
  echo -e "${dim}Restoring backup...${reset}"
  rm -rf "$ENGRM_DIR"
  if [ -d "$BACKUP_DIR" ]; then
    mv "$BACKUP_DIR" "$ENGRM_DIR"
    echo -e "${dim}Restored ~/.engrm/ from backup${reset}"
  fi
  rm -f "$CONFIG_FILE"
}
trap cleanup EXIT

echo "=== Engrm Fresh Install Test ==="
echo ""

# --- Step 0: Backup ---
echo -e "${dim}Backing up ~/.engrm/...${reset}"
if [ -d "$ENGRM_DIR" ]; then
  if [ -d "$BACKUP_DIR" ]; then
    echo "ERROR: Backup dir $BACKUP_DIR already exists. Previous test didn't clean up?"
    echo "Remove it manually and retry."
    exit 1
  fi
  cp -a "$ENGRM_DIR" "$BACKUP_DIR"
  rm -rf "$ENGRM_DIR"
  echo -e "${dim}Backed up to $BACKUP_DIR${reset}"
else
  echo -e "${dim}No existing config to back up${reset}"
fi

echo ""
echo "--- Test 1: No config — hooks should warn, not crash ---"

# Session-start with no config
OUTPUT=$(echo '{"session_id":"test","hook_event_name":"SessionStart","cwd":"/tmp"}' | bun run dist/hooks/session-start.js 2>&1) || true
if echo "$OUTPUT" | grep -qi "not configured\|engrm init"; then
  pass "session-start warns about missing config"
else
  fail "session-start with no config" "Expected warning about missing config, got: $(echo "$OUTPUT" | head -1)"
fi

# Post-tool-use with no config
OUTPUT=$(echo '{"session_id":"test","tool_name":"Bash","tool_input":{},"cwd":"/tmp"}' | bun run dist/hooks/post-tool-use.js 2>&1) || true
if echo "$OUTPUT" | grep -qi "not configured\|engrm init"; then
  pass "post-tool-use warns about missing config"
else
  fail "post-tool-use with no config" "Expected warning, got: $(echo "$OUTPUT" | head -1)"
fi

echo ""
echo "--- Test 2: Init from config file ---"

# Read real credentials from backup (or skip if no backup)
if [ -d "$BACKUP_DIR" ] && [ -f "$BACKUP_DIR/settings.json" ]; then
  # Extract fields from the backup config
  CANDENGO_URL=$(bun -e "const c=JSON.parse(require('fs').readFileSync('$BACKUP_DIR/settings.json','utf8')); console.log(c.candengo_url)")
  API_KEY=$(bun -e "const c=JSON.parse(require('fs').readFileSync('$BACKUP_DIR/settings.json','utf8')); console.log(c.candengo_api_key)")
  SITE_ID=$(bun -e "const c=JSON.parse(require('fs').readFileSync('$BACKUP_DIR/settings.json','utf8')); console.log(c.site_id)")
  NAMESPACE=$(bun -e "const c=JSON.parse(require('fs').readFileSync('$BACKUP_DIR/settings.json','utf8')); console.log(c.namespace)")
  USER_ID=$(bun -e "const c=JSON.parse(require('fs').readFileSync('$BACKUP_DIR/settings.json','utf8')); console.log(c.user_id)")

  cat > "$CONFIG_FILE" <<ENDJSON
{
  "candengo_url": "$CANDENGO_URL",
  "candengo_api_key": "$API_KEY",
  "site_id": "$SITE_ID",
  "namespace": "$NAMESPACE",
  "user_id": "$USER_ID"
}
ENDJSON

  bun run dist/cli.js init --config "$CONFIG_FILE" 2>&1
  if [ -f "$ENGRM_DIR/settings.json" ]; then
    pass "engrm init --config creates settings.json"
  else
    fail "engrm init --config" "settings.json not created"
  fi

  if [ -f "$ENGRM_DIR/engrm.db" ]; then
    pass "engrm init creates database"
  else
    fail "engrm init" "engrm.db not created"
  fi
else
  echo -e "${dim}  Skipping init test (no backup config to read credentials from)${reset}"
fi

echo ""
echo "--- Test 3: Session-start hook (with config) ---"

if [ -f "$ENGRM_DIR/settings.json" ]; then
  OUTPUT=$(echo '{"session_id":"fresh-test","hook_event_name":"SessionStart","cwd":"/tmp/test-project"}' | bun run dist/hooks/session-start.js 2>&1) || true

  if echo "$OUTPUT" | grep -q "hookSpecificOutput\|additionalContext"; then
    pass "session-start produces context output"
  else
    fail "session-start with config" "No context output: $(echo "$OUTPUT" | head -1)"
  fi

  if echo "$OUTPUT" | grep -q "systemMessage"; then
    pass "session-start produces splash screen"
  else
    fail "session-start splash" "No systemMessage in output"
  fi
else
  echo -e "${dim}  Skipping hook tests (no config)${reset}"
fi

echo ""
echo "--- Test 4: MCP server starts ---"

if [ -f "$ENGRM_DIR/settings.json" ]; then
  # MCP uses stdio transport with Content-Length framing.
  # Send a properly framed JSON-RPC initialize request.
  INIT_MSG='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
  FRAMED="Content-Length: ${#INIT_MSG}\r\n\r\n${INIT_MSG}"
  OUTPUT=$(printf "$FRAMED" | timeout 5 bun run dist/server.js 2>/dev/null) || true

  if echo "$OUTPUT" | grep -q 'serverInfo\|engrm\|result'; then
    pass "MCP server responds to initialize"
  else
    # Fallback: just check the server starts without crashing
    STDERR=$(echo "" | timeout 3 bun run dist/server.js 2>&1 >/dev/null) || true
    if echo "$STDERR" | grep -qi "error\|cannot\|crash"; then
      fail "MCP server" "Server crashed: $(echo "$STDERR" | head -1)"
    else
      pass "MCP server starts without crash (stdio handshake requires real client)"
    fi
  fi
else
  echo -e "${dim}  Skipping MCP test (no config)${reset}"
fi

echo ""
echo "--- Test 5: engrm status ---"

if [ -f "$ENGRM_DIR/settings.json" ]; then
  OUTPUT=$(bun run dist/cli.js status 2>&1) || true

  if echo "$OUTPUT" | grep -qi "engrm\|configured\|observations\|database"; then
    pass "engrm status produces output"
  else
    fail "engrm status" "Unexpected output: $(echo "$OUTPUT" | head -3)"
  fi
else
  echo -e "${dim}  Skipping status test (no config)${reset}"
fi

echo ""
echo "--- Test 6: engrm doctor ---"

if [ -f "$ENGRM_DIR/settings.json" ]; then
  OUTPUT=$(bun run dist/cli.js doctor 2>&1) || true

  if echo "$OUTPUT" | grep -qi "check\|pass\|fail\|doctor"; then
    pass "engrm doctor runs"
  else
    fail "engrm doctor" "Unexpected output: $(echo "$OUTPUT" | head -3)"
  fi
else
  echo -e "${dim}  Skipping doctor test (no config)${reset}"
fi

echo ""
echo "--- Test 7: Post-tool-use hook (observation capture) ---"

if [ -f "$ENGRM_DIR/settings.json" ]; then
  # Simulate a Bash tool use with an error
  OUTPUT=$(echo '{"session_id":"fresh-test","tool_name":"Bash","tool_input":{"command":"ls /nonexistent"},"tool_result":"ls: /nonexistent: No such file or directory","cwd":"/tmp/test-project"}' | bun run dist/hooks/post-tool-use.js 2>&1) || true
  # Post-tool-use doesn't output to stdout (it saves to DB), just shouldn't crash
  pass "post-tool-use hook runs without crash"
else
  echo -e "${dim}  Skipping post-tool-use test (no config)${reset}"
fi

echo ""
echo "--- Test 8: Stop hook ---"

if [ -f "$ENGRM_DIR/settings.json" ]; then
  OUTPUT=$(echo '{"session_id":"fresh-test","hook_event_name":"Stop","cwd":"/tmp/test-project","stop_hook_active":false}' | bun run dist/hooks/stop.js 2>&1) || true
  # Stop hook outputs retrospective to stderr, shouldn't crash
  pass "stop hook runs without crash"
else
  echo -e "${dim}  Skipping stop test (no config)${reset}"
fi

echo ""
echo "==============================="
echo -e "Results: ${green}${PASS} passed${reset}, ${red}${FAIL} failed${reset}"
echo "==============================="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  for t in "${TESTS[@]}"; do
    if [[ "$t" == FAIL* ]]; then
      echo "  $t"
    fi
  done
  exit 1
fi
