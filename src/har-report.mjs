#!/usr/bin/env node
// src/har-report.mjs — TIER A, multi-capture
// Aggregate several HAR captures of the SAME page into one test-style report
// (Markdown + sanitized JSON), with p50/p95 across captures and PASS/WARN/FAIL
// performance assertions. Use --pdf for a self-contained PDF (no external tools).
//
//   node src/har-report.mjs <har... | dir> [--name "Page"] [--out file.md]
//
// Capture several CLEAN HARs first. In DevTools: turn OFF "Preserve log" (or
// click Clear before each), then reload -> "Save all as HAR". Each HAR must be a
// single fresh load. 5+ captures give a stable p50/p95.

import { readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadHar, buildStatusAudit, pct, median } from './har-core.mjs';
import { diagnosePage } from './diagnose.mjs';
import { buildSanitizedSummary } from './sanitize.mjs';
import { buildWaterfallSvg } from './waterfall.mjs';
import { renderMarkdownToPdf } from './pdf.mjs';

const PHASES = ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive', 'total'];
const BOOL_FLAGS = new Set(['pdf', 'waterfall', 'exit-code']); // flags that take no value

// ---- args ----
const positionals = [];
const flags = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const key = a[i].slice(2);
      if (BOOL_FLAGS.has(key)) { flags[key] = true; }
      else { flags[key] = a[i + 1]; i += 1; }
    } else positionals.push(a[i]);
  }
}
if (!positionals.length) {
  console.error('Usage: node src/har-report.mjs <har... | dir> [--name "Page"] [--out file.md] [--pdf]');
  process.exit(1);
}

// Expand positionals (files or a directory) into a HAR file list.
const harFiles = [];
for (const p of positionals) {
  let st;
  try { st = statSync(p); } catch { console.error(`not found: ${p}`); continue; }
  if (st.isDirectory()) for (const f of readdirSync(p).sort()) { if (f.endsWith('.har')) harFiles.push(join(p, f)); }
  else harFiles.push(p);
}
if (!harFiles.length) { console.error('No .har files found.'); process.exit(1); }

// ---- load all captures ----
const captures = [];
for (const f of harFiles) {
  try { captures.push({ file: f, ...loadHar(f) }); }
  catch (e) { console.error(`skip ${f}: ${e.message}`); }
}
if (!captures.length) { console.error('No readable HARs.'); process.exit(1); }

const name = flags.name || (captures[0].docEntry.host + captures[0].docEntry.path);
const target = `https://${captures[0].docEntry.host}${captures[0].docEntry.path}`;

// Output paths (computed early so the embedded waterfall can derive its names).
mkdirSync('.perf-runs', { recursive: true });
const safeName = name.replace(/[^a-z0-9._-]+/gi, '_');
const outMd = flags.out || `.perf-runs/${safeName}.report.md`;
const outJson = outMd.replace(/\.md$/i, '.sanitized.json');

// ---- aggregate per request across captures ----
const map = new Map();
for (const cap of captures) {
  for (const e of cap.entries) {
    const key = `${e.method} ${e.host}${e.path}`;
    if (!map.has(key)) {
      map.set(key, { sample: e, phases: Object.fromEntries(PHASES.map((p) => [p, []])), statuses: [], serverTiming: e.serverTiming });
    }
    const slot = map.get(key);
    for (const p of PHASES) slot.phases[p].push(e.timings[p] || 0);
    slot.statuses.push(e.status);
  }
}
const requests = [];
for (const slot of map.values()) {
  const timings = {};
  for (const p of PHASES) timings[p] = Math.round(median(slot.phases[p]));
  const worstStatus = slot.statuses.reduce((w, s) => (s >= 400 ? s : w), slot.statuses[0] || 0);
  requests.push({
    method: slot.sample.method, host: slot.sample.host, path: slot.sample.path,
    status: worstStatus, mimeType: slot.sample.mimeType, resourceType: slot.sample.resourceType,
    requestBytes: 0, responseBytes: slot.sample.responseBytes || 0,
    timings,
    timingsP95: { total: Math.round(pct(slot.phases.total, 95)), wait: Math.round(pct(slot.phases.wait, 95)) },
    startedMs: 0,
    serverTiming: slot.serverTiming,
    samples: slot.phases.total.length,
  });
}

// ---- page metrics across captures ----
const loads = captures.map((c) => c.pageMetrics.load).filter((v) => v > 0);
const transfers = captures.map((c) => c.pageMetrics.transferBytes);
const reqCounts = captures.map((c) => c.pageMetrics.totalRequests);
const pageMetrics = {
  captures: captures.length,
  totalRequests: Math.round(median(reqCounts)),
  load: { p50: Math.round(median(loads)), p95: Math.round(pct(loads, 95)), min: Math.round(Math.min(...loads)), max: Math.round(Math.max(...loads)) },
  transferBytes: Math.round(median(transfers)),
};

