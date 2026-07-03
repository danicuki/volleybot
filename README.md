# volleybot

**Human handoff for AI browser agents.** When your agent hits a captcha or
"prove you're human" wall, volleybot hands its *live* browser to you over a URL.
You solve it from any device — phone, laptop, anywhere — and the agent resumes on
the exact same session. Cookies, login, scroll position: all intact.

It's the piece that unsticks an autonomous agent **without** physical access to
its machine, a remote desktop, a VNC client, or a third-party captcha-solving
farm. Self-hosted, browser-agnostic, ~1k lines, no build step.

```
 ┌──────────┐   1. hits a wall    ┌───────────┐   2. link / QR / Telegram   ┌────────┐
 │  agent   │ ──────────────────► │ volleybot │ ──────────────────────────► │  you   │
 │ (browser)│ ◄────────────────── │ live view │ ◄────────────────────────── │ (phone)│
 └──────────┘   4. resumes here   └───────────┘   3. you tap / solve it      └────────┘
```

> Human-in-the-loop by design: **a real person passes the check.** volleybot is
> not an automated captcha bypass and ships with no solver. If a site would block
> *you*, it still blocks you here.

---

## Quickstart (about a minute)

**Requirements:** Node ≥ 18, and a Chrome/Chromium/Edge/Brave install (only for
the standalone demo — if you bring your own browser, you don't even need that).
`npm install` does **not** download a browser.

```bash
git clone https://github.com/danicuki/volleybot && cd volleybot
npm install
npm run try                 # opens a page and hands it to you
```

You'll see a **take-over link + QR** in the terminal. Open it (or scan it) on
your phone, drive the live browser — click, type, scroll — then tap
**"Solved — resume"**. That's the whole loop.

By default the link is a LAN address. To reach it from cellular, add a tunnel:

```bash
TUNNEL=cloudflared npm run try     # free https://<x>.trycloudflare.com link, no account
```

Run the test suite (no human, no captcha needed) to see the internals work:

```bash
npm test
```

---

## Works with any browser (and any agent)

volleybot is a **handoff layer, not a browser framework.** It attaches to
whatever you already drive. Pick the entry point that matches your stack:

| You already drive… | Attach with |
|---|---|
| nothing — let volleybot run Chrome | `HandoffBrowser.launch()` |
| a Playwright `Page` in your **Node** process (JS/TS) | `HandoffBrowser.fromPage(page)` |
| **Puppeteer** | `HandoffBrowser.attachOverCDP({ cdpEndpoint: browser.wsEndpoint() })` |
| **Browserless / Steel / Browserbase** | `attachOverCDP({ cdpEndpoint: '<their CDP ws/http url>' })` |
| **agent-browser** (vercel-labs) | `attachOverCDP({ cdpEndpoint: '<agent-browser get cdp-url>' })` |
| a raw `chrome --remote-debugging-port=9222` | `attachOverCDP({ cdpEndpoint: 'http://localhost:9222' })` |
| a **non-Node** agent — Python (**browser-use**), Go, Rust… | run it against a CDP port, then use the `volleybot` CLI (below) |

The API surface is three calls, on any of the three entry points:

```js
import { HandoffBrowser } from 'volleybot';

const hb = await HandoffBrowser.launch();     // or .fromPage(page) / .attachOverCDP({cdpEndpoint})
await hb.page.goto(url);

await hb.ensureHuman();   // no-op unless a wall is present; else blocks until a human clears it

// ...your agent keeps driving hb.page on the same session...
await hb.close();         // launch(): closes it. attach/fromPage: detaches, your browser lives on.
```

- `ensureHuman({ reason })` only hands off if a wall is actually detected.
- `hb.handoff({ reason })` forces one for anything — 2FA, a login, a manual
  approval step — not just captchas.
- `hb.page` is a normal Playwright `Page`.

### Playwright (in-process)

```js
import { chromium } from 'playwright';
import { HandoffBrowser } from 'volleybot';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(targetUrl);

const hb = HandoffBrowser.fromPage(page);
await hb.ensureHuman();    // hands off if blocked, on this exact page
await hb.close();          // detaches — your browser keeps running
```

(Works even if your app pins a different Playwright build than volleybot's
`playwright-core`; volleybot only calls methods on the page you pass in.)

### Puppeteer

```js
import puppeteer from 'puppeteer';
import { HandoffBrowser } from 'volleybot';

const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto(targetUrl);

const hb = await HandoffBrowser.attachOverCDP({ cdpEndpoint: browser.wsEndpoint() });
await hb.ensureHuman();
await hb.close();
```

### Any language — the CLI

Agents that aren't Node just shell out and wait. `handoff` **blocks until the
human has solved the wall, then exits**, with machine-readable markers on stdout:

```bash
volleybot handoff --cdp http://localhost:9222 --reason "Cloudflare on example.com"
volleybot detect  --cdp http://localhost:9222     # exit 0 = wall present, 1 = clear
```

| stdout marker | meaning |
|---|---|
| `ATTACHED_TAB=<url>` | which tab is being handed off (the **active** one) |
| `HANDOFF_URL=<link>` | take-over link is live (also sent via Telegram) — wait |
| `HANDOFF_COMPLETE by=human` / `by=auto` | solved — continue on the same session |
| `NO_HANDOFF_NEEDED` | no wall was present; just continue |

With several tabs open, volleybot hands off the **active (foreground) tab** — not
the oldest — so agents don't need to close tabs. Target a specific one with
`--page-url <substring>`. Set `$VOLLEYBOT_CDP` to skip `--cdp`; add `--force` for
a step with no auto-detectable wall; `--launch <url>` to run standalone. Put it on
`PATH` with `npm link` (in this repo) or a future `npm i -g volleybot`.

---

## How it works

```
your agent ─► HandoffBrowser ─► a Playwright Page (launched, attached, or yours)
                   │
                   ├─ detectors   : is there a wall on this page?
                   ├─ LiveView    : CDP screencast  ⇄  WebSocket  ⇄  viewer (your phone)
                   │     • Page.startScreencast  → JPEG frames → your screen
                   │     • Input.dispatch*       ← your taps/keys ← your screen
                   ├─ tunnel       : cloudflared / ngrok / localtunnel / LAN
                   └─ notify       : Telegram push + terminal QR
```

**The load-bearing design choice: input is relayed via the Chrome DevTools
Protocol, driven by your real hand.** When you move or tap on the streamed image,
those coordinates are replayed with `Input.dispatchMouseEvent`. Two things fall
out of that, both of which matter for anti-bot walls:

- CDP-dispatched events are **`isTrusted: true`** at the DOM level — they come
  from the browser engine, not injected JavaScript, so they're indistinguishable
  from a physical click.
- The **movement path and timing are genuinely yours**. Behavioural analysis in
  Turnstile / hCaptcha sees real human motion, just relayed over the wire.

That's why a relayed live view beats "screenshot to Telegram, type the answer
back": it handles click-the-images, drag-the-slider, and press-and-hold
challenges — not just text — and the *page itself* is interacted with, so the
token it issues is valid.

---

## Why this exists (vs. what's out there)

The "let a human step into the agent's browser" pattern ships in a few products:

| Product | What it gives you | Why volleybot |
|---|---|---|
| **Cloudflare Browser Run** — HITL handoff | Live view + take-over of a cloud Chrome | Tied to Cloudflare's browser service |
| **Browserbase** — Live View / takeover | Live view + auto captcha solving | Hosted; your session runs on their infra |
| **BrowserAct** — `remote-assist` | Live URL, take over from any device, resume | Closed platform |
| **Steel.dev** | Open-source browser API + session viewer | Viewer is for debugging, not a handoff protocol |
| **agent-browser** (vercel-labs) | Open CDP CLI; WS stream + captcha *solver* plugins | No human-handoff protocol — volleybot attaches to it |
| **2captcha / CapSolver** | *Automated* solving via a worker farm | A different (grayer) thing — not *you* solving it |

**What none of them are:** a small, self-hosted, browser-agnostic piece you fully
own — running against *your* browser, on *your* machine, pinging *your* phone,
never routing your session or credentials through someone else's cloud.

---

## Recipes

<details>
<summary><b>OpenClaw agent (drop-in skill)</b></summary>

OpenClaw's browser skill already stops on captcha / 2FA / login as **manual
blockers**. This fills that gap. Ships as `skills/human-handoff/`.

```bash
npm link                                        # puts `volleybot` on PATH
cp -r skills/human-handoff ~/.openclaw/skills/human-handoff
# optional: export TUNNEL=cloudflared  TELEGRAM_BOT_TOKEN=…  TELEGRAM_CHAT_ID=…
```

Start a new OpenClaw session. When the agent hits a wall it runs `volleybot
handoff` (blocking); you get a phone link; you solve it; the agent resumes. If you
use **agent-browser**, there's no port setup — the skill discovers the live
browser via `agent-browser get cdp-url`. OpenClaw auto-invokes from the skill's
`description`, or trigger it with `/skill human-handoff`.
</details>

<details>
<summary><b>Standalone: scrape a Cloudflare-gated page</b></summary>

```bash
node examples/ashby.js "https://jobs.ashbyhq.com/<company>/<job-id>"
```

Navigates, hands off if Cloudflare appears, and prints the job once you're
through. See also `examples/agent-browser.js` (CDP attach) and
`examples/try-handoff.js` (feel the UX with no captcha).
</details>

---

## Headless vs. headful (do I need Xvfb? usually no)

**The handoff works headless** — the live view streams and your taps land
regardless. Headless is the default; start there.

Headful changes exactly one thing: **the odds Cloudflare lets you through**, since
it fingerprints headless Chromium. If a wall hard-loops even after you click, run
headful. `launch()` auto-detects your display (X11 or Wayland) and picks the right
backend; on a headless server use a virtual display:

```bash
HEADLESS=false node examples/ashby.js "<url>"           # desktop
HEADLESS=false xvfb-run -a node examples/ashby.js "<url>"   # headless server
```

If no display is reachable, `launch()` warns and falls back to headless instead
of crashing. A persistent profile (`./.chrome-profile`) keeps the "verified"
cookie, so the wall usually stops reappearing on later runs.

---

## Configuration

All optional — see `.env.example`.

| Env | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Push the take-over link to your phone |
| `TUNNEL` | `auto` | Public URL: `auto`/`cloudflared`/`ngrok`/`localtunnel`/`lan` |
| `NGROK_AUTHTOKEN` | — | Free ngrok token, if you use `TUNNEL=ngrok` |
| `PUBLIC_BASE_URL` | — | Your own tunnel / reverse proxy — always wins |
| `HEADLESS` | `true` | `false` = headful (better against Cloudflare) |
| `CHROME_PATH` | auto-detected | Browser binary (override the cross-platform search) |
| `CHROME_ARGS` | — | Extra Chromium flags (e.g. `--ozone-platform=wayland`) |
| `USER_DATA_DIR` | `./.chrome-profile` | Persistent profile (keeps you "verified") |
| `PORT` | `7411` | Live-view server port |

**Public access (NAT traversal):** the take-over link must reach your phone, not
just the LAN. `TUNNEL=auto` creates one for you, preferring **cloudflared quick
tunnels** (free, no account, HTTPS, no click-through). If the `cloudflared`
binary isn't on your `PATH`, it's fetched once (~35 MB) into `~/.cache/volleybot`.
Falls back to `ngrok`, then `localtunnel` (via `npx`), then the LAN address.

---

## Security / trust model

- The live-view URL carries a **random 128-bit token** — only someone with the
  link can view or drive the browser. **Treat it like a password.**
- Whoever holds the link has **full control of that browser session**, including
  whatever it's logged into. Send it only to yourself; the tunnel URL dies when
  the process exits.
- Beyond a personal setup: put the live view behind auth (a shared secret,
  Cloudflare Access, a reverse proxy) and add per-session token TTLs.
- Nothing goes to a third party: frames and input flow between the agent host and
  your device only (plus your tunnel provider, if you use one).

---

## Limitations & honest caveats

- **It does not defeat anti-bot systems.** It relies on a genuine human.
- The screencast captures the **visible viewport**; scrolling is relayed, but
  very tall challenges need a scroll (fine for the in-viewport widgets captchas
  actually are).
- Keyboard relay covers text entry and common keys; exotic IME input isn't
  handled yet.
- Headless gets challenged more; reach for headful only when a wall hard-loops.

---

## Roadmap

- **Publish to npm** (`npx volleybot`, `npm i -g volleybot`).
- **MCP tool** — expose handoff as a Model Context Protocol action for any
  MCP-capable agent.
- **More channels** — Signal / WhatsApp / Slack alongside Telegram.
- **Auto-resume on token issuance** — resume the instant a valid Turnstile /
  hCaptcha token appears, no manual tap.
- **noVNC variant** — OS-level input for the very pickiest challenges.
- **Session recording** — an audit trail of what the human did during handoff.

Contributions welcome — it's a small, dependency-light codebase (see below).

---

## Project layout

```
bin/volleybot.js            the CLI: `handoff`, `detect`
src/handoff-browser.js      entry points: launch / fromPage / attachOverCDP; ensureHuman / handoff
src/live-view.js            CDP screencast ⇄ WebSocket ⇄ input relay + resume
src/detectors.js            challenge detection (Cloudflare/hCaptcha/reCAPTCHA/DataDome)
src/tunnel.js               cloudflared / ngrok / localtunnel / LAN (auto)
src/notify.js               Telegram + terminal QR
src/resolve-browser.js      cross-platform Chrome/Chromium/Edge/Brave discovery
public/viewer.html          the take-over page you open on your phone
skills/human-handoff/       drop-in OpenClaw skill
examples/                   try-handoff · ashby · agent-browser
test/                       smoke (plumbing) · attach-cdp (CDP path) — no human, no captcha
```

---

MIT © Daniel Cukier. See [LICENSE](./LICENSE).
