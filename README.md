# page-legging-test — web rendering latency (lagging) diagnosis toolkit

When a web page is slow, this toolkit pinpoints **which layer the time is leaking from**
(backend / network / payload / connection / client-side rendering) using reproducible
measurement. It is designed to be **reusable for lagging investigations on any web page**,
not just one target.

Two paths are provided:

| | Tier A (HAR) | Tier B (CDP, automated) |
|---|---|---|
| Method | Export a HAR from DevTools → analyze locally | Attach to a logged-in Chrome and measure N times |
| Install | **None** (Node built-ins only) | `npm install` (playwright-core, no browser download) |
| Repeatability | single snapshot | p50/p95 (repeated runs) |
| Strength | fastest & safest, zero barrier | reusable, automated, precise |

> Key metric: the suspect request's **`wait` (TTFB / server processing time)**. If it is ~6s, the backend is confirmed (not network or frontend).

---

## Install

```bash
cd page-legging-test
npm install          # only needed for Tier B. Tier A runs with no install.
npm test             # offline self-check (gate + decision tree)
```

---

## Company setup (GitHub + cron + Copilot)

```bash
git clone <your-repo-url> page-legging-test
cd page-legging-test
npm install && npm test
```

**Runs 100% locally — no LLM, no network, no API keys.** Only commits code; raw HARs
(`har/*.har`) and all outputs (`.perf-runs/`) are gitignored and never leave the machine.

### Schedule with cron (`scripts/cron-run.sh`)

The runner auto-picks Tier A (if `har/` has HARs) or Tier B (if `LAGGING_URL` is set),
writes a timestamped report to `.perf-runs/cron/<ts>/`, and **exits non-zero on a FAIL or
auth/session failure** so cron can alert.

```bash
# Tier B (automated): measure an internal URL on a schedule.
# First, launch a logged-in Chrome ONCE (the isolated profile keeps the session):
./scripts/launch-chrome.sh

# crontab -e  → every weekday 9am:
0 9 * * 1-5  cd /path/to/page-legging-test && LAGGING_URL="https://internal/page" ./scripts/cron-run.sh >> cron.log 2>&1
```

Config env vars: `LAGGING_URL`, `LAGGING_RUNS` (10), `LAGGING_ENDPOINT`
(`http://127.0.0.1:9222`), `LAGGING_PDF` (0), `LAGGING_WATERFALL` (1).
If the auth session expires, the run flags `auth/session failure` and exits non-zero.

### Copilot CLI

`.github/copilot-instructions.md` (and `AGENTS.md`) give Copilot CLI the commands,
the decision tree, and the security rules — so it can drive the toolkit and respects
"never send raw HAR/cookies to the cloud; only `*.sanitized.json` is shareable."

---

## Tier A — capture a HAR → analyze (fastest, safest)

1. Chrome DevTools (F12) → **Network** tab
2. Check **Preserve log** + **Disable cache**
3. **Reload** the target page (wait until loading finishes)
4. Right-click in the Network panel → **Save all as HAR** → e.g. `page.har`
5. Analyze:

```bash
node src/har-analyze.mjs page.har
# or change how many rows to show:  node src/har-analyze.mjs page.har --top 20
```

Output: a diagnosis headline + a ranked request table (total/wait/recv/conn/dns/blk +
the bottleneck layer) + the top 5 by `wait`. It also writes
`.perf-runs/page.sanitized.json` (AI-shareable, sensitive data removed).

---

## Tier A multi-capture — test report (md + pdf)

One HAR is a single sample with high variance. Capture **several clean HARs** of
the same page and aggregate them into one test-style report (p50/p95 +
PASS/WARN/FAIL assertions).

**Capture protocol (clean, no leftover):** in DevTools turn **Preserve log OFF**
(so each reload auto-resets the buffer) — or click **Clear** (🚫 / Ctrl+L) before
each reload — then reload → **Save all as HAR**. Each HAR = one fresh load.
Save 5+ into a folder, e.g. `har/cap-1.har … har/cap-5.har`.

```bash
node src/har-report.mjs har/                          # a folder of *.har
node src/har-report.mjs a.har b.har c.har             # explicit files
node src/har-report.mjs har/ --name "Products" --waterfall --pdf   # md + json + embedded waterfall + pdf
```

Output: `.perf-runs/<name>.report.md` (test report) + `.sanitized.json`. The report has:
overall PASS/WARN/FAIL, summary metrics vs budgets, per-assertion test cases,
ranked bottlenecks (p50/p95), per-capture variance, status/auth audit, and
owner-tagged recommendations.

Flags:
- `--waterfall` — embed a chronological waterfall diagram (inline SVG, from the
  median-onLoad capture) into the report; also writes a standalone `.waterfall.svg`.
- `--pdf` — also render the report to PDF. **Self-contained** (playwright-core +
  marked + the installed Chrome) — no external tools. Set `CHROME_BIN` if Chrome
  is not at the default macOS path.
