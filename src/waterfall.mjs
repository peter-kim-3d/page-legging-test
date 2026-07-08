// src/waterfall.mjs
// Pure SVG network-waterfall builder. No LLM, no deps. Used by analyze.mjs
// (--waterfall standalone .svg, and embedded into the --html / --pdf report).

// Phase order + colors (DevTools-like). 'wait' = server TTFB (emphasized).
export const PHASE_COLORS = [
  ['blocked', '#9aa0a6'],
  ['dns', '#12b5cb'],
  ['connect', '#f9ab00'],
  ['ssl', '#a142f4'],
  ['send', '#c5e1a5'],
  ['wait', '#1a73e8'],
  ['receive', '#34a853'],
];

const xmlEsc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function gridStep(t) {
  if (t <= 2000) return 250;
  if (t <= 5000) return 500;
  if (t <= 12000) return 1000;
  return 2000;
}

/**
 * Build a chronological waterfall SVG from normalized HAR entries.
 * @returns { svg, width, height, rowCount }
 */
export function buildWaterfallSvg(entries, pageMetrics = {}, opts = {}) {
  const topN = opts.topN ?? 200;
  const title = opts.title || 'Network waterfall';
  const subtitle = opts.subtitle || '';

  const rows = [...entries].sort((a, b) => (a.startedMs || 0) - (b.startedMs || 0)).slice(0, topN);
  const truncated = entries.length - rows.length;

  const onLoad = pageMetrics.load || 0;
  const dcl = pageMetrics.domContentLoaded ?? null;
  const maxEnd = Math.max(0, ...rows.map((e) => (e.startedMs || 0) + (e.timings.total || 0)), onLoad, dcl || 0);
  const tMax = Math.max(1, maxEnd * 1.02);

  const M = 14;
  const titleH = 46;
  const axisH = 16;
  const rowH = 15;
  const labelW = 360;
  const plotW = 940;
  const legendH = 34;
  const plotX0 = M + labelW;
  const plotTop = M + titleH + axisH;
  const plotH = rows.length * rowH;
  const W = M * 2 + labelW + plotW;
  const H = plotTop + plotH + legendH + M;
  const x = (ms) => plotX0 + (Math.max(0, ms) / tMax) * plotW;
  const step = gridStep(tMax);

  const S = [];
  S.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="max-width:100%;height:auto" font-family="Helvetica,Arial,sans-serif">`);
  S.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  S.push(`<text x="${M}" y="${M + 16}" font-size="15" font-weight="bold" fill="#202124">${xmlEsc(title)}</text>`);
  if (subtitle) S.push(`<text x="${M}" y="${M + 34}" font-size="11" fill="#5f6368">${xmlEsc(subtitle)}${truncated > 0 ? ` · showing first ${rows.length}` : ''}</text>`);

  for (let t = 0; t <= tMax; t += step) {
    const gx = x(t);
    S.push(`<line x1="${gx.toFixed(1)}" y1="${plotTop}" x2="${gx.toFixed(1)}" y2="${plotTop + plotH}" stroke="#eceff1" stroke-width="1"/>`);
    S.push(`<text x="${gx.toFixed(1)}" y="${plotTop - 4}" font-size="9" fill="#80868b" text-anchor="middle">${t}ms</text>`);
  }

  rows.forEach((e, i) => {
    const y = plotTop + i * rowH;
    if (i % 2 === 0) S.push(`<rect x="${M}" y="${y}" width="${W - 2 * M}" height="${rowH}" fill="#fafafa"/>`);
    const isErr = e.status >= 400 || e.status <= 0;
    const labelColor = isErr ? '#d93025' : '#3c4043';
    const label = `${e.method} ${e.host}${e.path}`;
    S.push(`<text x="${M + 2}" y="${y + 11}" font-size="9.5" fill="${labelColor}">${xmlEsc(label.length > 64 ? `${label.slice(0, 63)}…` : label)}</text>`);
    let cursor = e.startedMs || 0;
    for (const [phase, color] of PHASE_COLORS) {
      const ms = e.timings[phase] || 0;
      if (ms <= 0) { continue; }
      const bx = x(cursor);
      const bw = Math.max(0.6, (ms / tMax) * plotW);
      S.push(`<rect x="${bx.toFixed(1)}" y="${y + 2}" width="${bw.toFixed(1)}" height="${rowH - 4}" fill="${color}"><title>${xmlEsc(`${phase}: ${Math.round(ms)}ms`)}</title></rect>`);
      cursor += ms;
    }
    const endX = x((e.startedMs || 0) + (e.timings.total || 0));
    S.push(`<text x="${(endX + 3).toFixed(1)}" y="${y + 11}" font-size="8.5" fill="#80868b">${Math.round(e.timings.total)}</text>`);
  });

  const milestone = (ms, color, label) => {
    if (ms == null || ms <= 0) return;
    const mx = x(ms);
    S.push(`<line x1="${mx.toFixed(1)}" y1="${plotTop - 12}" x2="${mx.toFixed(1)}" y2="${plotTop + plotH}" stroke="${color}" stroke-width="1.2" stroke-dasharray="4 3"/>`);
    S.push(`<text x="${(mx + 3).toFixed(1)}" y="${plotTop - 14}" font-size="9" fill="${color}" font-weight="bold">${label} ${Math.round(ms)}ms</text>`);
  };
  milestone(dcl, '#1a73e8', 'DCL');
  milestone(onLoad, '#d93025', 'onLoad');

  const legendY = plotTop + plotH + 16;
  let lx = M;
  S.push(`<text x="${lx}" y="${legendY}" font-size="10" fill="#5f6368">Phases:</text>`);
  lx += 56;
  for (const [phase, color] of PHASE_COLORS) {
    S.push(`<rect x="${lx}" y="${legendY - 9}" width="11" height="11" fill="${color}"/>`);
    S.push(`<text x="${lx + 15}" y="${legendY}" font-size="10" fill="#5f6368">${phase}${phase === 'wait' ? ' (TTFB)' : ''}</text>`);
    lx += 30 + (phase.length + (phase === 'wait' ? 7 : 0)) * 6;
  }
  S.push('</svg>');

  return { svg: S.join('\n'), width: W, height: H, rowCount: rows.length };
}
