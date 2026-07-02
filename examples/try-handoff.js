#!/usr/bin/env node
// Feel the handoff UX end-to-end — no captcha required.
//
//   node examples/try-handoff.js                 # opens DuckDuckGo
//   node examples/try-handoff.js "<any-url>"     # opens whatever you pass
//
// It forces a handoff and BLOCKS (autoResume off) so you can actually open the
// take-over link, drive the live browser (click the search box, type, press
// Enter, scroll — proving mouse + keyboard relay), then tap "Resume". The agent
// then prints where the page ended up. This is exactly what happens on a real
// Cloudflare wall, minus the wall.

import { HandoffBrowser } from '../src/handoff-browser.js';

const url = process.argv[2] || 'https://duckduckgo.com';
const host = new URL(url).host;

const hb = await HandoffBrowser.launch(); // headless is fine — the live view still works
try {
  console.log(`→ opening ${url}`);
  await hb.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  await hb.handoff({
    reason: `Live handoff demo — you're driving ${host}. Search for something, then tap Resume.`,
    autoResume: false, // wait for YOU, not for a challenge to clear
  });

  console.log('\n=== back in the agent ===');
  console.log('current title :', await hb.page.title());
  console.log('current url   :', hb.page.url());
} finally {
  await hb.close();
}
