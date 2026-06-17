// src/sanitize.mjs
// SECURITY HARD-GATE.
// Turns rich, possibly-sensitive measurement data into a summary that is SAFE
// to share with an external/cloud AI assistant (Copilot, etc).
//
// Guarantee: the output contains ONLY timing numbers + coarse request identity
// (method, host, path WITHOUT query string). It NEVER contains request/response
// headers, cookies, tokens, query strings, request/response bodies, or
// Server-Timing free-text descriptions.

const FORBIDDEN_KEYS = [
  'headers', 'header', 'cookie', 'cookies', 'setcookie',
  'authorization', 'auth', 'token', 'bearer', 'body', 'postdata',
  'content', 'text', 'query', 'querystring', 'search', 'payload',
];

// Structural keys of ours that are always safe even if they look similar.
const ALLOWED_KEYS = new Set([
  'requests', 'requestbytes', 'responsebytes', 'totalrequests',
]);

/** Reduce any URL to { host, path } with NO query, fragment, or embedded creds. */
export function stripUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return { host: u.host, path: u.pathname || '/' };
  } catch {
    const noFrag = String(rawUrl).split('#')[0];
    const path = (noFrag.split('?')[0] || '/');
    return { host: '', path };
  }
}

function numOrZero(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v) : 0; }
function numOrNull(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v) : null; }

function roundTimings(t) {
  const out = {};
  for (const k of ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive', 'total']) {
    if (typeof t[k] === 'number' && isFinite(t[k])) out[k] = Math.round(t[k]);
  }
  return out;
}

/** Whitelist projection of one normalized request → safe fields only. */
export function sanitizeRequest(r) {
  const host = r.host !== undefined ? r.host : stripUrl(r.url || '').host;
  const path = r.path !== undefined ? r.path : stripUrl(r.url || '').path;
  return {
    method: r.method || 'GET',
    host,
    path,                                  // query already stripped
    status: r.status ?? 0,
    mimeType: r.mimeType || '',
    resourceType: r.resourceType || '',
    requestBytes: numOrZero(r.requestBytes),
    responseBytes: numOrZero(r.responseBytes),
    timings: roundTimings(r.timings || {}),
    ...(r.timingsP95 ? { timingsP95: roundTimings(r.timingsP95) } : {}),
    // Server-Timing: keep only metric name + numeric duration (drop free-text desc).
    serverTiming: Array.isArray(r.serverTiming)
      ? r.serverTiming.map((s) => ({ name: String(s.name).slice(0, 64), dur: numOrNull(s.dur) }))
      : null,
    dominant: r.dominant
      ? { phase: r.dominant.phase, ms: numOrZero(r.dominant.ms), layer: r.dominant.layer }
      : null,
  };
}

function sanitizePageMetrics(m) {
  if (!m) return null;
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === 'number' && isFinite(v)) out[k] = Math.round(v);
    else if (v && typeof v === 'object' && ('p50' in v || 'p95' in v)) {
      out[k] = { p50: numOrNull(v.p50), p95: numOrNull(v.p95) };
    }
  }
  return out;
}

/** Build the full sanitized summary object (and verify the gate). */
export function buildSanitizedSummary({
  source, target, runs, requests, pageMetrics, verdict,
  warnings, statusAudit, cohorts, capturedRequests,
}) {
  const { host, path } = stripUrl(target || '');
  const summary = {
    schema: 'lagging-toolkit/sanitized-summary@1',
    note: 'SAFE TO SHARE: timing numbers only. No headers/cookies/tokens/query/bodies.',
    source: source || 'unknown', // 'har' | 'cdp'
    target: { host, path },
    runs: runs ?? 1,
    ...(warnings && warnings.length ? { warnings } : {}),
    ...(statusAudit ? { statusAudit: sanitizeStatusAudit(statusAudit) } : {}),
    ...(cohorts ? { cohorts } : {}),
    ...(typeof capturedRequests === 'number' ? { capturedRequests } : {}),
    page: sanitizePageMetrics(pageMetrics),
    verdict: verdict || null,
    requests: (requests || []).map(sanitizeRequest),
  };
  assertNoSensitive(summary);
  return summary;
}

// Status audit carries only method/host/path(stripped)/status — all non-sensitive.
function sanitizeStatusAudit(a) {
  const trim = (list) => (list || []).map((r) => ({
    method: r.method || 'GET',
    host: r.host !== undefined ? r.host : stripUrl(r.url || '').host,
    path: r.path !== undefined ? r.path : stripUrl(r.url || '').path,
    status: r.status ?? 0,
  }));
  return {
    byClass: a.byClass || {},
    totalUnique: a.totalUnique ?? 0,
    navStatuses: a.navStatuses || [],
    nonOk: trim(a.nonOk),
    authFailures: trim(a.authFailures),
  };
}

/**
 * Defensive double-check: throw if any forbidden key appears anywhere in the
 * object. Last line of defense before writing the AI-shareable file.
 */
export function assertNoSensitive(obj) {
  const seen = new Set();
  (function walk(node, pathStr) {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      const lk = k.toLowerCase().replace(/[^a-z]/g, '');
      if (!ALLOWED_KEYS.has(lk) && FORBIDDEN_KEYS.includes(lk)) {
        throw new Error(`Sanitizer gate FAILED: forbidden key "${k}" at ${pathStr}`);
      }
      walk(v, `${pathStr}.${k}`);
    }
  })(obj, '$');
  return true;
}
