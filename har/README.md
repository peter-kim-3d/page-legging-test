# har/ — put your HAR captures here

Export HARs from Chrome DevTools into this folder, then run the report:

```bash
node src/har-report.mjs har/ --name "My Page" --waterfall --pdf
```

## Capture protocol (clean, no leftover)

1. DevTools (F12) → **Network** tab
2. Turn **Preserve log OFF** (so each reload resets the buffer) — or click **Clear** (🚫) before each
3. Reload the page → right-click → **Save all as HAR** → save here as e.g. `cap-1.har`
4. Repeat 5+ times for stable p50/p95

## Security

`*.har` and `*.json` in this folder are **gitignored** — raw HARs contain cookies and
tokens, so they never leave your machine. Only the generated `*.sanitized.json` in
`.perf-runs/` is safe to share. This README is the only tracked file here.
