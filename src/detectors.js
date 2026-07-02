// Heuristics for detecting "proof of humanity" walls on a Playwright page.
//
// These are intentionally conservative and cover the common cases an agent
// hits in the wild: Cloudflare interstitial ("Just a moment...") + Turnstile,
// hCaptcha, reCAPTCHA, and DataDome. Add site-specific selectors as needed.

const CHALLENGE_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com"]', // Cloudflare Turnstile
  '.cf-turnstile',
  '#challenge-form',
  '#challenge-running',
  '[id^="cf-chl"]',
  'iframe[src*="hcaptcha.com"]', // hCaptcha
  'iframe[src*="recaptcha"]', // reCAPTCHA
  'iframe[title*="captcha" i]',
  '[id*="datadome" i]', // DataDome
];

// Interstitial page titles / body text that mean "we are being challenged".
const CHALLENGE_TEXT = [
  'just a moment',
  'verify you are human',
  'verifying you are human',
  'checking your browser',
  'attention required',
  'please verify you are a human',
];

/**
 * Returns a description of the challenge if one is present, else null.
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{kind: string, detail: string} | null>}
 */
export async function detectChallenge(page) {
  // 1. Selector-based detection (most reliable).
  for (const sel of CHALLENGE_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el && (await el.isVisible().catch(() => true))) {
        return { kind: classify(sel), detail: `matched selector: ${sel}` };
      }
    } catch {
      // page may be navigating; ignore and continue
    }
  }

  // 2. Title / heading text based detection (Cloudflare interstitial).
  try {
    const title = ((await page.title().catch(() => '')) || '').toLowerCase();
    if (CHALLENGE_TEXT.some((t) => title.includes(t))) {
      return { kind: 'interstitial', detail: `page title: "${title}"` };
    }
    const bodyText = (
      await page
        .evaluate(() => document.body?.innerText?.slice(0, 400) || '')
        .catch(() => '')
    ).toLowerCase();
    if (CHALLENGE_TEXT.some((t) => bodyText.includes(t))) {
      return { kind: 'interstitial', detail: 'challenge text in page body' };
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Waits until the challenge clears (or timeout). Useful for auto-resume.
 * @param {import('playwright-core').Page} page
 * @param {{timeoutMs?: number, pollMs?: number}} [opts]
 * @returns {Promise<boolean>} true if cleared, false if timed out
 */
export async function waitForChallengeCleared(page, opts = {}) {
  const { timeoutMs = 5 * 60_000, pollMs = 1000 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const challenge = await detectChallenge(page);
    if (!challenge) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

function classify(sel) {
  if (sel.includes('cloudflare') || sel.includes('cf-')) return 'cloudflare-turnstile';
  if (sel.includes('hcaptcha')) return 'hcaptcha';
  if (sel.includes('recaptcha')) return 'recaptcha';
  if (sel.includes('datadome')) return 'datadome';
  return 'captcha';
}