- `--name "X"` / `--out file.md` — report title / output path.

---

## Tier A waterfall — chronological diagram (svg / png)

Render every request laid out by start time, segmented by phase, with
DOMContentLoaded / onLoad milestone lines — like the DevTools Network waterfall.
Pure code, no LLM, no deps for the SVG. One HAR (a waterfall is a single
timeline; pick one representative capture).

```bash
node src/har-waterfall.mjs har/cap-3.har                 # → .perf-runs/cap-3.waterfall.svg
node src/har-waterfall.mjs har/cap-3.har --png           # also rasterize to PNG (uses installed Chrome)
node src/har-waterfall.mjs har/cap-3.har --ascii         # also print a compact ASCII waterfall to console
```

Phase colors: blocked / dns / connect / ssl / send / **wait (TTFB)** / receive.
Red labels = non-2xx requests. The diagram exposes waterfall dependencies (e.g.
a request wave that only starts after a big bundle finishes).

---

## Tier B — automated CDP measurement (repeatable, reusable)

```bash
# 1) Launch the measurement Chrome (localhost debug port). Keep this window open.
./scripts/launch-chrome.sh
#    On the first run, log in once (SSO) in the opened window; the isolated profile keeps it.

# 2) In another terminal, measure N times
node src/measure.mjs "https://internal.example.com/page" --runs 7

# Isolate just the suspect API calls:
node src/measure.mjs "https://internal.example.com/page" --runs 7 --filter xhr,fetch
```

Output: p50/p95 page metrics (load/LCP/TTFB/LongTasks) + per-request p50/p95 ranking +
diagnosis. Writes `.perf-runs/measure-7runs.sanitized.json`.

---

## Diagnosis decision tree (the reusable core)

Each request is classified by its **dominant phase** into a bottleneck layer.
The same logic applies to any site.

| Dominant phase | Bottleneck layer | Next action (owner) |
|---|---|---|
| `wait` (TTFB) | **backend** | Check Server-Timing, hand the endpoint to backend (suspect token introspection / downstream) |
| `blocked` | **connection** | HTTP/1.1 ~6-connection limit. Parallelize / HTTP/2 (frontend/infra) |
| `dns`/`connect`/`ssl` | **network** | DNS / proxy / TLS (infra) |
| `receive` | **payload** | Response size / compression / CDN (backend/infra) |
| LCP↑ & LongTask↑ & network↓ | **client** | Main-thread blocking / bundles (frontend) |
| API starts *late* | **waterfall** | Shorten the serial dependency chain (frontend) |

---

## Security model (financial / internal — top priority)

- **No credential handling**: Tier B only attaches to the live authenticated browser. It never reads or stores passwords/cookies.
- **Debug port**: binds to `127.0.0.1` only. Closing the Chrome window stops it (`launch-chrome.sh`).
- **Isolated profile**: does not copy your main-profile cookies. The login session lives only in `.perf-runs/chrome-profile/` (gitignored).
- **Raw stays local**: HAR and full traces never leave the machine. `.perf-runs/` and `*.har` are gitignored.
- **AI boundary (hard gate)**: `src/sanitize.mjs` strips all headers, cookies, tokens, query strings, and bodies, leaving timing numbers only, and writes `*.sanitized.json`. `assertNoSensitive()` blocks any forbidden key as a last line of defense.
  **Share only that file with an AI** (see `ai/PROMPT.md`). Never share the raw capture.

Verify: open `.perf-runs/*.sanitized.json` and confirm no cookies/tokens/bodies/query strings before using an AI.

---

## File layout

```
src/sanitize.mjs       security hard gate (builds the AI-shareable summary)
src/diagnose.mjs       decision-tree classifier (localizes the bottleneck layer) — reusable core
src/har-core.mjs       shared HAR parsing (used by har-analyze + har-report)
src/har-analyze.mjs    Tier A: single HAR → ranking, diagnosis, summary
src/har-report.mjs     Tier A multi-capture: N HARs → test report (md/pdf) + summary
src/har-waterfall.mjs  Tier A: one HAR → chronological waterfall diagram (svg/png)
src/measure.mjs        Tier B: CDP repeated measurement → p50/p95, diagnosis, summary
scripts/launch-chrome.sh  launch Chrome with a debug port (keeps auth)
ai/PROMPT.md           AI prompt that takes only the sanitized summary
```

## Troubleshooting

- **`Failed to connect`**: check that `./scripts/launch-chrome.sh` is running and the port (default 9222) matches.
- **0 requests / 401**: confirm the opened Chrome window is logged in to the target page (one-time login on first run).
- **Different Chrome path**: `CHROME_BIN=/path/to/chrome ./scripts/launch-chrome.sh`
- **`networkidle` never settles (SPA polling)**: normal. It proceeds automatically after 30s.
