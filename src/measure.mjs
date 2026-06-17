#!/usr/bin/env node
// src/measure.mjs — TIER B
// Connect to an ALREADY-RUNNING, ALREADY-AUTHENTICATED Chrome over CDP, load a
// page N times, and produce p50/p95 timing breakdowns + bottleneck diagnosis.
// We never read or store passwords/cookies — we just drive the live browser.
//
// Prereq: run ./scripts/launch-chrome.sh first (opens Chrome on 127.0.0.1:9222).
//   node src/measure.mjs <url> [--runs 7] [--endpoint http://127.0.0.1:9222]
//                              [--filter xhr,fetch,document] [--out file.json]

import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { diagnosePage } from './diagnose.mjs';
import { buildSanitizedSummary, stripUrl } from './sanitize.mjs';

function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; }
function pad(s, w) { s = String(s); return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length); }
function padL(s, w) { s = String(s); return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

const url = process.argv[2];
if (!url || url.startsWith('--')) {
  console.error('Usage: node src/measure.mjs <url> [--runs 7] [--endpoint http://127.0.0.1:9222] [--filter xhr,fetch] [--out file.json]');
  process.exit(1);
}
const runs = parseInt(arg('--runs', '7'), 10);
const endpoint = arg('--endpoint', 'http://127.0.0.1:9222');
const filterArg = arg('--filter', '');
const typeFilter = filterArg ? new Set(filterArg.split(',').map((s) => s.trim())) : null;
const exitFlag = process.argv.includes('--exit-code');

const AUTH_RE = /(log-?in|logout|session|auth|token|oauth|sso|saml)/i;
const AUTH_FAIL_STATUS = new Set([400, 401, 403, 407, 419, 440]);

// Resource Timing (Playwright request.timing()) → our phase model.
function phasesFromPw(t) {
  const g = (a, b) => (typeof a === 'number' && a >= 0 && typeof b === 'number' && b >= 0 ? Math.max(0, a - b) : 0);
  const dns = g(t.domainLookupEnd, t.domainLookupStart);
  const connectFull = g(t.connectEnd, t.connectStart);
  const ssl = (typeof t.secureConnectionStart === 'number' && t.secureConnectionStart >= 0 && typeof t.connectEnd === 'number' && t.connectEnd >= 0)
    ? Math.max(0, t.connectEnd - t.secureConnectionStart) : 0;
  const connect = Math.max(0, connectFull - ssl);
  const wait = g(t.responseStart, t.requestStart);     // TTFB / server processing
  const receive = g(t.responseEnd, t.responseStart);
  const connEnd = t.connectEnd >= 0 ? t.connectEnd : (t.domainLookupEnd >= 0 ? t.domainLookupEnd : 0);
  const blocked = t.requestStart >= 0 ? Math.max(0, t.requestStart - connEnd) : 0;
  const total = t.responseEnd >= 0 ? t.responseEnd : (dns + connect + ssl + wait + receive + blocked);
  return { blocked, dns, connect, ssl, send: 0, wait, receive, total };
}

function parseServerTiming(headerVal) {
  if (!headerVal) return null;
  return headerVal.split(',').map((part) => {
    const segs = part.split(';').map((s) => s.trim());
    const name = segs[0];
    let dur = null;
    for (const s of segs.slice(1)) { const m = s.match(/dur\s*=\s*([\d.]+)/i); if (m) dur = parseFloat(m[1]); }
    return { name, dur };
  }).filter((x) => x.name);
}

// Collected in-page after load. Uses buffered PerformanceObservers for LCP/longtask.
const PERF_SCRIPT = `() => new Promise(resolve => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paints = performance.getEntriesByType('paint');
  const fcp = (paints.find(p => p.name === 'first-contentful-paint') || {}).startTime || 0;
  let lcp = 0, longTasksTotal = 0, longTasksCount = 0, lcpObs, ltObs;
  try { lcpObs = new PerformanceObserver(l => { const e = l.getEntries(); if (e.length) lcp = e[e.length-1].startTime; }); lcpObs.observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
  try { ltObs = new PerformanceObserver(l => { for (const e of l.getEntries()) { longTasksTotal += e.duration; longTasksCount++; } }); ltObs.observe({ type: 'longtask', buffered: true }); } catch (e) {}
  setTimeout(() => {
    try { lcpObs && lcpObs.disconnect(); } catch (e) {}
    try { ltObs && ltObs.disconnect(); } catch (e) {}
    resolve({
      ttfb: nav.responseStart || 0, fcp, lcp,
      domContentLoaded: nav.domContentLoadedEventEnd || 0,
      load: nav.loadEventEnd || 0,
      transferBytes: nav.transferSize || 0,
      longTasksTotal, longTasksCount,
    });
  }, 300);
})`;

function pct(values, p) {
  const arr = values.filter((v) => typeof v === 'number');
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
const median = (a) => pct(a, 50);

// Per-request p50/p95 across runs.
function aggregateRequests(perRun) {
  const map = new Map();
  for (const run of perRun) {
    for (const e of run.entries) {
      const key = `${e.method} ${e.host}${e.path}`;
      if (!map.has(key)) {
        map.set(key, {
          sample: e,
          phases: { blocked: [], dns: [], connect: [], ssl: [], send: [], wait: [], receive: [], total: [] },
          serverTiming: e.serverTiming,
        });
      }
      const slot = map.get(key);
      for (const p of Object.keys(slot.phases)) slot.phases[p].push(e.timings[p] || 0);
    }
  }
  const requests = [];
  for (const slot of map.values()) {
    const timings = {};
    for (const p of Object.keys(slot.phases)) timings[p] = Math.round(median(slot.phases[p]));
    requests.push({
      method: slot.sample.method, host: slot.sample.host, path: slot.sample.path,
      status: slot.sample.status, mimeType: slot.sample.mimeType, resourceType: slot.sample.resourceType,
      requestBytes: 0, responseBytes: 0,
      timings,
      timingsP95: { total: Math.round(pct(slot.phases.total, 95)), wait: Math.round(pct(slot.phases.wait, 95)) },
      startedMs: 0,
      serverTiming: slot.serverTiming,
      samples: slot.phases.total.length,
    });
  }
  return requests;
}

function cohort(slice) {
  const c = (f) => slice.map((r) => r.metrics?.[f] || 0).filter((v) => v > 0);
  return {
    n: slice.length,
    load: Math.round(median(c('load'))),
    lcp: Math.round(median(c('lcp'))),
    ttfb: Math.round(median(c('ttfb'))),
    fcp: Math.round(median(c('fcp'))),
  };
}

// Status-code audit + auth/session-failure detection across all runs.
function buildStatusAudit(perRun) {
  const map = new Map();
  for (const run of perRun) {
    for (const e of run.entries) {
      const key = `${e.method} ${e.host}${e.path}`;
      const prev = map.get(key);
      // Prefer to surface an error status if any run saw one.
      if (!prev || (e.status >= 400 && prev.status < 400)) {
        map.set(key, { method: e.method, host: e.host, path: e.path, status: e.status });
      }
    }
  }
  const all = [...map.values()];
  const byClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  for (const r of all) {
    const c = Math.floor((r.status || 0) / 100);
    byClass[c === 2 ? '2xx' : c === 3 ? '3xx' : c === 4 ? '4xx' : c === 5 ? '5xx' : 'other'] += 1;
  }
  const nonOk = all.filter((r) => r.status && (r.status < 200 || r.status >= 300));
  const authFailures = all.filter((r) => AUTH_RE.test(r.path) && AUTH_FAIL_STATUS.has(r.status));
  const navStatuses = [...new Set(perRun.map((r) => r.navStatus).filter((s) => s))];
  return { byClass, nonOk, authFailures, navStatuses, totalUnique: all.length };
}

function buildWarnings(audit) {
  const w = [];
  if (audit.authFailures.length) {
    w.push(`WARNING: ${audit.authFailures.length} auth/session failure(s) — this capture may be a logged-out/degraded session. Re-measure while authenticated before trusting results.`);
  }
  if (audit.navStatuses.some((s) => s >= 300)) {
    w.push(`WARNING: document response is not 200 (status ${audit.navStatuses.join(',')}) — may have measured a login redirect / blocked page.`);
  }
  if (audit.nonOk.length) {
    w.push(`${audit.nonOk.length} non-2xx responses (3xx/4xx/5xx). See statusAudit.`);
  }
  if (runs < 15) {
    w.push(`p95 is from ${runs} runs — effectively the single worst (mostly cold) run. Use 20+ warm runs for a stable tail.`);
  }
  return w;
}

function printReport(target, requests, pageMetrics, verdict, audit, warnings, cohorts) {
  console.log(`\n=== Lagging diagnosis (Tier B / CDP, ${requests[0]?.samples || 0} runs) ===`);
  console.log(`URL: ${target}`);

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

  if (cohorts.warm.n) {
    console.log(`\ncold (first load) load/LCP: ${cohorts.cold.load}/${cohorts.cold.lcp}ms   |   warm (repeat n=${cohorts.warm.n}) load/LCP: ${cohorts.warm.load}/${cohorts.warm.lcp}ms`);
  }
  console.log(`overall p50/p95: load ${pageMetrics.load.p50}/${pageMetrics.load.p95}ms · LCP ${pageMetrics.lcp.p50}/${pageMetrics.lcp.p95}ms · TTFB ${pageMetrics.ttfb.p50}ms · LongTasks ${pageMetrics.longTasksTotal.p50}ms`);

  console.log(`\n>>> Diagnosis: ${verdict.headline}`);
  for (const d of verdict.details) console.log(`    - ${d}`);

  const ranked = [...requests].sort((a, b) => (b.timings.total || 0) - (a.timings.total || 0)).slice(0, 15);
  console.log(`\nTop ${ranked.length} (by p50 total time):`);
  console.log(pad('#', 3) + pad('p50', 7) + pad('p95', 7) + pad('wait', 7) + pad('recv', 7) + pad('st', 5) + pad('layer', 11) + 'method host/path');
  console.log('-'.repeat(105));
  ranked.forEach((e, i) => {
    console.log(
      pad(i + 1, 3)
      + padL(Math.round(e.timings.total), 5) + '  '
      + padL(Math.round(e.timingsP95?.total || 0), 5) + '  '
      + padL(Math.round(e.timings.wait), 5) + '  '
      + padL(Math.round(e.timings.receive), 5) + '  '
      + pad(e.status || '-', 5)
      + pad(e.dominant?.layer || '', 11)
      + pad(e.method, 7) + `${e.host}${e.path}`.slice(0, 40),
    );
  });
}

async function main() {
  console.log(`Connecting to CDP: ${endpoint} ...`);
  let browser;
  try { browser = await chromium.connectOverCDP(endpoint); }
  catch (e) {
    console.error(`\nFailed to connect to Chrome: ${e.message}`);
    console.error('   Run ./scripts/launch-chrome.sh first to open the debug port.');
    process.exit(1);
  }
  const context = browser.contexts()[0] || await browser.newContext();
  console.log(`Connected. Starting ${runs} run(s) -> ${url}\n`);

  const perRun = [];
  for (let i = 0; i < runs; i++) {
    const page = await context.newPage();
    const collected = [];
    let failedCount = 0;
    page.on('requestfinished', (req) => collected.push(req));
    page.on('requestfailed', () => { failedCount += 1; });
    let metrics = {};
    let navStatus = 0;
    try {
      const navResp = await page.goto(url, { waitUntil: 'load', timeout: 120000 });
      navStatus = navResp ? navResp.status() : 0;
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      metrics = await page.evaluate(`(${PERF_SCRIPT})()`);
    } catch (e) {
      console.error(`  run ${i + 1}: load failed — ${e.message}`);
    }

    const entries = [];
    for (const req of collected) {
      let timing = null; let resp = null; let headers = {};
      try { timing = req.timing(); } catch (e) { /* not finished */ }
      if (!timing) continue;
      if (typeFilter && !typeFilter.has(req.resourceType())) continue;
      try { resp = await req.response(); } catch (e) { /* no response */ }
      try { headers = resp ? await resp.headers() : {}; } catch (e) { /* */ }
      const { host, path } = stripUrl(req.url());
      entries.push({
        method: req.method(), host, path,
        status: resp ? resp.status() : 0,
        mimeType: (headers['content-type'] || '').split(';')[0],
        resourceType: req.resourceType(),
        requestBytes: 0, responseBytes: 0,
        timings: phasesFromPw(timing),
        startedMs: 0,
        serverTiming: parseServerTiming(headers['server-timing']),
      });
    }
    perRun.push({ entries, metrics, navStatus, failedCount });
    console.log(`  run ${i + 1}/${runs}: doc=${navStatus} load=${Math.round(metrics.load || 0)}ms lcp=${Math.round(metrics.lcp || 0)}ms reqs=${entries.length}${failedCount ? ` failed=${failedCount}` : ''}`);
    await page.close().catch(() => {});
  }
  await browser.close().catch(() => {}); // disconnects only; user's Chrome stays open

  if (!perRun.some((r) => r.entries.length)) {
    console.error('\nNo requests captured. Check the URL / login state.');
    process.exit(1);
  }

  // ---- aggregate ----
  const requests = aggregateRequests(perRun);
  const collectPm = (f) => perRun.map((r) => r.metrics?.[f] || 0).filter((v) => v > 0);
  const pageMetrics = {
    totalRequests: Math.round(median(perRun.map((r) => r.entries.length))),
    load: { p50: Math.round(median(collectPm('load'))), p95: Math.round(pct(collectPm('load'), 95)) },
    lcp: { p50: Math.round(median(collectPm('lcp'))), p95: Math.round(pct(collectPm('lcp'), 95)) },
    ttfb: { p50: Math.round(median(collectPm('ttfb'))), p95: Math.round(pct(collectPm('ttfb'), 95)) },
    fcp: { p50: Math.round(median(collectPm('fcp'))), p95: Math.round(pct(collectPm('fcp'), 95)) },
    longTasksTotal: { p50: Math.round(median(collectPm('longTasksTotal'))), p95: Math.round(pct(collectPm('longTasksTotal'), 95)) },
  };
  const cohorts = {
    cold: cohort(perRun.slice(0, 1)),
    warm: perRun.length >= 2 ? cohort(perRun.slice(1)) : { n: 0 },
  };
  const audit = buildStatusAudit(perRun);
  const warnings = buildWarnings(audit);

  const flatPm = { lcp: pageMetrics.lcp.p50, longTasksTotal: pageMetrics.longTasksTotal.p50, load: pageMetrics.load.p50 };
  const verdict = diagnosePage(requests, flatPm, { backendThresholdMs: 1000, negligibleMs: 50 });

  printReport(url, verdict.enriched, pageMetrics, verdict, audit, warnings, cohorts);

  const capturedRequests = Math.round(median(perRun.map((r) => r.entries.length)));
  const summary = buildSanitizedSummary({
    source: 'cdp', target: url, runs,
    requests: verdict.enriched, pageMetrics, cohorts,
    statusAudit: audit, warnings, capturedRequests,
    verdict: [verdict.headline, ...verdict.details],
  });
  mkdirSync('.perf-runs', { recursive: true });
  const out = arg('--out', `.perf-runs/measure-${runs}runs.sanitized.json`);
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nSaved AI-shareable summary (sanitized): ${out}`);
  console.log('   -> Share only this file with Copilot etc.');

  // --exit-code: non-zero on auth/session failure or non-200 document (for cron / CI gating).
  if (exitFlag) {
    const bad = audit.authFailures.length > 0 || audit.navStatuses.some((s) => s >= 300);
    process.exit(bad ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
