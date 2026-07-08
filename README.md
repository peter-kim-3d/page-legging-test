# page-legging-test — web rendering latency (lagging) diagnosis toolkit

When a web page is slow, this toolkit pinpoints **which layer the time is leaking from**
(backend / network / payload / connection / client-side rendering).

The whole workflow is three steps:

```
1. Test in Chrome      →  load the slow page with DevTools recording
2. Download the file   →  save the capture as a .har file
3. Investigate         →  node src/analyze.mjs page.har [--waterfall --html --pdf]
```

**100% local** — pure Node (>= 18), no LLM, no network. Analysis, waterfall SVG, and
the HTML report need **no `npm install` at all**; only `--pdf` needs
`npm install` (playwright-core) + a local Chrome. `npm test` runs the offline self-check.

---

## 1. Test in Chrome

1. Open the slow page in Chrome and press **F12** (DevTools) → **Network** tab
2. Check **Disable cache**
3. **Reload** the page and wait until loading finishes

## 2. Download the file

Right-click inside the Network panel → **Save all as HAR** → e.g. `har/page.har`.

> `har/` is gitignored — raw HARs contain cookies/tokens and must stay local.

## 3. Investigate

```bash
node src/analyze.mjs har/page.har              # or: npm run analyze -- har/page.har
node src/analyze.mjs har/page.har --top 20     # show more rows
node src/analyze.mjs har/page.har --waterfall  # + standalone waterfall diagram (.svg)
node src/analyze.mjs har/page.har --html       # + self-contained HTML report (no Chrome needed)
node src/analyze.mjs har/page.har --pdf        # + PDF report (needs npm install + local Chrome)
```

Console output:

- **Diagnosis headline** — the top bottleneck and its layer (e.g. `Layer = BACKEND`)
- Ranked request table (total / wait / recv / conn / dns / blk + layer per request)
- Top 5 by server processing time (`wait`)
- Status / auth audit — warnings if the capture looks logged-out (timings untrustworthy)

Files written to `.perf-runs/`:

| File | Flag | Needs |
|---|---|---|
| `page.sanitized.json` — AI-shareable summary, sensitive data removed | always | nothing |
| `page.waterfall.svg` — chronological waterfall diagram (phase-colored, DCL/onLoad milestones) | `--waterfall` | nothing |
| `page.report.html` — self-contained report: diagnosis + waterfall + tables. Open → Print → "Save as PDF" | `--html` | nothing |
| `page.report.pdf` — same report rendered to PDF directly | `--pdf` | `npm install` + local Chrome |

> `--pdf` on a locked-down corporate machine: if Chrome can't be launched by automation,
> it **auto-falls-back to the `.html`** — open that in your own browser and print to PDF.
> Set `CHROME_BIN=/path/to/chrome` to point at a non-default Chrome.

> Key metric: the suspect request's **`wait` (TTFB / server processing time)**.
> If it is ~6s, the backend is confirmed (not network or frontend).

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

- **No credential handling**: the toolkit never touches the browser — you export the HAR yourself.
- **Raw stays local**: HARs contain cookies, tokens, and bodies. `har/*.har` and `.perf-runs/` are gitignored and never leave the machine.
- **AI boundary (hard gate)**: `src/sanitize.mjs` strips all headers, cookies, tokens, query strings, and bodies, leaving timing numbers only, and writes `*.sanitized.json`. `assertNoSensitive()` blocks any forbidden key as a last line of defense.
  **Share only that file with an AI** (see `ai/PROMPT.md`). Never share the raw capture.

Verify: open `.perf-runs/*.sanitized.json` and confirm no cookies/tokens/bodies/query strings before using an AI.

---

## File layout

```
src/analyze.mjs     step 3 "investigate": one HAR → ranking, diagnosis, sanitized summary + svg/html/pdf
src/har-core.mjs    HAR parsing
src/diagnose.mjs    decision-tree classifier (localizes the bottleneck layer) — reusable core
src/sanitize.mjs    security hard gate (builds the AI-shareable summary)
src/waterfall.mjs   waterfall SVG builder (pure, no deps)
src/report.mjs      HTML report builder + PDF rendering (--pdf only path that needs deps)
src/chrome.mjs      local Chrome detection for --pdf (override: CHROME_BIN)
src/selftest.mjs    offline self-check (npm test)
ai/PROMPT.md        AI prompt that takes only the sanitized summary
```

## Troubleshooting

- **`HAR ... has no entries`**: the Network panel was empty when you saved. Reload with DevTools open, then save again.
- **Auth-failure warnings in the output**: the capture is from a logged-out/degraded session — log in and re-capture.
- **High variance**: one HAR is a single sample. Re-capture 2–3 times and compare the diagnosis; the dominant layer should be stable.
- **`--pdf` fails ("Dependencies missing" / Chrome launch error)**: run `npm install`; if Chrome still can't launch (managed machines), use the auto-written `.html` and print to PDF from your browser, or set `CHROME_BIN`.