// ---- status audit (union of all captures) ----
const allEntries = captures.flatMap((c) => c.entries);
const navStatuses = captures.map((c) => c.docEntry.status);
const audit = buildStatusAudit(allEntries, navStatuses);

// ---- diagnose ----
const verdict = diagnosePage(requests, {}, { backendThresholdMs: 1000, negligibleMs: 50 });
const enriched = verdict.enriched;

// ---- assertions (the "test" structure) ----
const BUDGETS = {
  loadMs: { warn: 3000, fail: 6000 },
  docTtfbMs: { warn: 800, fail: 1800 },
  backendWaitMs: { warn: 1000, fail: 3000 },
  transferMB: { warn: 2, fail: 5 },
};
const grade = (v, b) => (v < b.warn ? 'PASS' : v < b.fail ? 'WARN' : 'FAIL');

const docReq = enriched.find((r) => r.resourceType === 'document') || enriched[0];
const slowestBackend = [...enriched].filter((r) => r.dominant?.layer === 'backend').sort((a, b) => b.timings.wait - a.timings.wait)[0];
const backendWait = slowestBackend ? slowestBackend.timings.wait : 0;
const transferMB = pageMetrics.transferBytes / (1024 * 1024);

const tests = [
  {
    id: 'AUTH', name: 'Authentication / session integrity',
    result: audit.authFailures.length === 0 ? 'PASS' : 'FAIL',
    evidence: audit.authFailures.length === 0
      ? 'No auth/session-failure responses across captures.'
      : `${audit.authFailures.length} auth/session failure(s): ${audit.authFailures.map((r) => `${r.status} ${r.path}`).join('; ')}. Capture may be logged-out/degraded — results not trustworthy.`,
  },
  {
    id: 'DOC', name: 'Document responds 200',
    result: audit.navStatuses.every((s) => s === 200) ? 'PASS' : 'FAIL',
    evidence: `Document status across captures: ${audit.navStatuses.join(', ') || '?'}.`,
  },
  {
    id: 'HTTP', name: 'HTTP response health (no 4xx/5xx)',
    result: audit.byClass['5xx'] > 0 ? 'FAIL' : (audit.nonOk.length > 0 ? 'WARN' : 'PASS'),
    evidence: audit.nonOk.length === 0
      ? 'All responses 2xx.'
      : `${audit.nonOk.length} non-2xx: ${audit.nonOk.slice(0, 6).map((r) => `${r.status} ${r.path}`).join('; ')}${audit.nonOk.length > 6 ? ' …' : ''}.`,
  },
  {
    id: 'TTFB', name: `Document TTFB within budget (<${BUDGETS.docTtfbMs.warn}ms)`,
    result: grade(docReq?.timings.wait || 0, BUDGETS.docTtfbMs),
    evidence: `Document server wait p50 = ${docReq?.timings.wait || 0}ms (p95 ${docReq?.timingsP95?.wait || 0}ms).`,
  },
  {
    id: 'BACKEND', name: `Worst backend TTFB within budget (<${BUDGETS.backendWaitMs.warn}ms)`,
    result: grade(backendWait, BUDGETS.backendWaitMs),
    evidence: slowestBackend
      ? `Slowest backend: ${slowestBackend.method} ${slowestBackend.host}${slowestBackend.path} — wait p50 ${backendWait}ms / p95 ${slowestBackend.timingsP95?.wait || 0}ms.`
      : 'No backend-dominated request.',
  },
  {
    id: 'LOAD', name: `Page onLoad within budget (<${BUDGETS.loadMs.warn}ms)`,
    result: grade(pageMetrics.load.p50, BUDGETS.loadMs),
    evidence: `onLoad p50 = ${pageMetrics.load.p50}ms (p95 ${pageMetrics.load.p95}ms, range ${pageMetrics.load.min}–${pageMetrics.load.max}ms over ${captures.length} captures).`,
  },
  {
    id: 'WEIGHT', name: `Transfer weight within budget (<${BUDGETS.transferMB.warn}MB)`,
    result: grade(transferMB, BUDGETS.transferMB),
    evidence: `Median transfer = ${transferMB.toFixed(2)}MB across ${pageMetrics.totalRequests} requests.`,
  },
];

const counts = { PASS: 0, WARN: 0, FAIL: 0 };
for (const t of tests) counts[t.result] += 1;
const overall = counts.FAIL ? 'FAIL' : (counts.WARN ? 'WARN' : 'PASS');

