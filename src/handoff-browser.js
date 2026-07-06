// HandoffBrowser: the agent-facing API.
//
//   const hb = await HandoffBrowser.launch();
//   await hb.page.goto(url);
//   await hb.ensureHuman();            // auto-detects a wall and hands off if needed
//   ... agent continues on the same authenticated session ...
//   await hb.close();
//
// The whole point: `ensureHuman()` blocks the agent until a real human has
// cleared the challenge in the *same* live browser, then returns so the agent
// picks up exactly where it left off — cookies, session, everything intact.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromePath } from './resolve-browser.js';
import { detectChallenge } from './detectors.js';
import { LiveView } from './live-view.js';
import { openPublicUrl } from './tunnel.js';
import { notifyHuman } from './notify.js';

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export class HandoffBrowser {
  /**
   * @param {{
   *   headless?: boolean,
   *   executablePath?: string,
   *   userDataDir?: string,
   *   port?: number,
   *   viewport?: {width:number,height:number},
   * }} [opts]
   */
  static async launch(opts = {}) {
    const {
      headless = process.env.HEADLESS !== 'false',
      executablePath, // resolved cross-platform below; $CHROME_PATH honored
      userDataDir = process.env.USER_DATA_DIR || './.chrome-profile',
      port = Number(process.env.PORT) || 7411,
      viewport = DEFAULT_VIEWPORT,
    } = opts;

    // Find a Chrome/Chromium/Edge/Brave binary (Linux/macOS/Windows), or throw
    // an actionable error pointing at CHROME_PATH / attachOverCDP / fromPage.
    const chromePath = resolveChromePath(executablePath);

    // Extra flags from the environment, e.g. CHROME_ARGS="--ozone-platform=wayland".
    const extraArgs = (process.env.CHROME_ARGS || '').split(' ').filter(Boolean);
    const hasOzone = extraArgs.some((a) => a.startsWith('--ozone-platform'));

    // Headful needs a real display. Rather than let Chromium auto-pick Wayland
    // (and crash when the env isn't perfect), probe what's actually reachable and
    // pass the matching --ozone-platform. If nothing is reachable, fall back to
    // headless with a clear message instead of dying. An explicit ozone flag in
    // CHROME_ARGS always wins.
    let effectiveHeadless = headless;
    const platformArgs = [];
    if (!headless && !hasOzone) {
      const backend = detectDisplayBackend();
      if (backend) {
        platformArgs.push(`--ozone-platform=${backend}`);
      } else {
        console.warn(
          '⚠  Headful requested but no usable display was found ' +
            '($WAYLAND_DISPLAY / $DISPLAY). Falling back to HEADLESS.\n' +
            '   • On a desktop: run from a terminal inside your graphical session.\n' +
            '   • On a server: start a virtual display (Xvfb) and set $DISPLAY,\n' +
            '     or force a backend with CHROME_ARGS=--ozone-platform=x11.'
        );
        effectiveHeadless = true;
      }
    }

    const args = [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...platformArgs,
      ...extraArgs,
    ];

    // Persistent context => cookies & "I already proved I'm human" survive runs,
    // and reduce how often the wall reappears.
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: effectiveHeadless,
      executablePath: chromePath,
      viewport,
      args,
    });
    const page = context.pages()[0] || (await context.newPage());
    return new HandoffBrowser(context, page, { port, ownsBrowser: true });
  }

  /**
   * Attach to a browser someone ELSE is driving, over the Chrome DevTools
   * Protocol. This is what makes volleybot agent-agnostic: point it at whatever
   * CDP endpoint your agent stack already exposes — agent-browser
   * (`agent-browser` runs a CDP daemon), Browserless, browser-use, a raw
   * `chromium --remote-debugging-port=9222`, etc. — and the exact same handoff
   * (screencast + input relay + notify + resume) works, on the agent's own live
   * session. We never close the agent's browser on `close()`.
   *
   * Picks the browser's ACTIVE (foreground) tab by default — not `pages()[0]`,
   * which is the oldest tab and is almost never the one the agent is stuck on
   * when several are open. Override with `pageUrl` (substring match) or `page`.
   *
   * @param {{cdpEndpoint: string, page?: import('playwright-core').Page, pageUrl?: string, port?: number}} opts
   *   cdpEndpoint e.g. "http://localhost:9222"
   */
  static async attachOverCDP({ cdpEndpoint, page, pageUrl, port = Number(process.env.PORT) || 7411 }) {
    if (!cdpEndpoint) throw new Error('attachOverCDP requires a cdpEndpoint, e.g. http://localhost:9222');
    const browser = await chromium.connectOverCDP(cdpEndpoint);
    const context = browser.contexts()[0] || (await browser.newContext());
    const target = page || (await pickActivePage(context, { pageUrl }));
    const hb = new HandoffBrowser(context, target, { port, ownsBrowser: false });
    hb._cdpBrowser = browser;
    return hb;
  }

  /**
   * Wrap a Playwright `Page` you already drive in THIS process (e.g. your own
   * Playwright script, or browser-use, which is Playwright underneath). No CDP
   * endpoint needed; we never close your browser on `close()`.
   *
   * Works even if your app uses a different Playwright build than volleybot's
   * `playwright-core` — we only call methods on the page you pass in.
   *
   * @param {import('playwright-core').Page} page
   * @param {{port?: number}} [opts]
   */
  static fromPage(page, opts = {}) {
    const port = opts.port ?? (Number(process.env.PORT) || 7411);
    return new HandoffBrowser(page.context(), page, { port, ownsBrowser: false });
  }

  constructor(context, page, { port, ownsBrowser = true }) {
    this.context = context;
    this.page = page;
    this.ownsBrowser = ownsBrowser;
    this.liveView = new LiveView({ port });
    this._tunnel = null;
    this._cdpBrowser = null;
  }

  /**
   * If a proof-of-humanity wall is present on the current page, hand off to a
   * human and block until they clear it. No-op if no challenge is detected.
   * @param {{reason?: string, autoResume?: boolean}} [opts]
   * @returns {Promise<{handedOff: boolean, challenge?: object}>}
   */
  async ensureHuman(opts = {}) {
    const challenge = await detectChallenge(this.page);
    if (!challenge) return { handedOff: false };
    const reason =
      opts.reason ||
      `Proof-of-humanity wall (${challenge.kind}) on ${safeHost(this.page.url())}`;
    // A wall was detected, so also auto-resume when it clears.
    await this.handoff({ reason, autoResume: opts.autoResume ?? true, watchClear: true });
    return { handedOff: true, challenge };
  }

  /**
   * Unconditionally hand the live browser to a human and block until resumed.
   * Resumes on whichever happens first:
   *   - the human taps "Resume"
   *   - (autoResume) the page navigates forward — e.g. a successful submit
   *   - (watchClear) a previously-detected wall disappears
   * @param {{reason?: string, autoResume?: boolean, watchClear?: boolean, onUrl?: (u:string)=>void}} [opts]
   */
  async handoff(opts = {}) {
    const reason = opts.reason || 'A human is needed to continue.';
    await this.liveView.start();
    if (!this._tunnel) this._tunnel = await openPublicUrl(this.liveView.port);

    const session = await this.liveView.createSession(this.page, {
      reason,
      mobile: opts.mobile,
      mobileViewport: opts.mobileViewport,
    });
    const url = `${this._tunnel.baseUrl}${this.liveView.pathFor(session.token)}`;

    await notifyHuman({ url, reason });
    opts.onUrl?.(url); // let callers surface the link before we block

    const startUrl = this.page.url();
    const progress =
      (opts.autoResume ?? true)
        ? this._watchProgress({ fromUrl: startUrl, watchClear: opts.watchClear ?? false })
        : null;

    const by = await Promise.race([
      session.waitForResume().then(() => 'human'),
      ...(progress ? [progress.promise] : []),
    ]);
    progress?.cancel();

    console.log(`▶️  Resuming agent (trigger: ${by}).`);
    session._resolveResume(by); // idempotent; stops the stream / closes viewers
    await session.dispose().catch(() => {});
    this.liveView.sessions.delete(session.token);
    return { by, url };
  }

  /**
   * Watch for the page to make forward progress so we can auto-resume without
   * the human tapping anything. Returns { promise, cancel }. `promise` resolves
   * with 'navigated' | 'cleared' | 'timeout'. Cancel it once another waiter wins.
   */
  _watchProgress({ fromUrl, watchClear, pollMs = 900, timeoutMs = 15 * 60_000 }) {
    let cancelled = false;
    const bareUrl = (u) => (u || '').split('#')[0];
    const from = bareUrl(fromUrl);
    const promise = (async () => {
      const deadline = Date.now() + timeoutMs;
      while (!cancelled && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (cancelled) return 'cancel';
        let now;
        try {
          now = this.page.url();
        } catch {
          return 'cancel'; // page/context gone
        }
        // A change of URL (path/query, ignoring #fragment) = a submit/next step.
        if (bareUrl(now) !== from) return 'navigated';
        if (watchClear) {
          const wall = await detectChallenge(this.page).catch(() => null);
          if (!wall) return 'cleared';
        }
      }
      return 'timeout';
    })();
    return { promise, cancel: () => { cancelled = true; } };
  }

  async close() {
    await this.liveView.stop().catch(() => {});
    this._tunnel?.close();
    if (this.ownsBrowser) {
      // We launched it — shut it down.
      await this.context.close().catch(() => {});
    } else {
      // Attached mode: just drop the CDP connection; leave the agent's
      // browser and session running so the agent can carry on.
      await this._cdpBrowser?.close().catch(() => {});
    }
  }
}

function safeHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

/**
 * Choose which tab to hand off. Order: explicit URL substring match → the
 * foreground/visible tab → the most recently opened tab. Never blindly
 * `pages()[0]` (the oldest), which caused "wrong tab" handoffs.
 * @param {import('playwright-core').BrowserContext} context
 * @param {{pageUrl?: string}} [opts]
 */
async function pickActivePage(context, { pageUrl } = {}) {
  const pages = context.pages();
  if (pages.length === 0) return context.newPage();
  if (pages.length === 1) return pages[0];

  if (pageUrl) {
    const match = pages.find((p) => {
      try {
        return p.url().includes(pageUrl);
      } catch {
        return false;
      }
    });
    if (match) return match;
  }

  // The foreground tab reports document.visibilityState === 'visible' and
  // backgrounded ones 'hidden' — but only reliably in a HEADFUL browser. In
  // headless, background tabs can also report 'visible', so only trust this
  // signal when *exactly one* tab is visible; otherwise it's ambiguous.
  const states = await Promise.all(
    pages.map((p) => p.evaluate(() => document.visibilityState).catch(() => 'unknown'))
  );
  const visibleIdx = states.flatMap((s, i) => (s === 'visible' ? [i] : []));
  if (visibleIdx.length === 1) return pages[visibleIdx[0]];

  // Ambiguous (headless reports several visible, or none): the most recently
  // opened tab is the best guess for "what the agent is on" — never pages()[0].
  return pages[pages.length - 1];
}

/**
 * Which display backend can Chromium actually reach right now?
 * Returns 'wayland', 'x11', or null (no usable display).
 */
function detectDisplayBackend() {
  // Prefer native Wayland, but only if the compositor socket really exists —
  // WAYLAND_DISPLAY can be set but stale, which is what causes the cryptic
  // "Failed to connect to Wayland display: No such file or directory" crash.
  const wl = process.env.WAYLAND_DISPLAY;
  if (wl) {
    const runtimeDir =
      process.env.XDG_RUNTIME_DIR ||
      (process.getuid ? `/run/user/${process.getuid()}` : '');
    const sock = path.isAbsolute(wl) ? wl : runtimeDir && path.join(runtimeDir, wl);
    if (sock && fs.existsSync(sock)) return 'wayland';
  }
  // Fall back to X11 / XWayland if a DISPLAY is advertised. (We can't cheaply
  // verify the X server is alive here; a dead $DISPLAY will still surface a
  // clear Chromium error rather than a silent hang.)
  if (process.env.DISPLAY) return 'x11';
  return null;
}
