#!/usr/bin/env node
// Regression tests for the issues hit during a real iPhone handoff:
//   1. wrong tab — must attach to the ACTIVE tab, not pages()[0] (the oldest),
//      and honor a --page-url override.
//   2. resume didn't unblock the agent — the `volleybot handoff` process must
//      actually EXIT (code 0) once the human taps Resume, even with a tunnel.

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { chromium } from 'playwright-core';
import { HandoffBrowser } from '../src/handoff-browser.js';
import { resolveChromePath } from '../src/resolve-browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'bin', 'volleybot.js');
const CHROME = resolveChromePath();
const CDP_PORT = 9351;
const SRV_PORT = 7621;
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const DECOY = 'data:text/html,<title>DECOY_TAB</title><body><h1>oldest tab</h1>';
const ACTIVE = 'data:text/html,<title>ACTIVE_TAB</title><body><h1>the tab the agent is on</h1>';

let chrome, hb, ws;
const profile = mkdtempSync(join(tmpdir(), 'volleybot-fixes-'));

try {
  // headless=new rejects multiple URL args, so start with one tab (the decoy)…
  chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    DECOY,
  ]);
  chrome.on('error', (e) => { throw e; });
  await waitFor(async () => {
    try { return (await fetch(`${CDP}/json/version`)).ok; } catch { return false; }
  }, 15000, 'CDP endpoint');

  // …then open a SECOND tab over CDP and make it the foreground one, so pages()
  // is [decoy(oldest), active(foreground)] — the exact "wrong tab" setup.
  {
    const pre = await chromium.connectOverCDP(CDP);
    const active = await pre.contexts()[0].newPage();
    await active.goto(ACTIVE);
    await active.bringToFront();
    await pre.close();
  }

  // 1a. attach picks the ACTIVE tab, not pages()[0] (the decoy)
  hb = await HandoffBrowser.attachOverCDP({ cdpEndpoint: CDP });
  assert.ok(hb.page.url().includes('ACTIVE_TAB'), `picked wrong tab: ${hb.page.url().slice(0, 48)}`);
  console.log('✓ attach picks the ACTIVE tab, not the oldest (pages()[0])');
  await hb.close();

  // 1b. --page-url override wins
  hb = await HandoffBrowser.attachOverCDP({ cdpEndpoint: CDP, pageUrl: 'DECOY' });
  assert.ok(hb.page.url().includes('DECOY_TAB'), 'pageUrl override should select the decoy tab');
  console.log('✓ pageUrl override selects a specific tab');
  await hb.close();
  hb = null;

  // 2. `volleybot handoff --force` must EXIT after a Resume tap.
  const child = spawn('node', [CLI, 'handoff', '--cdp', CDP, '--force', '--reason', 'exit test'], {
    env: { ...process.env, TUNNEL: 'lan', PORT: String(SRV_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += d.toString()));

  const token = await waitForMatch(() => out.match(/\/s\/([a-f0-9]+)/)?.[1], 12000, 'HANDOFF_URL');
  console.log('✓ CLI produced a take-over link');

  ws = new WebSocket(`ws://127.0.0.1:${SRV_PORT}/ws?token=${token}`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'resume' })); // simulate the human tapping Resume

  const code = await withTimeout(once(child, 'exit'), 8000, 'CLI to exit after resume');
  assert.equal(code?.[0] ?? code, 0, 'CLI should exit 0 after resume');
  assert.match(out, /HANDOFF_COMPLETE by=human/, 'should print HANDOFF_COMPLETE');
  console.log('✓ CLI exits 0 on Resume (this is what unblocks the agent)');

  // 3. auto-resume when the page moves forward (no Resume tap, no message)
  process.env.TUNNEL = 'lan';
  hb = await HandoffBrowser.attachOverCDP({ cdpEndpoint: CDP });
  const handoffP = hb.handoff({ reason: 'nav auto-resume test', autoResume: true, watchClear: false });
  await sleep(1500); // let the watcher arm
  await hb.page.goto('data:text/html,<title>SUBMITTED</title><h1>thank you</h1>');
  const res = await withTimeout(handoffP, 10000, 'auto-resume on navigation');
  assert.equal(res.by, 'navigated', `expected by=navigated, got ${res.by}`);
  console.log('✓ auto-resumes on navigation (solve+submit continues on its own)');
  await hb.close();
  hb = null;

  console.log('\nHANDOFF-FIXES CHECKS PASSED ✅');
} catch (e) {
  console.error('✗ ' + (e.stack || e.message));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { await hb?.close(); } catch {}
  try { chrome?.kill('SIGKILL'); } catch {}
}

// ---- helpers ----
function once(emitter, ev) {
  return new Promise((res, rej) => {
    emitter.on(ev, (...a) => res(a.length > 1 ? a : a[0]));
    emitter.on('error', rej);
  });
}
async function waitFor(cond, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(150); }
  throw new Error(`timed out waiting for ${what}`);
}
async function waitForMatch(get, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = get(); if (v) return v; await sleep(150); }
  throw new Error(`timed out waiting for ${what}`);
}
function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms))]);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
