// src/har-core.mjs
// HAR parsing used by analyze.mjs. Pure functions only — no console / no output.

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
