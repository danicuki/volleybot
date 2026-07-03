#!/usr/bin/env node
// Proves the agent-agnostic path: volleybot attaching to a browser it did NOT
// launch, over the Chrome DevTools Protocol — exactly how you'd hook it to
// agent-browser (which runs a CDP daemon), Browserless, browser-use, etc.
//
// We stand up a plain `chromium --remote-debugging-port=9222` to stand in for
// "the agent's browser", attach volleybot over CDP, stream a frame, relay a
// click, and confirm we DON'T kill that browser on close().

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { HandoffBrowser } from '../src/handoff-browser.js';
import { resolveChromePath } from '../src/resolve-browser.js';

const CHROME = resolveChromePath();
const CDP_PORT = 9333;
const SRV_PORT = 7601;
const CDP = `http://127.0.0.1:${CDP_PORT}`;

const PAGE = `data:text/html,<body style="margin:0">
<button id="b" style="position:absolute;left:40px;top:40px;width:220px;height:90px;font-size:22px"
  onclick="this.textContent='CLICKED';window.__clicks=(window.__clicks||0)+1">click me</button>`;

let chrome, hb, ws;
const profile = mkdtempSync(join(tmpdir(), 'volleybot-cdp-'));

try {
  // 1. Stand in for the agent's own browser: a bare CDP endpoint.
  chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    PAGE,
  ]);
  chrome.on('error', (e) => { throw e; });

  await waitFor(async () => {
    try {
      const r = await fetch(`${CDP}/json/version`);
      return r.ok;
    } catch { return false; }
  }, 15000, 'the external CDP endpoint to come up');
  console.log('✓ external CDP browser is up (stand-in for agent-browser)');

  // 2. Attach volleybot over CDP — no browser launched by us.
  hb = await HandoffBrowser.attachOverCDP({ cdpEndpoint: CDP, port: SRV_PORT });
  await hb.page.bringToFront?.().catch(() => {});
  console.log(`✓ attached over CDP; driving page: ${hb.page.url().slice(0, 40)}…`);

  // 3. Run the handoff live view against the attached page.
  const session = await hb.liveView.createSession(hb.page, { reason: 'cdp attach test' });
  const frames = [];
  ws = new WebSocket(`ws://127.0.0.1:${SRV_PORT}/ws?token=${session.token}`);
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'frame') frames.push(m);
  });
  await once(ws, 'open');
  await waitFor(() => frames.length >= 1, 8000, 'a screencast frame from the attached browser');
  console.log(`✓ streamed a frame from the attached browser (${frames[0].data.length} bytes)`);

  // 4. Relay a click into the agent's page (center of button ~150,85).
  ws.send(JSON.stringify({ type: 'mousemove', x: 150, y: 85 }));
  ws.send(JSON.stringify({ type: 'mousedown', x: 150, y: 85 }));
  ws.send(JSON.stringify({ type: 'mouseup', x: 150, y: 85 }));
  await waitFor(async () => (await hb.page.evaluate(() => window.__clicks || 0)) >= 1, 5000, 'relayed click');
  assert.equal(await hb.page.locator('#b').innerText(), 'CLICKED');
  console.log('✓ relayed click landed on the agent-owned page');

  // 5. close() must NOT kill the agent's browser (ownsBrowser === false).
  assert.equal(hb.ownsBrowser, false, 'attached handle must not own the browser');
  await hb.close();
  ws = null;
  const stillAlive = (await fetch(`${CDP}/json/version`).then((r) => r.ok).catch(() => false));
  assert.ok(stillAlive, 'the agent browser should still be alive after volleybot close()');
  console.log('✓ agent browser still alive after volleybot detached (session preserved)');

  console.log('\nCDP-ATTACH CHECKS PASSED ✅  (this is the agent-browser integration path)');
} catch (e) {
  console.error('✗ ' + (e.stack || e.message));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { await hb?.close(); } catch {}
  try { chrome?.kill('SIGKILL'); } catch {}
}

function once(emitter, ev) {
  return new Promise((res, rej) => { emitter.on(ev, res); emitter.on('error', rej); });
}
async function waitFor(cond, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}
