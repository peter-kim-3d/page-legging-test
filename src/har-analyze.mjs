#!/usr/bin/env node
// src/har-analyze.mjs — TIER A (single capture, zero runtime deps)
// Parse one Chrome-exported HAR, rank requests, localize the bottleneck per the
// decision tree, and emit a SANITIZED summary safe to hand to an AI.
// For multiple captures + a test-style report, use src/har-report.mjs.
//
//   node src/har-analyze.mjs <path-to.har> [--top 15] [--out file.json]

import { writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { loadHar, AUTH_RE, AUTH_FAIL_STATUS } from './har-core.mjs';
import { classifyRequest, diagnosePage } from './diagnose.mjs';
import { buildSanitizedSummary } from './sanitize.mjs';

function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; }
function pad(s, w) { s = String(s); return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length); }
function padL(s, w) { s = String(s); return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

const harPath = process.argv[2];
if (!harPath || harPath.startsWith('--')) {
  console.error('Usage: node src/har-analyze.mjs <path-to.har> [--top 15] [--out file.json]');
  process.exit(1);
}
const topN = parseInt(arg('--top', '15'), 10);

// Single-capture status audit: counts every entry (duplicates kept, so a URL
// requested twice in one load is visible).
function buildStatusAudit(entries, docEntry) {
  const byClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  for (const r of entries) {
    const c = Math.floor((r.status || 0) / 100);
    byClass[c === 2 ? '2xx' : c === 3 ? '3xx' : c === 4 ? '4xx' : c === 5 ? '5xx' : 'other'] += 1;
  }
  const nonOk = entries.filter((r) => r.status && (r.status < 200 || r.status >= 300));
  const authFailures = entries.filter((r) => AUTH_RE.test(r.path) && AUTH_FAIL_STATUS.has(r.status));
  const navStatuses = docEntry ? [docEntry.status] : [];
  return { byClass, nonOk, authFailures, navStatuses, totalUnique: entries.length };
}

function buildWarnings(audit) {
  const w = [];
  if (audit.authFailures.length) w.push(`WARNING: ${audit.authFailures.length} auth/session failure(s) — this HAR may be a logged-out/degraded session. Re-capture while authenticated.`);
  if (audit.navStatuses.some((s) => s >= 300)) w.push(`WARNING: document response is not 200 (status ${audit.navStatuses.join(',')}) — may be a login redirect / blocked page.`);
  if (audit.nonOk.length) w.push(`${audit.nonOk.length} non-2xx responses (3xx/4xx/5xx). See statusAudit.`);
  return w;
}

// ---- load ----
let loaded;
try { loaded = loadHar(harPath); }
catch (e) { console.error(e.message); process.exit(1); }
const { entries, docEntry, pageMetrics } = loaded;

// ---- diagnose ----
const verdict = diagnosePage(entries, pageMetrics, { backendThresholdMs: 1000, negligibleMs: 50 });
const audit = buildStatusAudit(entries, docEntry);
const warnings = buildWarnings(audit);

// ---- console report ----
console.log('\n=== Lagging diagnosis (Tier A / HAR) ===');
console.log(`Source: ${harPath}`);
console.log(`Requests: ${pageMetrics.totalRequests}  ·  onLoad: ${Math.round(pageMetrics.load)}ms  ·  transfer: ${(pageMetrics.transferBytes / 1024).toFixed(0)}KB`);
if (warnings.length) {
  console.log('\nWarnings:');
  for (const wmsg of warnings) console.log(`    ${wmsg}`);
}
console.log('\nStatus codes:', JSON.stringify(audit.byClass), `· document ${audit.navStatuses.join(',') || '?'}`);
if (audit.nonOk.length) {
  console.log('Non-2xx responses:');
  audit.nonOk.slice(0, 10).forEach((r) => {
    const tag = audit.authFailures.includes(r) ? '  <- auth failure' : '';
    console.log(`  ${r.status}  ${r.method} ${r.host}${r.path}`.slice(0, 90) + tag);
  });
}
console.log(`\n>>> Diagnosis: ${verdict.headline}`);
for (const d of verdict.details) console.log(`    - ${d}`);

const ranked = [...entries].sort((a, b) => (b.timings.total || 0) - (a.timings.total || 0)).slice(0, topN);
console.log(`\nTop ${ranked.length} (by total time):`);
console.log(pad('#', 3) + pad('total', 8) + pad('wait', 8) + pad('recv', 8) + pad('conn', 7) + pad('dns', 6) + pad('blk', 7) + pad('layer', 11) + 'method host/path');
console.log('-'.repeat(110));
ranked.forEach((e, i) => {
  const c = classifyRequest(e);
  console.log(
    pad(i + 1, 3)
    + padL(Math.round(e.timings.total), 6) + '  '
    + padL(Math.round(e.timings.wait), 6) + '  '
    + padL(Math.round(e.timings.receive), 6) + '  '
    + padL(Math.round(e.timings.connect + e.timings.ssl), 5) + '  '
    + padL(Math.round(e.timings.dns), 4) + '  '
    + padL(Math.round(e.timings.blocked), 5) + '  '
    + pad(c.layer, 11)
    + pad(e.method, 7) + `${e.host}${e.path}`.slice(0, 45),
  );
});

const byWait = [...entries].filter((e) => e.timings.wait > 0).sort((a, b) => b.timings.wait - a.timings.wait).slice(0, 5);
if (byWait.length) {
  console.log('\nTop 5 by server processing (wait):');
  byWait.forEach((e, i) => console.log(`  ${i + 1}. ${padL(Math.round(e.timings.wait), 6)}ms  ${e.method} ${e.host}${e.path}`.slice(0, 90)));
}

// ---- sanitized output (AI-shareable) ----
const summary = buildSanitizedSummary({
  source: 'har',
  target: `https://${docEntry.host}${docEntry.path}`,
  runs: 1,
  requests: verdict.enriched,
  pageMetrics,
  statusAudit: audit,
  warnings,
  capturedRequests: entries.length,
  verdict: [verdict.headline, ...verdict.details],
});
mkdirSync('.perf-runs', { recursive: true });
const outFile = arg('--out', `.perf-runs/${basename(harPath).replace(/\.har$/i, '')}.sanitized.json`);
writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(`\nSaved AI-shareable summary (sanitized): ${outFile}`);
console.log('   -> Share only this file with Copilot etc. Keep the raw HAR local.');
