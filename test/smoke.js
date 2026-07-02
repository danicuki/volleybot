#!/usr/bin/env node
// Smoke test: verifies the end-to-end plumbing WITHOUT a human and WITHOUT a
// real captcha. It loads a local page, opens a LiveView session, connects a
// WebSocket client from Node, asserts frames stream in, sends a synthetic click
// through CDP, and asserts the click landed on the real page. Then it fires a
// "resume" and asserts the handoff promise resolves.

import assert from 'node:assert';
import { WebSocket } from 'ws';
import { chromium } from 'playwright-core';
import { LiveView } from '../src/live-view.js';

const executablePath = process.env.CHROME_PATH || '/usr/bin/chromium';
const PORT = 7599;

const PAGE = `data:text/html,<body style="margin:0">
<button id="b" style="position:absolute;left:40px;top:40px;width:200px;height:80px;font-size:20px"
  onclick="this.textContent='CLICKED'">click me</button>
<script>window.__clicks=0;document.getElementById('b').addEventListener('click',()=>window.__clicks++)</script>`;

let context, live, ws;
const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1; };

try {
  context = await chromium.launchPersistentContext('./.chrome-profile-test', {
    headless: true,
    executablePath,
    viewport: { width: 800, height: 600 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(PAGE);

  live = new LiveView({ port: PORT, host: '127.0.0.1' });
  const session = await live.createSession(page, { reason: 'smoke test' });

  const frames = [];
  let gotHello = false;
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${session.token}`);
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'hello') gotHello = true;
    if (m.type === 'frame') frames.push(m);
  });
  await once(ws, 'open');

  // 1. an initial frame should arrive (static page => exactly one until a repaint)
  await waitFor(() => frames.length >= 1, 8000, 'initial screencast frame');
  console.log(`✓ received initial screencast frame (${frames[0].data.length} bytes)`);
  assert.ok(gotHello, 'should have received hello with reason');
  console.log('✓ received hello message');

  // 2. a click relayed through the socket should hit the real button
  //    (button is at 40,40 size 200x80 => center ~140,80 in the 800x600 viewport)
  const before = frames.length;
  ws.send(JSON.stringify({ type: 'mousemove', x: 140, y: 80 }));
  ws.send(JSON.stringify({ type: 'mousedown', x: 140, y: 80 }));
  ws.send(JSON.stringify({ type: 'mouseup', x: 140, y: 80 }));
  await waitFor(
    async () => (await page.evaluate(() => window.__clicks)) >= 1,
    5000,
    'relayed click to register on the page'
  );
  const label = await page.locator('#b').innerText();
  assert.equal(label, 'CLICKED', 'button text should update from the relayed click');
  console.log('✓ relayed mouse click landed on the real page');

  // 3. the repaint from the click should stream a fresh frame (liveness)
  await waitFor(() => frames.length > before, 5000, 'a new frame after the repaint');
  console.log(`✓ stream is live — new frame arrived after interaction (${frames.length} total)`);

  // 4. resume signal should resolve the handoff
  const resumed = session.waitForResume();
  ws.send(JSON.stringify({ type: 'resume' }));
  const by = await withTimeout(resumed, 3000, 'resume signal');
  assert.equal(by, 'human');
  console.log('✓ resume signal resolved the handoff');

  console.log('\nALL SMOKE CHECKS PASSED ✅');
} catch (e) {
  fail(e.stack || e.message);
} finally {
  try { ws?.close(); } catch {}
  await live?.stop().catch(() => {});
  await context?.close().catch(() => {});
}

// ---- tiny helpers ----
function once(emitter, ev) {
  return new Promise((res, rej) => {
    emitter.on(ev, res);
    emitter.on('error', rej);
  });
}
async function waitFor(cond, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms)),
  ]);
}
