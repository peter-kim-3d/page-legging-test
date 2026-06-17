// src/diagnose.mjs
// The reusable "decision tree": given per-request timing phases, localize the
// bottleneck LAYER. Identical logic for any site / any capture method (HAR or
// CDP). This module is the portable core that makes the toolkit universal.

export const PHASES = ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive'];

const LAYER = {
  wait: {
    layer: 'backend', label: 'backend server processing (TTFB)',
    hint: 'Check the Server-Timing header, then hand the endpoint to the backend team. Suspect token introspection / downstream service latency.',
  },
  blocked: {
    layer: 'connection', label: 'connection queueing / parallelism limit',
    hint: 'HTTP/1.1 caps ~6 connections per host. Consider request parallelization, domain sharding, or HTTP/2.',
  },
  dns: {
    layer: 'network', label: 'DNS resolution',
    hint: 'DNS/proxy resolution delay. Check DNS cache and proxy settings.',
  },
  connect: {
    layer: 'network', label: 'TCP connect',
    hint: 'Connection setup delay through network/proxy. Check keep-alive and proxy.',
  },
  ssl: {
    layer: 'network', label: 'TLS handshake',
    hint: 'TLS handshake / certificate-chain / proxy MITM delay. Check TLS session reuse.',
  },
  send: {
    layer: 'client', label: 'request upload',
    hint: 'Large upload payload (rare). Check request body size.',
  },
  receive: {
    layer: 'payload', label: 'response download',
    hint: 'Large/slow response payload. Check gzip/brotli, response size, and CDN.',
  },
};

export function dominantPhase(timings = {}) {
  let phase = null;
  let ms = -1;
  for (const p of PHASES) {
    const v = timings[p];
    if (typeof v === 'number' && v > ms) { ms = v; phase = p; }
  }
  return { phase, ms: Math.max(0, ms) };
}

export function classifyRequest(entry, opts = {}) {
  const negligibleMs = opts.negligibleMs ?? 50;
  const { phase, ms } = dominantPhase(entry.timings);
  const total = entry.timings?.total ?? 0;
  // Warm cache reads (~1ms) have wait >= receive too, so they'd be mislabeled
  // 'backend'. Anything below the negligible floor is not a bottleneck.
  if (total < negligibleMs) {
    return { phase, ms: Math.round(ms), layer: 'cached', label: 'cached/negligible', hint: '' };
  }
  const info = LAYER[phase] || { layer: 'unknown', label: '?', hint: '' };
  return { phase, ms: Math.round(ms), layer: info.layer, label: info.label, hint: info.hint };
}

/**
 * Page-level verdict. Looks at the slowest request AND whether the page is
 * dominated by client-side rendering (long tasks / gap before LCP).
 * Returns { headline, layer, details[], worst, enriched }.
 */
export function diagnosePage(requests, pageMetrics = {}, opts = {}) {
  const backendThresholdMs = opts.backendThresholdMs ?? 1000;
  const negligibleMs = opts.negligibleMs ?? 50;
  const enriched = requests.map((r) => ({ ...r, dominant: classifyRequest(r, { negligibleMs }) }));
  const byTotal = [...enriched].sort((a, b) => (b.timings.total || 0) - (a.timings.total || 0));
  const worst = byTotal[0] || null;

  const details = [];
  let headline = 'No single dominant bottleneck found. Review the top requests together.';
  let layer = 'unknown';

  if (worst) {
    const d = worst.dominant;
    layer = d.layer;
    headline = `Top bottleneck: ${worst.method} ${worst.host}${worst.path} — ${d.ms}ms of ${Math.round(worst.timings.total)}ms in [${d.label}]. Layer = ${d.layer.toUpperCase()}.`;
    if (d.hint) details.push(d.hint);
    if (d.phase === 'wait' && d.ms >= backendThresholdMs) {
      details.push(`Server processing (wait=${d.ms}ms) exceeds threshold (${backendThresholdMs}ms) → confirmed backend. Not a network/frontend cause.`);
    }
  }

  // Client-side rendering signal (best-effort; needs LCP/longtask metrics).
  const lcp = pageMetrics.lcp || 0;
  const longTasks = pageMetrics.longTasksTotal || 0;
  const lastNetworkEnd = enriched.reduce(
    (mx, r) => Math.max(mx, (r.startedMs || 0) + (r.timings.total || 0)),
    0,
  );
  if (longTasks >= 500) {
    details.push(`Main-thread Long Tasks total ${Math.round(longTasks)}ms → significant client-side rendering (JS execution) cost.`);
  }
  if (lcp && lastNetworkEnd && lcp - lastNetworkEnd > 1000) {
    details.push(`Last network finished at ${Math.round(lastNetworkEnd)}ms but LCP at ${Math.round(lcp)}ms (+${Math.round(lcp - lastNetworkEnd)}ms) → render/layout-phase delay likely.`);
  }

  return {
    headline,
    layer,
    details,
    worst: worst
      ? { method: worst.method, host: worst.host, path: worst.path, totalMs: Math.round(worst.timings.total || 0), dominant: worst.dominant }
      : null,
    enriched,
  };
}
