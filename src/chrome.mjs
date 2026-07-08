// src/chrome.mjs
// Locate a local Chrome/Chromium for the PDF / PNG features. Cross-platform.
// Override anything with the CHROME_BIN environment variable.

import { existsSync } from 'node:fs';

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/opt/google/chrome/chrome',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

/** First Chrome-like browser found (or CHROME_BIN), else null. */
export function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN; // trust the override
  for (const p of CANDIDATES[process.platform] || []) {
    try { if (existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/** Like findChrome but throws an actionable error when nothing is found. */
export function requireChrome() {
  const c = findChrome();
  if (!c) {
    throw new Error(
      'No Chrome/Chromium found for PDF/PNG rendering. '
      + 'Install Google Chrome, or set CHROME_BIN to its full path '
      + '(e.g. CHROME_BIN="/path/to/chrome"). playwright-core drives your existing '
      + 'Chrome; it does not download one.',
    );
  }
  return c;
}
