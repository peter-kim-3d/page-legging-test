#!/usr/bin/env bash
# cron-run.sh — scheduled lagging check.
# Auto-picks: Tier A (HARs already in har/) OR Tier B (measure LAGGING_URL via a
# running, logged-in Chrome). Writes a timestamped report under .perf-runs/cron/.
# Exits non-zero when the result is FAIL or an auth/session failure is detected,
# so cron / CI can alert.
#
# Config via environment (all optional):
#   LAGGING_URL       target URL for Tier B (used only when har/ has no HARs)
#   LAGGING_RUNS      Tier B run count (default 10)
#   LAGGING_ENDPOINT  CDP endpoint (default http://127.0.0.1:9222)
#   LAGGING_NAME      report name (default run-<timestamp>)
#   LAGGING_WATERFALL "1" (default) to embed a waterfall in Tier A reports, "0" to skip
#   LAGGING_PDF       "1" to also emit a PDF (self-contained via Chrome), "0" (default)
#
# Example crontab (every weekday at 9am):
#   0 9 * * 1-5  cd /path/to/page-legging-test && LAGGING_URL="https://internal/page" ./scripts/cron-run.sh >> cron.log 2>&1
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

TS="$(date +%Y%m%d-%H%M%S)"
NAME="${LAGGING_NAME:-run-$TS}"
OUT_DIR=".perf-runs/cron/$TS"
RUNS="${LAGGING_RUNS:-10}"
ENDPOINT="${LAGGING_ENDPOINT:-http://127.0.0.1:9222}"
mkdir -p "$OUT_DIR"

WF_FLAG=""; [ "${LAGGING_WATERFALL:-1}" = "1" ] && WF_FLAG="--waterfall"
PDF_FLAG=""; [ "${LAGGING_PDF:-0}" = "1" ] && PDF_FLAG="--pdf"

shopt -s nullglob
HARS=(har/*.har)
rc=0

if [ ${#HARS[@]} -gt 0 ]; then
  echo "[cron $TS] Tier A — ${#HARS[@]} HAR(s) in har/"
  node src/har-report.mjs har/ --name "$NAME" --date "$TS" --out "$OUT_DIR/report.md" $WF_FLAG $PDF_FLAG --exit-code
  rc=$?
elif [ -n "${LAGGING_URL:-}" ]; then
  echo "[cron $TS] Tier B — measuring $LAGGING_URL"
  if ! curl -sf "$ENDPOINT/json/version" >/dev/null 2>&1; then
    echo "[cron $TS] ERROR: CDP endpoint $ENDPOINT unreachable. Start a logged-in Chrome first:"
    echo "           ./scripts/launch-chrome.sh   (log in once; the session persists)"
    exit 3
  fi
  node src/measure.mjs "$LAGGING_URL" --runs "$RUNS" --endpoint "$ENDPOINT" \
    --out "$OUT_DIR/measure.sanitized.json" --exit-code
  rc=$?
else
  echo "[cron $TS] Nothing to do: no HARs in har/ and LAGGING_URL not set."
  exit 2
fi

echo "[cron $TS] done (exit $rc). Output: $OUT_DIR"
exit $rc
