# AGENTS.md

Web page rendering-latency (lagging) diagnosis toolkit. Runs **100% locally — no LLM,
no network**. Workflow: test the page in Chrome → download the HAR →
investigate. Localizes where page load time is spent (backend / network / payload /
connection / client render).

Full agent guidance (Copilot CLI and others): **`.github/copilot-instructions.md`**.

## Commands

- `npm run analyze -- <file.har>` — HAR diagnosis (the "investigate" step; no install needed)
- `... --waterfall` — + waterfall diagram (.svg, no install) · `--html` — + self-contained report (no install; open & Print → Save as PDF) · `--pdf` — + direct PDF (needs `npm install` + local Chrome; auto-falls-back to html)
- `npm test` — offline self-test

Input: `har/` · Output: `.perf-runs/`

## SECURITY (must follow)

- Never commit raw HARs or `.perf-runs/` (already gitignored).
- Never send raw HAR / headers / cookies / query strings / bodies to any model or cloud.
- Only `*.sanitized.json` (timing-only) is shareable. See `ai/PROMPT.md`.
- Read the auth/status audit first: auth failures = logged-out capture = untrustworthy timings.
