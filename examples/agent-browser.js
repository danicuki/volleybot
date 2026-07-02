#!/usr/bin/env node
// Recipe: use volleybot as the human-handoff layer for `agent-browser`
// (https://github.com/vercel-labs/agent-browser) — or any CDP-based stack.
//
// agent-browser is CDP-first and headless by default, so volleybot doesn't
// replace it: it ATTACHES to the same browser over CDP and adds the "get a
// human to pass this wall" step your agent is missing.
//
// ── Setup ────────────────────────────────────────────────────────────────
// Give agent-browser a browser with an inspectable CDP port, and point both
// agent-browser AND volleybot at it so they drive the *same* session:
//
//   # 1. a real Chrome with a debugging port (the shared session)
//   chromium --headless=new --remote-debugging-port=9222 \
//            --user-data-dir=/tmp/shared-profile about:blank &
//
//   # 2. your agent drives it via agent-browser, attached to that port
//   agent-browser --cdp 9222 open "https://jobs.ashbyhq.com/<company>/<job>"
//   agent-browser --cdp 9222 snapshot        # ...agent does its thing...
//
//   # 3. when the agent detects a wall, run this to hand off to a human:
//   node examples/agent-browser.js http://localhost:9222
//
// (agent-browser can also `--auto-connect`; the only requirement for volleybot
// is a reachable CDP endpoint URL.)

import { HandoffBrowser } from '../src/handoff-browser.js';

const cdpEndpoint = process.argv[2] || 'http://localhost:9222';

const hb = await HandoffBrowser.attachOverCDP({ cdpEndpoint });
try {
  console.log(`→ attached to the agent's browser at ${cdpEndpoint}`);
  console.log(`  current page: ${hb.page.url()}`);

  // Hand off if there's a wall on whatever the agent last navigated to.
  // (Use hb.handoff({reason}) to force one for 2FA / logins / approvals.)
  const { handedOff, challenge } = await hb.ensureHuman();
  if (handedOff) {
    console.log(`✓ human cleared: ${challenge.kind} (${challenge.detail})`);
    console.log('  the agent can now continue on the same session via agent-browser');
  } else {
    console.log('· no wall detected on the current page — nothing to hand off');
  }
} finally {
  // Detaches only — leaves the agent's browser (and session) running.
  await hb.close();
}
