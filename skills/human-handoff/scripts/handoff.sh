#!/usr/bin/env bash
# Resolve the volleybot CLI and run a blocking handoff. Used by the
# human-handoff OpenClaw skill. Returns when the human has solved the wall.
#
#   handoff.sh "<reason shown to the human>"
#
# Config via env:
#   VOLLEYBOT_CDP   CDP endpoint of the shared browser (default http://localhost:9222)
#   VOLLEYBOT_HOME  path to the volleybot repo (fallback if `volleybot` isn't on PATH)
set -euo pipefail

CDP="${VOLLEYBOT_CDP:-http://localhost:9222}"
REASON="${1:-A human verification step is blocking the agent.}"

if command -v volleybot >/dev/null 2>&1; then
  exec volleybot handoff --cdp "$CDP" --reason "$REASON"
elif [ -n "${VOLLEYBOT_HOME:-}" ] && [ -f "$VOLLEYBOT_HOME/bin/volleybot.js" ]; then
  exec node "$VOLLEYBOT_HOME/bin/volleybot.js" handoff --cdp "$CDP" --reason "$REASON"
else
  echo "volleybot CLI not found." >&2
  echo "  Fix: run 'npm link' in the volleybot repo (puts 'volleybot' on PATH)," >&2
  echo "  or set VOLLEYBOT_HOME=/path/to/volleybot" >&2
  exit 127
fi
