// LiveView: streams a Playwright page to a browser tab over WebSocket using the
// Chrome DevTools Protocol screencast, and forwards the remote human's mouse /
// keyboard / wheel input back into the real page.
//
// The key property for anti-bot walls: CDP-dispatched input events are marked
// isTrusted=true at the DOM level (they originate from the browser, not JS), and
// the movement path/timing is the *human's real* path — so behavioural checks in
// Cloudflare Turnstile etc. see genuine human interaction, just relayed.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// CDP modifier bitmask
const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };

// Portrait phone-sized viewport for handoff, so a desktop page reflows to fit a
// phone screen (elements big enough to actually tap). Restored on resume.
const MOBILE_VIEWPORT = { width: 390, height: 844, dpr: 2 };

export class LiveView {
  /** @param {{port?: number, host?: string}} [opts] */
  constructor({ port = 7411, host = '0.0.0.0' } = {}) {
    this.port = port;
    this.host = host;
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this._started = false;
  }

  async start() {
    if (this._started) return;
    const app = express();
    app.use(express.static(PUBLIC_DIR));
    // Session page: /s/:token -> serves the viewer, which reads the token from URL.
    app.get('/s/:token', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'viewer.html')));

    this.http = createServer(app);
    this.wss = new WebSocketServer({ server: this.http, path: '/ws' });
    this.wss.on('connection', (ws, req) => this._onSocket(ws, req));

    await new Promise((resolve) => this.http.listen(this.port, this.host, resolve));
    this._started = true;
  }

  async stop() {
    if (!this._started) return;
    for (const s of this.sessions.values()) await s.dispose().catch(() => {});
    this.sessions.clear();
    await new Promise((r) => this.wss.close(() => r()));
    await new Promise((r) => this.http.close(() => r()));
    this._started = false;
  }

  /**
   * Register a page for handoff. Returns a session with a URL + waitForResume().
   * @param {import('playwright-core').Page} page
   * @param {{reason?: string}} [meta]
   */
  async createSession(page, meta = {}) {
    await this.start();
    const token = crypto.randomBytes(16).toString('hex');
    const session = new Session(token, page, meta);
    await session.init();
    this.sessions.set(token, session);
    return session;
  }

  _onSocket(ws, req) {
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('token');
    const session = token && this.sessions.get(token);
    if (!session) {
      ws.close(4404, 'unknown or expired session');
      return;
    }
    session.attachSocket(ws);
  }

  /** Public path for a token (host must be filled in by caller / tunnel). */
  pathFor(token) {
    return `/s/${token}`;
  }
}

class Session {
  constructor(token, page, meta) {
    this.token = token;
    this.page = page;
    this.meta = meta;
    /** @type {Set<import('ws').WebSocket>} */
    this.sockets = new Set();
    this._resumeResolvers = [];
    this._resolved = false;
    this._pressedButtons = 0; // CDP buttons bitmask while dragging
    this._mobileApplied = false;
    this._navHandler = null;
  }

