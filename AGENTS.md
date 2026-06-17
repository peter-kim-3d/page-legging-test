# AGENTS.md

Web page rendering-latency (lagging) diagnosis toolkit. Runs **100% locally — no LLM,
no network, no API keys**. Localizes where page load time is spent (backend / network /
payload / connection / client render) from Chrome captures.

Full agent guidance (Copilot CLI and others): **`.github/copilot-instructions.md`**.

## Commands

- `npm run analyze -- <file.har>` — single HAR diagnosis
- `npm run report -- har/ --waterfall --html` — multi-HAR test report (md + json + html; open & Print → Save as PDF). Use `--pdf` if Chrome automation is allowed (auto-falls-back to html).
- `npm run waterfall -- <file.har> --png` — chronological waterfall diagram
- `npm run measure -- <url> --runs 10` — automated CDP (run `./scripts/launch-chrome.sh` first)
- `npm run cron` — scheduled runner (Tier A from `har/`, else Tier B from `LAGGING_URL`)
- `npm test` — self-test

Input: `har/` · Output: `.perf-runs/`

## SECURITY (must follow)

- Never commit raw HARs or `.perf-runs/` (already gitignored).
- Never send raw HAR / headers / cookies / query strings / bodies to any model or cloud.
- Only `*.sanitized.json` (timing-only) is shareable. See `ai/PROMPT.md`.
- Read the auth/status audit first: auth failures = logged-out capture = untrustworthy timings.