// ---- recommendations (by owner, derived from worst layers) ----
const OWNER = {
  backend: { owner: 'backend', action: 'Profile server processing (TTFB), add Server-Timing, cache/edge the endpoint.' },
  payload: { owner: 'frontend/infra', action: 'Verify gzip/brotli, code-split & lazy-load large bundles, serve via CDN.' },
  connection: { owner: 'frontend/infra', action: 'Reduce parallel same-origin requests, ensure HTTP/2, consolidate assets.' },
  network: { owner: 'infra', action: 'Check DNS/TLS/proxy and enable keep-alive / connection reuse.' },
  client: { owner: 'frontend', action: 'Reduce main-thread work; code-split and defer non-critical JS (use Tier B to confirm).' },
};
const recs = [];
const seenLayer = new Set();
for (const r of [...enriched].sort((a, b) => b.timings.total - a.timings.total)) {
  const l = r.dominant?.layer;
  if (!l || l === 'cached' || seenLayer.has(l) || !OWNER[l]) continue;
  seenLayer.add(l);
  recs.push(`- **${OWNER[l].owner}** — ${OWNER[l].action}  \n  _Top offender:_ \`${r.method} ${r.host}${r.path}\` (${r.timings.total}ms, ${l}).`);
  if (recs.length >= 5) break;
}

// ---- top bottlenecks table ----
const ranked = [...enriched].sort((a, b) => b.timings.total - a.timings.total).slice(0, parseInt(flags.top || '15', 10));
const tableRows = ranked.map((r, i) => `| ${i + 1} | ${r.timings.total} | ${r.timingsP95?.total || 0} | ${r.timings.wait} | ${r.timings.receive} | ${r.timings.blocked} | ${r.status || '-'} | ${r.dominant?.layer || ''} | \`${r.method} ${r.host}${r.path}\` |`).join('\n');

// ---- per-capture variance table ----
const varRows = captures.map((c, i) => `| ${i + 1} | ${c.file.split('/').pop()} | ${Math.round(c.pageMetrics.load)} | ${c.pageMetrics.totalRequests} | ${(c.pageMetrics.transferBytes / 1024 / 1024).toFixed(2)} |`).join('\n');

// ---- optional embedded waterfall (--waterfall): use the median-onLoad capture ----
let waterfallSection = '';
if (flags.waterfall) {
  const byLoad = [...captures].sort((a, b) => a.pageMetrics.load - b.pageMetrics.load);
  const rep = byLoad[Math.floor(byLoad.length / 2)];
  const repFile = rep.file.split('/').pop();
  const wf = buildWaterfallSvg(rep.entries, rep.pageMetrics, {
    title: `Network waterfall — ${rep.docEntry.host}${rep.docEntry.path}`,
    subtitle: `representative capture: ${repFile} · onLoad ${Math.round(rep.pageMetrics.load)}ms`,
  });
  const svgPath = outMd.replace(/\.md$/i, '.waterfall.svg');
  writeFileSync(svgPath, wf.svg);
  // Embed the SVG inline: renders in the PDF (Chromium) and in VS Code preview.
  // The standalone .svg is written alongside for zoomable / GitHub viewing.
  waterfallSection = `\n## Network waterfall (representative capture)\n\n${wf.svg}\n\n_Chronological request timeline. Phase colors: blocked / dns / connect / ssl / send / **wait (TTFB)** / receive. Dashed lines = DOMContentLoaded & onLoad. Representative = median-onLoad capture (${repFile}, ${Math.round(rep.pageMetrics.load)}ms). A request wave that only starts after a big asset finishes reveals a waterfall dependency. Zoomable SVG: ${svgPath.split('/').pop()}._\n`;
}

const MARK = { PASS: '🟢 PASS', WARN: '🟡 WARN', FAIL: '🔴 FAIL' };
const stamp = flags.date || 'see file mtime';
const hasServerTiming = enriched.some((r) => r.serverTiming && r.serverTiming.length);

