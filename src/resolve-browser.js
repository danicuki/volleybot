// Find a Chromium-family browser to launch, cross-platform, so `launch()` works
// out of the box on Linux / macOS / Windows without the user hand-setting a path.
// Order: explicit arg -> $CHROME_PATH -> well-known install locations.

import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = {
  linux: [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/brave-browser',
    '/usr/bin/microsoft-edge',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ],
};

/**
 * @param {string} [explicit] executablePath passed to launch(), if any
 * @returns {string} path to a Chromium-family binary
 * @throws if nothing is found (with an actionable message)
 */
export function resolveChromePath(explicit) {
  const wanted = explicit || process.env.CHROME_PATH;
  if (wanted) {
    if (!fs.existsSync(wanted)) {
      throw new Error(`CHROME_PATH / executablePath "${wanted}" does not exist.`);
    }
    return wanted;
  }

  const list = CANDIDATES[process.platform] || CANDIDATES.linux;
  for (const c of list) {
    if (c && fs.existsSync(c)) return c;
  }

  throw new Error(
    'volleybot: no Chrome/Chromium/Edge/Brave binary found.\n' +
      '  → Install Google Chrome or Chromium, or set CHROME_PATH to a Chromium-family binary.\n' +
      '  → Or don\'t launch a browser at all: attach to one you already run with\n' +
      '    HandoffBrowser.attachOverCDP({ cdpEndpoint }) or HandoffBrowser.fromPage(page).\n' +
      `  Looked in: ${list.filter(Boolean).join(', ')}`
  );
}
