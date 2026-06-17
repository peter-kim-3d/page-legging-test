# AI Analysis Prompt (Copilot CLI / Chat)

> WARNING: The ONLY input is a single `.perf-runs/*.sanitized.json` file.
> NEVER paste the raw HAR, network log, headers, cookies, tokens, or response bodies.
> The sanitized.json contains timing numbers only — sensitive data has been removed.

Copy the prompt below and pass it together with the sanitized.json contents.

---

You are a web performance diagnostics engineer. Below is a page-load timing
capture, sanitized (timing numbers only — no headers/cookies/bodies). The JSON
schema is `lagging-toolkit/sanitized-summary@1`. Do not ask for raw headers,
cookies, or bodies; they were intentionally removed.

Each request's `timings` is in milliseconds and has these phases:
- `wait` = server processing time (TTFB). Large => **backend** problem.
- `blocked` = connection queueing. Large => **connection parallelism limit**.
- `dns` / `connect` / `ssl` => **network / proxy / TLS**.
- `receive` = response download. Large => **payload** problem.
- If `page.lcp` / `page.longTasksTotal` are large but network is small => **client-side rendering (JS)**.

Also check `statusAudit`: any `authFailures` (e.g. 401/400 on login/session
endpoints) means the capture may be a logged-out/degraded session — call this
out, because the timings may not represent a normal authenticated user.

Produce:
1. The **single slowest bottleneck** and its layer (backend / connection / network / payload / client).
2. The concrete numbers that justify it (request path + dominant phase value).
3. If any request has a large `wait`, treat it as backend processing and name the `serverTiming` entries to confirm (or note they are absent).
4. **Three next actions** (one line each, with owner: frontend / backend / infra).
5. Anything you cannot conclude from the data alone — mark it "needs more measurement".

JSON:
```json
<paste the contents of .perf-runs/xxx.sanitized.json here>
```