const md = `# Web Performance Test Report — ${name}

**Target:** ${target}
**Method:** Tier A (HAR) · ${captures.length} captures aggregated (p50/p95)
**Generated:** ${stamp}
**Overall result:** ${MARK[overall]}  ·  ${counts.PASS} pass / ${counts.WARN} warn / ${counts.FAIL} fail

---

## 1. Verdict

> ${verdict.headline}
${verdict.details.length ? `>\n${verdict.details.map((d) => `> - ${d}`).join('\n')}` : ''}

## 2. Summary metrics (across ${captures.length} captures)

| Metric | p50 | p95 | Budget | Result |
|---|--:|--:|---|:--:|
| onLoad | ${pageMetrics.load.p50}ms | ${pageMetrics.load.p95}ms | < ${BUDGETS.loadMs.warn}ms | ${MARK[grade(pageMetrics.load.p50, BUDGETS.loadMs)]} |
| Document TTFB | ${docReq?.timings.wait || 0}ms | ${docReq?.timingsP95?.wait || 0}ms | < ${BUDGETS.docTtfbMs.warn}ms | ${MARK[grade(docReq?.timings.wait || 0, BUDGETS.docTtfbMs)]} |
| Worst backend TTFB | ${backendWait}ms | ${slowestBackend?.timingsP95?.wait || 0}ms | < ${BUDGETS.backendWaitMs.warn}ms | ${MARK[grade(backendWait, BUDGETS.backendWaitMs)]} |
| Transfer weight | ${transferMB.toFixed(2)}MB | — | < ${BUDGETS.transferMB.warn}MB | ${MARK[grade(transferMB, BUDGETS.transferMB)]} |
| Requests | ${pageMetrics.totalRequests} | — | — | — |

## 3. Test cases (assertions)

${tests.map((t) => `### ${t.id} — ${t.name}\n**Result:** ${MARK[t.result]}\n\n${t.evidence}`).join('\n\n')}

## 4. Top bottlenecks (ranked, p50 across captures)

| # | p50 | p95 | wait | recv | blk | status | layer | request |
|--:|--:|--:|--:|--:|--:|:--:|---|---|
${tableRows}
${waterfallSection}
## 5. Per-capture variance

| # | file | onLoad (ms) | requests | transfer (MB) |
|--:|---|--:|--:|--:|
${varRows}

onLoad range ${pageMetrics.load.min}–${pageMetrics.load.max}ms (median ${pageMetrics.load.p50}ms). Wide spread = run conditions vary; trust p50 over any single capture.

## 6. Status & auth audit

- Status classes: \`${JSON.stringify(audit.byClass)}\`
- Document status: ${audit.navStatuses.join(', ')}
- Non-2xx: ${audit.nonOk.length ? audit.nonOk.map((r) => `${r.status} ${r.method} ${r.host}${r.path}`).join('; ') : 'none'}
- Server-Timing present: ${hasServerTiming ? 'yes' : 'no — backend sub-phase breakdown unavailable; ask backend to emit Server-Timing'}

## 7. Recommendations (by owner)

${recs.join('\n') || '- No actionable layer above the negligible threshold.'}

## 8. Methodology & caveats

- **Capture protocol:** DevTools → Network → Preserve log OFF (or Clear each time) → reload → Save all as HAR. Each HAR = one fresh load.
- **Cache state matters:** HAR captures cannot be auto-classified cold/warm. Cold loads are payload-heavy (full downloads); for backend isolation, capture warm (Disable cache OFF after the first load) or use Tier B.
- **Tier A limits:** LCP / Long Tasks / main-thread timings are not in HAR — use Tier B (CDP) for client-render metrics.
- **Security:** raw HARs (with cookies/headers) stay local; only the sanitized JSON beside this report is AI-shareable.
`;

// ---- write outputs ----
writeFileSync(outMd, md);

const summary = buildSanitizedSummary({
  source: 'har-multi', target, runs: captures.length,
  requests: enriched, pageMetrics: { load: pageMetrics.load, totalRequests: pageMetrics.totalRequests, transferBytes: pageMetrics.transferBytes },
  statusAudit: audit,
  warnings: tests.filter((t) => t.result !== 'PASS').map((t) => `[${t.result}] ${t.name}: ${t.evidence}`),
  capturedRequests: pageMetrics.totalRequests,
  verdict: [verdict.headline, ...verdict.details],
});
writeFileSync(outJson, JSON.stringify(summary, null, 2));

// ---- optional PDF (--pdf): self-contained via playwright-core + marked. No LLM. ----
let pdfOut = null;
if (flags.pdf) {
  const target = outMd.replace(/\.md$/i, '.pdf');
  try {
    await renderMarkdownToPdf(md, target, { title: name, date: stamp });
    pdfOut = target;
  } catch (e) {
    console.error(`(--pdf) PDF generation failed: ${e.message}`);
  }
}

// ---- console summary ----
console.log(`\n=== Performance Test Report: ${name} ===`);
console.log(`Captures: ${captures.length} · Overall: ${overall} (${counts.PASS} pass / ${counts.WARN} warn / ${counts.FAIL} fail)`);
for (const t of tests) console.log(`  [${t.result}] ${t.id} — ${t.name}`);
console.log(`\nReport (Markdown): ${outMd}`);
console.log(`Summary (sanitized JSON): ${outJson}`);
if (pdfOut) console.log(`Report (PDF): ${pdfOut}`);
else if (!flags.pdf) console.log('To PDF: re-run with --pdf (self-contained, no external tools).');

// --exit-code: non-zero when overall is FAIL (for cron / CI gating).
if (flags['exit-code']) process.exit(overall === 'FAIL' ? 1 : 0);
