// src/pdf.mjs
// Self-contained report rendering. Two outputs, both no external tools, no LLM:
//   buildReportHtml / writeReportHtml  -> standalone HTML (marked only, NO Chrome).
//                                         Open it in any browser and Print -> Save as PDF.
//   renderMarkdownToPdf                -> PDF via playwright-core (Chromium page.pdf()).
// On locked-down machines where Chrome cannot be launched, prefer the HTML path:
// it always works and the user prints to PDF from their own (allowed) browser.
// marked + playwright-core are imported lazily so the md/json path needs no deps.

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// forPdf=true: page.pdf() supplies the margins, so @page margin is 0 (avoid doubling).
// forPdf=false: this HTML is printed from a browser, so @page provides the margins.
const css = (forPdf) => `
* { box-sizing: border-box; }
body { font-family: Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #1a1a1a; margin: 0; }
@media screen { body { max-width: 8.5in; margin: 0 auto; padding: 0.5in; } }
h1 { font-size: 20pt; margin: 0 0 4pt; }
h2 { font-size: 14pt; margin: 18pt 0 6pt; padding-top: 6pt; border-top: 1px solid #e2e2e2; break-after: avoid; }
h3 { font-size: 11.5pt; margin: 12pt 0 4pt; break-after: avoid; }
p { margin: 6pt 0; }
em { color: #444; }
code { font-family: "SFMono-Regular", Menlo, monospace; font-size: 9pt; background: #f4f4f4; padding: 1px 4px; border-radius: 3px; }
blockquote { margin: 8pt 0; padding: 6pt 12pt; border-left: 3px solid #4a90d9; background: #f7fafd; color: #333; }
blockquote p { margin: 3pt 0; }
hr { border: none; border-top: 1px solid #e2e2e2; margin: 14pt 0; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 9pt; }
th, td { border: 1px solid #ddd; padding: 4pt 7pt; text-align: left; vertical-align: top; }
th { background: #f2f4f7; font-weight: 700; }
tr { break-inside: avoid; }
ul { margin: 6pt 0; padding-left: 18pt; }
li { margin: 3pt 0; }
svg { max-width: 100%; height: auto; }
.cover { padding: 0 0 16pt; border-bottom: 2px solid #1a1a1a; margin-bottom: 16pt; break-after: avoid; }
.cover-title { font-size: 23pt; margin: 0; }
.cover-date { color: #777; font-size: 11pt; margin-top: 6pt; }
.print-hint { background: #fff8e1; border: 1px solid #ffe08a; padding: 8px 12px; border-radius: 6px; margin: 0 0 14pt; font-size: 10pt; color: #6a5400; }
.print-hint button { margin-left: 10px; padding: 3px 12px; cursor: pointer; font-size: 10pt; }
@page { size: Letter; margin: ${forPdf ? '0' : '0.7in'}; }
@media print { .print-hint { display: none; } }
`;

/** Build a complete standalone HTML report (no Chrome). marked-based. */
export async function buildReportHtml(mdText, opts = {}) {
  const title = opts.title || 'Report';
  const date = opts.date || '';
  const { marked } = await import('marked');
  marked.setOptions({ gfm: true, breaks: false });
  const bodyHtml = marked.parse(mdText);
  const cover = opts.cover === false ? '' : `<div class="cover"><h1 class="cover-title">${escapeHtml(title)}</h1>${date ? `<div class="cover-date">${escapeHtml(date)}</div>` : ''}</div>`;
  const hint = opts.hint === false ? '' : '<div class="print-hint">To save as PDF: <strong>Print (⌘/Ctrl+P)</strong> → Destination <strong>"Save as PDF"</strong>.<button onclick="window.print()">Print…</button></div>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css(!!opts.forPdf)}</style></head><body>${hint}${cover}${bodyHtml}</body></html>`;
}

/** Write the standalone HTML report to a file. No Chrome needed. */
export async function writeReportHtml(mdText, outHtml, opts = {}) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outHtml, await buildReportHtml(mdText, { ...opts, forPdf: false }));
  return outHtml;
}

/** Render markdown to a PDF via Chromium page.pdf(). Needs a launchable Chrome. */
export async function renderMarkdownToPdf(mdText, outPdf, opts = {}) {
  const title = opts.title || 'Report';
  const html = await buildReportHtml(mdText, { ...opts, forPdf: true, hint: false });
  const { chromium } = await import('playwright-core');
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
      format: opts.pageSize || 'Letter',
      printBackground: true,
      margin: { top: '0.7in', right: '0.7in', bottom: '0.7in', left: '0.7in' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:8px;color:#999;width:100%;padding:0 0.7in;text-align:right;">${escapeHtml(title)}</div>`,
      footerTemplate: '<div style="font-size:8px;color:#999;width:100%;text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
  } finally {
    await browser.close();
  }
  return outPdf;
}
