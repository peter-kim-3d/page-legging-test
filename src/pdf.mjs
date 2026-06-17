// src/pdf.mjs
// Self-contained markdown -> PDF. Uses playwright-core (Chromium page.pdf(),
// already a dependency) + marked (zero-dependency markdown parser). No external
// tools, no gstack, no LLM. Inline SVG (the waterfall) passes through and renders.
// marked + playwright-core are imported lazily so the md/json path needs no deps.

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
* { box-sizing: border-box; }
body { font-family: Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #1a1a1a; margin: 0; }
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
.cover { padding: 24pt 0 16pt; border-bottom: 2px solid #1a1a1a; margin-bottom: 16pt; }
.cover-title { font-size: 23pt; margin: 0; }
.cover-date { color: #777; font-size: 11pt; margin-top: 6pt; }
`;

/**
 * Render markdown text to a PDF file.
 * @param {string} mdText  the markdown (may contain inline <svg>)
 * @param {string} outPdf  output path
 * @param {{title?:string,date?:string,pageSize?:string,cover?:boolean}} opts
 */
export async function renderMarkdownToPdf(mdText, outPdf, opts = {}) {
  const title = opts.title || 'Report';
  const date = opts.date || '';
  const { marked } = await import('marked');
  marked.setOptions({ gfm: true, breaks: false });
  const bodyHtml = marked.parse(mdText);
  const cover = opts.cover === false ? '' : `<div class="cover"><h1 class="cover-title">${escapeHtml(title)}</h1>${date ? `<div class="cover-date">${escapeHtml(date)}</div>` : ''}</div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${cover}${bodyHtml}</body></html>`;

  const { chromium } = await import('playwright-core');
  const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
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
