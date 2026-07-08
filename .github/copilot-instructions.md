# Copilot instructions — web lagging diagnosis toolkit

This repo localizes **where a web page's load time is spent** (backend / network /
payload / connection / client render). It runs **100% locally — no LLM, no network,
no dependencies** (an AI is optional, only for narrating the sanitized summary).

## Workflow (three steps)

1. **Test in Chrome** — the user loads the slow page with DevTools → Network recording (Disable cache).
2. **Download the file** — right-click the Network panel → Save all as HAR → `har/page.har`.
3. **Investigate** — `npm run analyze -- har/page.har` (or `node src/analyze.mjs har/page.har`).

Input HARs go in `har/`. All outputs go in `.perf-runs/`. Self-test: `npm test`.

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

## When asked to investigate a slow page

1. Check inputs: a HAR in `har/` (if none, walk the user through steps 1–2 above).
2. Run `npm run analyze -- <file.har>`.
3. Read the warnings (auth/status) first.
4. Report the top bottleneck by **layer + owner**, citing the concrete numbers. Do not
   invent or assume data the capture does not contain.

## Architecture (where things live)

- `src/analyze.mjs` — the "investigate" CLI (ranking, diagnosis, sanitized summary)
- `src/har-core.mjs` — HAR parsing
- `src/diagnose.mjs` — the decision-tree classifier (the reusable core)
- `src/sanitize.mjs` — the security hard-gate (AI-shareable summary)
- `src/selftest.mjs` — offline self-check (`npm test`)
