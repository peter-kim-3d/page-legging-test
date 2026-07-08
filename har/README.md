# har/ — put your HAR captures here

Export a HAR from Chrome DevTools into this folder, then investigate:

```bash
node src/analyze.mjs har/page.har
```

## Capture protocol (clean, no leftover)

1. DevTools (F12) → **Network** tab, check **Disable cache**
2. Turn **Preserve log OFF** (so each reload resets the buffer) — or click **Clear** (🚫) before reloading
3. Reload the page → right-click → **Save all as HAR** → save here as e.g. `page.har`

## Security

`*.har` and `*.json` in this folder are **gitignored** — raw HARs contain cookies and
tokens, so they never leave your machine. Only the generated `*.sanitized.json` in
`.perf-runs/` is safe to share. This README is the only tracked file here.
