#!/usr/bin/env node
// volleybot CLI — the thing an agent runs when it hits a wall it can't pass.
//
//   volleybot handoff --cdp http://localhost:9222 --reason "Cloudflare on ashby"
//   volleybot detect  --cdp http://localhost:9222
//
// `handoff` attaches to the browser your agent is already driving (over CDP),
// hands the LIVE session to a human (link + QR + Telegram + public tunnel),
// BLOCKS until they've solved it, then exits — so an agent can simply run it and
// continue when it returns. Machine-readable markers on stdout:
//
//   HANDOFF_URL=<link>        printed once the take-over link is live
//   HANDOFF_COMPLETE by=<x>   printed on success (x = human | auto)
//   NO_HANDOFF_NEEDED         printed if there was no wall (nothing to do)

import { parseArgs } from 'node:util';
import { HandoffBrowser } from '../src/handoff-browser.js';
import { detectChallenge } from '../src/detectors.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cdp: { type: 'string' },
    launch: { type: 'string' }, // standalone: launch our own browser at this URL
    reason: { type: 'string' },
    force: { type: 'boolean', default: false }, // hand off even with no detected wall
    'page-url': { type: 'string' }, // when several tabs are open, pick this one
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const cmd = positionals[0];
if (values.help || !cmd || cmd === 'help') usage(0);

const cdp = values.cdp || process.env.VOLLEYBOT_CDP;
const port = Number(values.port || process.env.PORT || 7411);

async function open() {
  if (cdp) {
    const hb = await HandoffBrowser.attachOverCDP({
      cdpEndpoint: cdp,
      pageUrl: values['page-url'],
      port,
    });
    // Tell the agent (and the human) exactly which tab we grabbed.
    console.log(`ATTACHED_TAB=${hb.page.url()}`);
    return hb;
  }
  if (values.launch) {
    const hb = await HandoffBrowser.launch({ port });
    await hb.page.goto(values.launch, { waitUntil: 'domcontentloaded' });
    return hb;
  }
  fail(
    'need a browser to act on: pass --cdp <url> (your agent browser\'s CDP endpoint,\n' +
      'e.g. http://localhost:9222) or set $VOLLEYBOT_CDP; or --launch <url> to run standalone.'
  );
}

main().catch((e) => fail(e.message));

async function main() {
  if (cmd === 'detect') {
    const hb = await open();
    const wall = await detectChallenge(hb.page);
    await hb.close();
    if (wall) {
      console.log(`WALL ${wall.kind} ${wall.detail}`);
      process.exit(0); // exit 0 = a wall IS present
    }
    console.log('NO_WALL');
    process.exit(1); // exit 1 = clear (so `volleybot detect && volleybot handoff` chains)
  }

  if (cmd === 'handoff') {
    const hb = await open();
    try {
      const wall = values.force
        ? { kind: 'manual', detail: '--force' }
        : await detectChallenge(hb.page);
      if (!wall) {
        console.log('NO_HANDOFF_NEEDED');
        return;
      }
      const reason =
        values.reason || `Manual verification (${wall.kind}) on ${hostOf(hb.page.url())}`;
      const { by } = await hb.handoff({
        reason,
        autoResume: true, // auto-resume when the page moves forward (e.g. submit)
        watchClear: !values.force, // also when a detected wall clears
        onUrl: (u) => console.log(`HANDOFF_URL=${u}`),
      });
      console.log(`HANDOFF_COMPLETE by=${by}`);
    } finally {
      // Don't let teardown hang the process — the tunnel child / sockets can
      // keep the event loop alive, which would leave the agent's `exec` blocked
      // forever even after the human tapped Resume.
      await Promise.race([hb.close(), sleep(3000)]);
    }
    process.exit(0); // hard-exit so the caller unblocks immediately
  }

  fail(`unknown command "${cmd}"`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function fail(msg) {
  console.error('volleybot: ' + msg);
  process.exit(2);
}

function usage(code) {
  console.log(`volleybot — human handoff for stuck browser agents

USAGE
  volleybot handoff --cdp <url> [--reason "..."] [--force] [--page-url <substr>]
  volleybot detect  --cdp <url>

COMMANDS
  handoff   Hand the live browser to a human and BLOCK until solved, then exit.
            Attaches to the browser's ACTIVE tab; prints ATTACHED_TAB=<url>.
            No-op (prints NO_HANDOFF_NEEDED) if no wall is detected, unless --force.
  detect    Exit 0 if a proof-of-humanity wall is present, 1 if not.

OPTIONS
  --cdp <url>        CDP endpoint of the browser your agent drives (e.g.
                     http://localhost:9222). Or set $VOLLEYBOT_CDP.
  --page-url <substr>  With several tabs open, hand off the tab whose URL
                     contains <substr> instead of the active one.
  --launch <url>     Standalone: launch volleybot's own browser at <url> instead.
  --reason "..."     Message shown to the human (what wall, which site).
  --force            Hand off even if no wall is auto-detected (2FA, logins…).
  --port <n>         Live-view server port (default 7411 / $PORT).

TUNNEL / NOTIFY env: TUNNEL, NGROK_AUTHTOKEN, PUBLIC_BASE_URL,
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  (see .env.example)`);
  process.exit(code);
}
