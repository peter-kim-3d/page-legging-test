// src/report.mjs
// Self-contained HTML report for one analysis (+ optional PDF rendering).
//   buildReportHtml    -> standalone HTML string, pure (NO deps, NO Chrome).
//                         Open in any browser and Print -> "Save as PDF".
//   renderHtmlToPdf    -> PDF via playwright-core (Chromium page.pdf()).
//                         Needs `npm install` + a local Chrome (lazy-imported,
//                         so every non-PDF path runs with zero dependencies).

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// forPdf=true: page.pdf() supplies the margins, so @page margin is 0 (avoid doubling).
// forPdf=false: this HTML is printed from a browser, so @page provides the margins.
const css = (forPdf) => `
* { box-sizing: border-box; }
body { font-family: Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #1a1a1a; margin: 0; }
@media screen { body { max-width: 10in; margin: 0 auto; padding: 0.5in; } }
h1 { font-size: 20pt; margin: 0 0 4pt; }
h2 { font-size: 14pt; margin: 18pt 0 6pt; padding-top: 6pt; border-top: 1px solid #e2e2e2; break-after: avoid; }
code { font-family: "SFMono-Regular", Menlo, monospace; font-size: 9pt; background: #f4f4f4; padding: 1px 4px; border-radius: 3px; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 9pt; }
th, td { border: 1px solid #ddd; padding: 4pt 7pt; text-align: left; vertical-align: top; }
th { background: #f2f4f7; font-weight: 700; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr { break-inside: avoid; }
ul { margin: 6pt 0; padding-left: 18pt; }
li { margin: 3pt 0; }
svg { max-width: 100%; height: auto; }
.cover { padding: 0 0 16pt; border-bottom: 2px solid #1a1a1a; margin-bottom: 16pt; break-after: avoid; }
.cover-title { font-size: 23pt; margin: 0; }
.cover-date { color: #777; font-size: 11pt; margin-top: 6pt; }
.diagnosis { margin: 8pt 0; padding: 8pt 12pt; border-left: 3px solid #4a90d9; background: #f7fafd; }
.warn { margin: 8pt 0; padding: 8pt 12pt; border-left: 3px solid #d93025; background: #fdf3f2; color: #7a1c14; }
.waterfall-wrap { overflow-x: auto; }
.print-hint { background: #fff8e1; border: 1px solid #ffe08a; padding: 8px 12px; border-radius: 6px; margin: 0 0 14pt; font-size: 10pt; color: #6a5400; }
.print-hint button { margin-left: 10px; padding: 3px 12px; cursor: pointer; font-size: 10pt; }
@page { size: Letter landscape; margin: ${forPdf ? '0' : '0.6in'}; }
@media print { .print-hint { display: none; } }
`;

const ms = (v) => `${Math.round(v)}`;

/**
 * Build the complete standalone HTML report. Pure string building — no deps.
 * @param {object} p
 *   title, sourcePath, generatedAt (string), pageMetrics, audit, warnings[],
 *   verdict ({headline, details[]}), ranked[] (entries with .cls), byWait[],
 *   waterfallSvg (string|null), forPdf (bool)
 */
export function buildReportHtml(p) {
  const B = [];

  if (!p.forPdf) {
    B.push('<div class="print-hint">To save as PDF: <strong>Print (⌘/Ctrl+P)</strong> → Destination <strong>"Save as PDF"</strong>.<button onclick="window.print()">Print…</button></div>');
  }
  B.push(`<div class="cover"><h1 class="cover-title">${esc(p.title)}</h1><div class="cover-date">${esc(p.sourcePath)} · ${esc(p.generatedAt)}</div></div>`);

  const m = p.pageMetrics;
  B.push(`<p>Requests: <strong>${m.totalRequests}</strong> · onLoad: <strong>${ms(m.load)}ms</strong> · transfer: <strong>${(m.transferBytes / 1024).toFixed(0)}KB</strong> · status: <code>${esc(JSON.stringify(p.audit.byClass))}</code> · document <strong>${esc(p.audit.navStatuses.join(',') || '?')}</strong></p>`);

  for (const w of p.warnings || []) B.push(`<div class="warn">${esc(w)}</div>`);

  B.push('<h2>Diagnosis</h2>');
  B.push(`<div class="diagnosis"><strong>${esc(p.verdict.headline)}</strong><ul>${(p.verdict.details || []).map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>`);

  if (p.waterfallSvg) {
    B.push('<h2>Waterfall</h2>');
    B.push(`<div class="waterfall-wrap">${p.waterfallSvg}</div>`);
  }

  B.push(`<h2>Top ${p.ranked.length} requests (by total time)</h2>`);
  B.push('<table><tr><th>#</th><th class="num">total</th><th class="num">wait</th><th class="num">recv</th><th class="num">conn</th><th class="num">dns</th><th class="num">blk</th><th>layer</th><th>status</th><th>request</th></tr>');
  p.ranked.forEach((e, i) => {
    const t = e.timings;
    B.push(`<tr><td>${i + 1}</td><td class="num">${ms(t.total)}</td><td class="num">${ms(t.wait)}</td><td class="num">${ms(t.receive)}</td><td class="num">${ms(t.connect + t.ssl)}</td><td class="num">${ms(t.dns)}</td><td class="num">${ms(t.blocked)}</td><td>${esc(e.cls.layer)}</td><td>${e.status}</td><td><code>${esc(`${e.method} ${e.host}${e.path}`.slice(0, 90))}</code></td></tr>`);
  });
  B.push('</table>');

  if (p.byWait.length) {
    B.push('<h2>Top 5 by server processing (wait)</h2><ul>');
    for (const e of p.byWait) B.push(`<li><strong>${ms(e.timings.wait)}ms</strong> — <code>${esc(`${e.method} ${e.host}${e.path}`.slice(0, 90))}</code></li>`);
    B.push('</ul>');
  }

  if (p.audit.nonOk.length) {
    B.push('<h2>Non-2xx responses</h2><ul>');
    for (const r of p.audit.nonOk.slice(0, 15)) {
      const tag = p.audit.authFailures.includes(r) ? ' ← auth failure' : '';
      B.push(`<li><strong>${r.status}</strong> <code>${esc(`${r.method} ${r.host}${r.path}`.slice(0, 90))}</code>${esc(tag)}</li>`);
    }
    B.push('</ul>');
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.title)}</title><style>${css(!!p.forPdf)}</style></head><body>${B.join('\n')}</body></html>`;
}

/** Render HTML to a PDF via Chromium page.pdf(). Needs a launchable Chrome. */
export async function renderHtmlToPdf(html, outPdf, opts = {}) {
  const title = opts.title || 'Report';
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { throw new Error('Dependencies missing for --pdf: run `npm install` (playwright-core). Or use --html and print from your browser.'); }
  const { requireChrome } = await import('./chrome.mjs');
  const browser = await chromium.launch({
    executablePath: requireChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: outPdf,
      format: 'Letter',
      landscape: true,
      printBackground: true,
      margin: { top: '0.6in', right: '0.6in', bottom: '0.6in', left: '0.6in' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:8px;color:#999;width:100%;padding:0 0.6in;text-align:right;">${esc(title)}</div>`,
      footerTemplate: '<div style="font-size:8px;color:#999;width:100%;text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
  } finally {
    await browser.close();
  }
  return outPdf;
}
