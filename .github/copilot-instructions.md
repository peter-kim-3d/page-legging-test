# Copilot instructions — web lagging diagnosis toolkit

This repo localizes **where a web page's load time is spent** (backend / network /
payload / connection / client render) from Chrome captures. It runs **100% locally —
no LLM, no network, no API keys** (an AI is optional, only for narrating the sanitized
summary).

## Commands (all local, no LLM)

- Single HAR:        `npm run analyze -- <file.har>`
- Multi-HAR report:  `npm run report -- har/ --name "Page" --waterfall --pdf`
- Waterfall diagram: `npm run waterfall -- <file.har> --png`
- Automated (CDP):   `npm run measure -- <url> --runs 10`  (run `./scripts/launch-chrome.sh` first)
- Scheduled runner:  `npm run cron`  (Tier A if `har/` has HARs, else Tier B if `LAGGING_URL` is set)
- Self-test:         `npm test`

Input HARs go in `har/`. All outputs go in `.perf-runs/`.

## How it classifies a bottleneck (decision tree)

Per request, the dominant timing phase maps to a layer:
- `wait` (TTFB) → **backend** (server processing)
- `blocked` → **connection** (queueing / parallel-connection limit)
- `dns` / `connect` / `ssl` → **network** (DNS / proxy / TLS)
- `receive` → **payload** (download size)
- high LCP / LongTasks with low network → **client** (JS render)
- a request that starts late → **waterfall** (serial dependency)

**Always read the status / auth audit FIRST.** Auth/session failures (401/400 on
login/session endpoints) mean the capture is logged-out and the timings are NOT
trustworthy — say so before reporting anything else.

## SECURITY — hard rules (financial / internal context)

- **Never commit** raw HARs or `.perf-runs/` outputs. `.gitignore` already excludes them.
- Raw HARs contain cookies, tokens, and bodies. **Keep them local.** Never paste raw HAR,
  headers, cookies, query strings, or response bodies into any chat, model, or cloud tool.
- Only the generated `*.sanitized.json` is shareable — it is timing numbers only. The
  sanitizer (`src/sanitize.mjs`) strips headers/cookies/tokens/query/bodies and enforces an
  `assertNoSensitive()` gate. When an AI write-up is wanted, feed ONLY that file (see
  `ai/PROMPT.md`).
- Tier B never touches passwords/cookies — it attaches to the user's already-logged-in
  Chrome over a **localhost-only** CDP port.

## When asked to investigate a slow page

1. Check inputs: HARs in `har/`, or a target URL + a running authenticated Chrome.
2. Run `npm run report` (Tier A) or `npm run measure` (Tier B).
3. Read the warnings (auth/status) first.
4. Report the top bottleneck by **layer + owner**, citing the concrete numbers. Do not
   invent or assume data the capture does not contain.

## Architecture (where things live)

- `src/diagnose.mjs` — the decision-tree classifier (the reusable core)
- `src/sanitize.mjs` — the security hard-gate (AI-shareable summary)
- `src/har-core.mjs` — shared HAR parsing
- `src/har-analyze.mjs` / `har-report.mjs` / `har-waterfall.mjs` — Tier A tools
- `src/measure.mjs` — Tier B (CDP) tool
- `src/waterfall.mjs` — SVG waterfall builder
- `scripts/launch-chrome.sh` — open Chrome with a debug port (keeps auth)
- `scripts/cron-run.sh` — scheduled runner
