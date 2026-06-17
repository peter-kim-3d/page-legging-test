#!/usr/bin/env bash
# launch-chrome.sh
# Open Chrome with a localhost-only CDP debug endpoint so measure.mjs can drive
# the live browser. Uses an ISOLATED profile dir (we do NOT copy your main
# profile's cookies). The FIRST run may require a one-time SSO login in the
# opened window; the session then persists in the isolated profile for reuse.
#
# Usage: ./scripts/launch-chrome.sh [port]
set -euo pipefail

PORT="${1:-9222}"
PROFILE_DIR="${PERF_CHROME_PROFILE:-$(pwd)/.perf-runs/chrome-profile}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -x "$CHROME" ]]; then
  echo "ERROR: Chrome executable not found: $CHROME"
  echo "   Set the CHROME_BIN environment variable to the correct path."
  exit 1
fi

mkdir -p "$PROFILE_DIR"

echo "Launching the measurement Chrome instance..."
echo "  Debug endpoint : http://127.0.0.1:${PORT}  (localhost only)"
echo "  Profile dir    : ${PROFILE_DIR}"
echo "                   (isolated profile; first run may need a one-time SSO login, then reused)"
echo "  Security       : main-profile cookies are NOT copied; port binds to 127.0.0.1 only; close the window when done."
echo ""
echo "-> Keep this window open, then in another terminal:  node src/measure.mjs <url> --runs 7"
echo ""

exec "$CHROME" \
  --remote-debugging-port="${PORT}" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="${PROFILE_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  --new-window "about:blank"