  async init() {
    // A dedicated CDP session for screencast + input.
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', async (evt) => {
      this._broadcast({ type: 'frame', data: evt.data, metadata: evt.metadata });
      // Must ack or the stream stalls after a few frames.
      await this.cdp.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => {});
    });
    if (this.meta.mobile) await this._enableMobile();
  }

  // Emulate a portrait phone on the SAME CDP session that runs the screencast,
  // so the captured frames are actually 390-wide — not the full (wide) window
  // with the page squeezed into a 390px column. Applying it via Playwright's
  // separate connection only reflows the layout; the screencast, on this session,
  // wouldn't see the override (that's the "tiny strip + blank" bug on headful).
  async _enableMobile() {
    await this._applyMobileMetrics();
    if (this._mobileApplied && !this._navHandler) {
      // A navigation/reload (e.g. submitting a captcha step) drops the override
      // and flips the view back to landscape mid-session — re-apply it each time.
      this._navHandler = (frame) => {
        if (frame === this.page.mainFrame() && this._mobileApplied) {
          this._applyMobileMetrics();
          this.cdp.send('Page.bringToFront').catch(() => {});
        }
      };
      this.page.on('framenavigated', this._navHandler);
    }
  }

  async _applyMobileMetrics() {
    const vp = this.meta.mobileViewport || MOBILE_VIEWPORT;
    try {
      await this.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: vp.dpr || 2,
        mobile: true,
        screenWidth: vp.width,
        screenHeight: vp.height,
      });
      this._mobileApplied = true;
    } catch {
      // emulation unsupported on this target; keep the desktop viewport
    }
  }

  async _disableMobile() {
    if (this._navHandler) {
      this.page.off('framenavigated', this._navHandler);
      this._navHandler = null;
    }
    if (!this._mobileApplied) return;
    this._mobileApplied = false;
    await this.cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  }

  async _startScreencast() {
    // In headless (and for background tabs) the page is treated as "hidden",
    // so the screencast emits no frames until the target is brought to front.
    await this.cdp.send('Page.bringToFront').catch(() => {});
    // Cap frame size to keep bandwidth sane; quality tuned for captchas.
    await this.cdp
      .send('Page.startScreencast', {
        format: 'jpeg',
        quality: 65,
        maxWidth: 1600,
        maxHeight: 1600,
        everyNthFrame: 1,
      })
      .catch(() => {});
  }

  async _stopScreencast() {
    await this.cdp.send('Page.stopScreencast').catch(() => {});
  }

  attachSocket(ws) {
    this.sockets.add(ws);
    // Always greet the client (reason + which tab it's driving). Coordinate
    // mapping is derived from the screencast frames themselves, not this hello —
    // so it's correct even when viewportSize() is null (attached CDP pages).
    this._sendHello(ws);
    // Start (or keep) streaming as long as at least one viewer is connected.
    if (this.sockets.size === 1) this._startScreencast();

    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('close', () => {
      this.sockets.delete(ws);
      if (this.sockets.size === 0) this._stopScreencast();
    });
    ws.on('error', () => {});
  }

  async _sendHello(ws) {
    let title = '';
    try {
      title = await this.page.title();
    } catch {
      // page may be mid-navigation
    }
    this._send(ws, {
      type: 'hello',
      reason: this.meta.reason || 'Human verification required',
      viewport: this.page.viewportSize() || null,
      page: { url: this.page.url(), title },
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Dispatch strictly in the order received. Each handler awaits CDP, so
    // without this a mouseup could overtake a mousedown's press and cancel the
    // click — exactly the kind of thing that makes taps feel dead on mobile.
    this._inputChain = (this._inputChain || Promise.resolve())
      .then(() => this._dispatch(msg))
      .catch(() => {});
  }

  async _dispatch(msg) {
    try {
      switch (msg.type) {
        case 'mousemove':
          await this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: msg.x,
            y: msg.y,
            buttons: this._pressedButtons,
          });
          break;
        case 'mousedown':
          // A tap on mobile fires down with no preceding move. Move the cursor
          // to the target first so hover state is set and the press is trusted
          // where the user actually tapped (matters for Turnstile/reCAPTCHA).
          await this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: msg.x,
            y: msg.y,
            buttons: 0,
          });
          this._pressedButtons |= 1;
          await this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: msg.x,
            y: msg.y,
            button: 'left',
            buttons: this._pressedButtons,
            clickCount: 1,
          });
          break;
        case 'mouseup':
          this._pressedButtons &= ~1;
          await this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: msg.x,
            y: msg.y,
            button: 'left',
            buttons: this._pressedButtons,
            clickCount: 1,
          });
          break;
        case 'wheel':
          await this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: msg.x,
            y: msg.y,
            deltaX: msg.deltaX || 0,
            deltaY: msg.deltaY || 0,
          });
          break;
        case 'key': {
          const modifiers =
            (msg.alt ? MOD.Alt : 0) |
            (msg.ctrl ? MOD.Ctrl : 0) |
            (msg.meta ? MOD.Meta : 0) |
            (msg.shift ? MOD.Shift : 0);
          const isPrintable = msg.text && msg.text.length === 1;
          await this.cdp.send('Input.dispatchKeyEvent', {
            type: msg.action === 'up' ? 'keyUp' : isPrintable ? 'keyDown' : 'rawKeyDown',
            key: msg.key,
            code: msg.code,
            windowsVirtualKeyCode: msg.keyCode || 0,
            text: msg.action === 'up' ? undefined : isPrintable ? msg.text : undefined,
            unmodifiedText: msg.action === 'up' ? undefined : isPrintable ? msg.text : undefined,
            modifiers,
          });
          break;
        }
        case 'resume':
          this._resolveResume('human');
          break;
        default:
          break;
      }
    } catch {
      // page may have navigated mid-event; ignore transient CDP errors
    }
  }

  /** Resolves when the human presses "Resume", or when resolve() is called. */
  waitForResume() {
    if (this._resolved) return Promise.resolve('already');
    return new Promise((resolve) => this._resumeResolvers.push(resolve));
  }

  _resolveResume(by) {
    if (this._resolved) return;
    this._resolved = true;
    this._broadcast({ type: 'resumed' });
    for (const r of this._resumeResolvers) r(by);
    this._resumeResolvers = [];
  }

  _send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  _broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of this.sockets) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  async dispose() {
    await this._stopScreencast();
    await this._disableMobile(); // restore the agent's desktop viewport before it resumes
    for (const ws of this.sockets) ws.close();
    this.sockets.clear();
    await this.cdp.detach().catch(() => {});
  }
}
