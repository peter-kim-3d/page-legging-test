#!/usr/bin/env node
// src/har-waterfall.mjs — TIER A
// Render a chronological network waterfall (every request laid out by start time,
// segmented by phase) + render milestones (DOMContentLoaded / onLoad) from ONE
// HAR, as an SVG diagram. Pure code, no LLM. Optional --png / --ascii.
//
//   node src/har-waterfall.mjs <one.har> [--out file.svg] [--png] [--top N] [--ascii]

import { writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { loadHar } from './har-core.mjs';
import { buildWaterfallSvg, rasterizeSvgToPng } from './waterfall.mjs';

function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; }
const has = (flag) => process.argv.includes(flag);

const harPath = process.argv[2];
if (!harPath || harPath.startsWith('--')) {
  console.error('Usage: node src/har-waterfall.mjs <one.har> [--out file.svg] [--png] [--top N] [--ascii]');
  process.exit(1);
}
const topN = parseInt(arg('--top', '200'), 10);

const { entries, docEntry, pageMetrics } = loadHar(harPath);
const { svg, width, height, rowCount } = buildWaterfallSvg(entries, pageMetrics, {
  topN,
  title: `Network waterfall — ${docEntry.host}${docEntry.path}`,
  subtitle: `${basename(harPath)} · ${entries.length} requests · onLoad ${Math.round(pageMetrics.load)}ms${pageMetrics.domContentLoaded != null ? ` · DCL ${Math.round(pageMetrics.domContentLoaded)}ms` : ''}`,
});

mkdirSync('.perf-runs', { recursive: true });
const outSvg = arg('--out', `.perf-runs/${basename(harPath).replace(/\.har$/i, '')}.waterfall.svg`);
writeFileSync(outSvg, svg);
console.log(`Waterfall (SVG): ${outSvg}  (${rowCount} requests, ${width}x${height})`);

// ---- optional ASCII waterfall (console) ----
if (has('--ascii')) {
  const rows = [...entries].sort((a, b) => (a.startedMs || 0) - (b.startedMs || 0));
  const onLoad = pageMetrics.load || 0;
  const tMax = Math.max(1, Math.max(0, ...rows.map((e) => (e.startedMs || 0) + (e.timings.total || 0)), onLoad) * 1.02);
  const TRACK = 60;
  console.log('\nASCII waterfall (start -> end, block=wait/TTFB):');
  for (const e of rows.slice(0, parseInt(arg('--ascii-top', '25'), 10))) {
    const s0 = Math.round(((e.startedMs || 0) / tMax) * TRACK);
    const w = Math.max(1, Math.round(((e.timings.total || 0) / tMax) * TRACK));
    const waitChars = Math.round(w * ((e.timings.wait || 0) / (e.timings.total || 1)));
    const bar = '·'.repeat(s0) + '▓'.repeat(Math.max(0, w - waitChars)) + '█'.repeat(waitChars);
    const lbl = `${e.method} ${e.host}${e.path}`.slice(0, 46);
    console.log(`${String(Math.round(e.timings.total)).padStart(5)}ms |${bar.padEnd(TRACK).slice(0, TRACK)}| ${lbl}`);
  }
}

// ---- optional PNG (rasterize SVG via installed Chrome; code-only, no LLM) ----
if (has('--png')) {
  const outPng = outSvg.replace(/\.svg$/i, '.png');
  try {
    await rasterizeSvgToPng(svg, outPng, width, height);
    console.log(`Waterfall (PNG): ${outPng}`);
  } catch (e) {
    console.error(`(--png) rasterize failed: ${e.message}. Open the SVG in a browser instead.`);
  }
}
