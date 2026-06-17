// src/har-core.mjs
// Shared HAR parsing used by har-analyze (single capture) and har-report
// (multi-capture aggregation). Pure functions only — no console / no output.

import { readFileSync } from 'node:fs';
import { stripUrl } from './sanitize.mjs';

export const AUTH_RE = /(log-?in|logout|session|auth|token|oauth|sso|saml)/i;
export const AUTH_FAIL_STATUS = new Set([400, 401, 403, 407, 419, 440]);

function n(v) { return typeof v === 'number' && v >= 0 ? v : 0; }

export function parseServerTiming(headers) {
  const h = (headers || []).find((x) => (x.name || '').toLowerCase() === 'server-timing');
  if (!h || !h.value) return null;
  return h.value.split(',').map((part) => {
    const segs = part.split(';').map((s) => s.trim());
    const name = segs[0];
    let dur = null;
    for (const s of segs.slice(1)) { const m = s.match(/dur\s*=\s*([\d.]+)/i); if (m) dur = parseFloat(m[1]); }
    return { name, dur };
  }).filter((x) => x.name);
}

export function inferType(mime = '') {
  if (!mime) return '';
  if (mime.includes('html')) return 'document';
  if (mime.includes('javascript')) return 'script';
  if (mime.includes('css')) return 'stylesheet';
  if (mime.includes('json')) return 'xhr';
  if (mime.startsWith('image/')) return 'image';
  if (mime.includes('font')) return 'font';
  return 'other';
}

export function normalizeEntry(entry, t0) {
  const t = entry.timings || {};
  const ssl = n(t.ssl);
  const connect = Math.max(0, n(t.connect) - ssl); // HAR spec: ssl time is included in connect
  const timings = {
    blocked: n(t.blocked), dns: n(t.dns), connect, ssl,
    send: n(t.send), wait: n(t.wait), receive: n(t.receive),
  };
  timings.total = typeof entry.time === 'number' && entry.time >= 0
    ? entry.time
    : Object.values(timings).reduce((a, b) => a + b, 0);
  const { host, path } = stripUrl(entry.request?.url || '');
  const startedMs = entry.startedDateTime ? (Date.parse(entry.startedDateTime) - t0) : 0;
  return {
    method: entry.request?.method || 'GET',
    host, path,
    status: entry.response?.status ?? 0,
    mimeType: entry.response?.content?.mimeType || '',
    resourceType: entry._resourceType || inferType(entry.response?.content?.mimeType),
    requestBytes: Math.max(0, n(entry.request?.headersSize) + n(entry.request?.bodySize)),
    responseBytes: entry.response?._transferSize ?? Math.max(0, n(entry.response?.bodySize)),
    timings,
    startedMs,
    serverTiming: parseServerTiming(entry.response?.headers),
  };
}

/** Load + normalize one HAR file. Returns { entries, docEntry, pageMetrics }. */
export function loadHar(path) {
  let har;
  try { har = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`Failed to parse HAR ${path}: ${e.message}`); }
  const raw = har?.log?.entries || [];
  if (!raw.length) throw new Error(`HAR ${path} has no entries.`);
  const t0 = Date.parse(raw[0].startedDateTime) || 0;
  const entries = raw.map((e) => normalizeEntry(e, t0));
  const docEntry = entries.find((e) => e.resourceType === 'document') || entries[0];
  const onLoad = har.log.pages?.[0]?.pageTimings?.onLoad;
  const onContentLoad = har.log.pages?.[0]?.pageTimings?.onContentLoad;
  const span = Math.max(0, ...entries.map((e) => e.startedMs + e.timings.total));
  const pageMetrics = {
    load: typeof onLoad === 'number' && onLoad >= 0 ? onLoad : span,
    domContentLoaded: typeof onContentLoad === 'number' && onContentLoad >= 0 ? onContentLoad : null,
    wallMs: span,
    totalRequests: entries.length,
    transferBytes: entries.reduce((a, e) => a + (e.responseBytes || 0), 0),
  };
  return { entries, docEntry, pageMetrics };
}

/** Status-code audit over a flat list of normalized entries (deduped by key). */
export function buildStatusAudit(entries, navStatuses = []) {
  const map = new Map();
  for (const e of entries) {
    const key = `${e.method} ${e.host}${e.path}`;
    const prev = map.get(key);
    if (!prev || (e.status >= 400 && prev.status < 400)) {
      map.set(key, { method: e.method, host: e.host, path: e.path, status: e.status });
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
  return { byClass, nonOk, authFailures, navStatuses: [...new Set(navStatuses)], totalUnique: all.length };
}

export const pct = (values, p) => {
  const arr = values.filter((v) => typeof v === 'number');
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
};
export const median = (a) => pct(a, 50);
