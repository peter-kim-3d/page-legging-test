# AGENTS.md

Web page rendering-latency (lagging) diagnosis toolkit. Runs **100% locally — no LLM,
no network, no dependencies**. Workflow: test the page in Chrome → download the HAR →
investigate. Localizes where page load time is spent (backend / network / payload /
connection / client render).

Full agent guidance (Copilot CLI and others): **`.github/copilot-instructions.md`**.

## Commands

- `npm run analyze -- <file.har>` — HAR diagnosis (the "investigate" step)
- `npm test` — offline self-test

Input: `har/` · Output: `.perf-runs/`

## SECURITY (must follow)

- Never commit raw HARs or `.perf-runs/` (already gitignored).
- Never send raw HAR / headers / cookies / query strings / bodies to any model or cloud.
- Only `*.sanitized.json` (timing-only) is shareable. See `ai/PROMPT.md`.
- Read the auth/status audit first: auth failures = logged-out capture = untrustworthy timings.
