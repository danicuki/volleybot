#!/usr/bin/env node
// Demo: scrape an Ashby job posting that's gated behind Cloudflare.
//
//   node examples/ashby.js "https://jobs.ashbyhq.com/openai/<job-id>"
//
// The agent navigates, and if it hits Cloudflare it hands the live browser to
// you (URL in terminal + QR + optional Telegram). You clear the check from any
// device; the agent then reads the job title/details from the same session.

import { HandoffBrowser } from '../src/handoff-browser.js';

const url = process.argv[2] || 'https://jobs.ashbyhq.com/Ashby';

const hb = await HandoffBrowser.launch();
try {
  console.log(`→ navigating to ${url}`);
  await hb.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Give a challenge a moment to render, then hand off if it's there.
  await hb.page.waitForTimeout(2500);
  const { handedOff } = await hb.ensureHuman({
    reason: `Cloudflare is gating this Ashby job. Verify you're human to let the agent read it.`,
  });
  if (handedOff) console.log('✓ human cleared the wall; continuing as the agent');

  // Back in the agent's hands, same session. Prove we got through.
  await hb.page.waitForLoadState('domcontentloaded').catch(() => {});
  await hb.page.waitForTimeout(1000);
  const title = await hb.page.title();
  const heading = await hb.page
    .locator('h1, [class*="title" i]')
    .first()
    .innerText()
    .catch(() => '(no heading found)');

  console.log('\n=== RESULT (agent is through the wall) ===');
  console.log('page title :', title);
  console.log('heading    :', heading);
  console.log('final url  :', hb.page.url());
} finally {
  await hb.close();
}
