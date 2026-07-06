#!/usr/bin/env bash
# Resolve the browser + the volleybot CLI, then run a blocking handoff. Used by
# the human-handoff OpenClaw skill. Returns when the human has solved the wall.
#
#   handoff.sh "<reason shown to the human>"
#
# CDP endpoint resolution (first hit wins):
#   1. $VOLLEYBOT_CDP                         (explicit override)
#   2. `agent-browser get cdp-url`            (the browser your agent is driving)
#   3. http://localhost:9222                  (a plain remote-debugging-port Chrome)
set -euo pipefail

REASON="${1:-A human verification step is blocking the agent.}"
# Optional 2nd arg (or $VOLLEYBOT_PAGE_URL): when several tabs are open, target
# the one whose URL contains this substring instead of the active tab.
PAGE_URL="${2:-${VOLLEYBOT_PAGE_URL:-}}"

CDP="${VOLLEYBOT_CDP:-}"
if [ -z "$CDP" ] && command -v agent-browser >/dev/null 2>&1; then
  # agent-browser exposes the live CDP WebSocket URL of its managed browser, so
  # the human drives the exact same session — no shared-port setup required.
  CDP="$(agent-browser get cdp-url 2>/dev/null | tr -d '[:space:]' || true)"
fi
CDP="${CDP:-http://localhost:9222}"

# Locate the volleybot CLI: PATH (npm link) first, then $VOLLEYBOT_HOME/bin.
if command -v volleybot >/dev/null 2>&1; then
  VB=(volleybot)
elif [ -n "${VOLLEYBOT_HOME:-}" ] && [ -f "$VOLLEYBOT_HOME/bin/volleybot.js" ]; then
  VB=(node "$VOLLEYBOT_HOME/bin/volleybot.js")
else
  echo "volleybot CLI not found." >&2
  echo "  Fix: run 'npm link' in the volleybot repo (puts 'volleybot' on PATH)," >&2
  echo "  or set VOLLEYBOT_HOME=/path/to/volleybot" >&2
  exit 127
fi

ARGS=(handoff --cdp "$CDP" --reason "$REASON")
[ -n "$PAGE_URL" ] && ARGS+=(--page-url "$PAGE_URL")
# The human solves on a phone, so emulate a portrait viewport by default.
# Disable with VOLLEYBOT_MOBILE=0; restored to desktop when the agent resumes.
[ "${VOLLEYBOT_MOBILE:-1}" != "0" ] && ARGS+=(--mobile)

echo "volleybot: handing off (cdp=$CDP${PAGE_URL:+, tab~=$PAGE_URL})" >&2
exec "${VB[@]}" "${ARGS[@]}"
