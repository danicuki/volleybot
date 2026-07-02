# volleybot

**Human handoff for AI browser agents — the agent sets, you spike.** When your
agent hits a captcha or "prove you're human" wall, it hands its *live* browser
to you over a URL. You solve it from any device — phone, laptop, anywhere — and
the agent resumes from the exact same session. Cookies, login, scroll position:
all intact.

This is the thing that unsticks an autonomous agent without you needing physical
access to its machine, a remote desktop, or a third-party captcha-solving farm.

```
 ┌──────────┐   1. hits a wall    ┌──────────────┐   2. link/QR/Telegram   ┌────────┐
 │  agent   │ ──────────────────► │ captcha-     │ ──────────────────────► │  you   │
 │ (headless│                     │ handoff      │                         │ (phone)│
 │ browser) │ ◄────────────────── │ live view    │ ◄────────────────────── │        │
 └──────────┘   4. resumes here   └──────────────┘   3. you tap/solve it    └────────┘
```

---

## Why this exists (and what already exists)

The pattern — "let a human step into the agent's browser to pass a check" — is
real and shipping in a few commercial products:

| Product | What it gives you | Gap this fills |
|---|---|---|
| **Cloudflare Browser Run** — "Human-in-the-Loop Handoff" | Live view + take-over of a cloud Chrome | Tied to Cloudflare's browser service |
| **Browserbase** — Live View / session takeover | Live view + auto captcha solving | Hosted; your session runs on their infra |
| **BrowserAct** — `remote-assist` | Live URL, human takes over from any device, agent resumes | Closed platform |
| **Steel.dev** | Open-source browser API + session viewer | Viewer is for debugging, not a handoff protocol |
| **agent-browser** (vercel-labs) | Open-source CDP CLI; has a WS stream w/ input + captcha *solver* plugins | No human-handoff protocol — but volleybot **attaches to it over CDP** (see below) |
| **2captcha / CapSolver / Anti-Captcha** | *Automated* solving via a worker farm | A different (and grayer) thing — not *you* solving it |

**What none of them are: a small, self-hosted, agent-agnostic piece you fully
own** — that runs against *your* browser on *your* machine, pings *your* phone,
and never routes your session or credentials through someone else's cloud. That
is what this is. It's ~600 lines, has no build step, and works with any
Playwright/Chromium-driven agent.

> This is human-in-the-loop by design. **A real person passes the human check.**
> It is not an automated captcha bypass and ships with no solver.

---

## The handoff, mapped to your four steps

1. **Agent stuck** — `detectChallenge(page)` spots the wall (Cloudflare
   Turnstile, hCaptcha, reCAPTCHA, DataDome, or a generic interstitial).
2. **Hand off with minimum friction** — a live-view session spins up, and you get
   a tappable link (Telegram) + a terminal QR + an optional public tunnel URL.
   You open it in a normal browser; no VNC client, no app install.
3. **You pass the human phase** — you see the real browser streamed live and
   interact with it (tap, drag, type, scroll) exactly as if it were on your desk.
4. **Agent resumes** — you tap **"Solved — resume"** (or the wall auto-clears)
   and `ensureHuman()` returns. The agent continues on the same live session.

---

## How it works (architecture)

```
agent code ──► HandoffBrowser ──► Playwright (real Chromium, persistent profile)
                    │
                    ├─ detectors.js     : is there a wall on this page?
                    ├─ LiveView         : CDP screencast  ⇄  WebSocket  ⇄  viewer.html
                    │      • Page.startScreencast  → JPEG frames → your screen
                    │      • Input.dispatch*       ← your taps/keys ← your screen
                    ├─ tunnel.js         : PUBLIC_BASE_URL / cloudflared / LAN
                    └─ notify.js         : Telegram + terminal QR
```

**The important design choice: input is relayed via the Chrome DevTools
Protocol, driven by your real hand.** When you move/tap on the streamed image,
those coordinates are replayed with `Input.dispatchMouseEvent`. Two properties
fall out of this that matter for anti-bot walls:

- CDP-dispatched events are **`isTrusted: true`** at the DOM level — they come
  from the browser engine, not from injected JavaScript, so they're
  indistinguishable from a physical click to the page.
- The **movement path and timing are genuinely yours**. Behavioural analysis in
  Turnstile/hCaptcha sees real human motion, just relayed over the wire.

That's why a relayed screencast beats "screenshot to Telegram, type the answer
back": it handles click-the-images, drag-the-slider, and press-and-hold
challenges, not just text — and the *page itself* is what gets interacted with,
so the token it issues is valid.

---

## Quick start

```bash
npm install            # uses your system Chromium at /usr/bin/chromium
npm test               # smoke test: streaming + input relay + resume (no human needed)

# demo: scrape a Cloudflare-gated Ashby job
node examples/ashby.js "https://jobs.ashbyhq.com/<company>/<job-id>"
```

When a wall appears, the terminal prints a URL + QR (and Telegram pings you if
configured). Open it, solve, tap **resume**. Done.

### Do I actually need headful / Xvfb? (usually no)

**The handoff itself works in headless** — the live view streams and your taps
land on the page regardless. Headless is the default; start there.

Headful only changes *one* thing: **the odds Cloudflare lets you through.** CF
fingerprints headless Chromium, so on a stubborn wall it can loop the challenge
even after a human clicks. If that happens, run headful for a higher pass rate.
`launch()` auto-detects your display and picks the backend for you:

- **On a desktop (X11 or Wayland/Hyprland)** — just `HEADLESS=false`. It probes
  `$WAYLAND_DISPLAY` / `$DISPLAY` and passes the right `--ozone-platform`. No
  Xvfb needed. Force one with `CHROME_ARGS=--ozone-platform=wayland` if you like.
- **On a headless server** — start a virtual display so headful has something to
  draw on: `HEADLESS=false xvfb-run -a node examples/ashby.js "<url>"`.
  (If there's no display at all, `launch()` warns and falls back to headless
  rather than crashing.)

> Arch note: if `xvfb-run` fails with a missing lib (e.g. `libnettle.so.9`),
> that's a partial-upgrade mismatch — run `sudo pacman -Syu` (and it needs
> `xorg-xauth`). On a Wayland desktop you can skip Xvfb entirely.

A persistent profile (`./.chrome-profile`) is used by default, so once you've
proved you're human, the cookie sticks and the wall usually stops reappearing —
which is what makes headless viable on the *second* run even when the first
needed headful.

---

## Integrate it into your own agent

The whole surface is three calls:

```js
import { HandoffBrowser } from 'volleybot';

const hb = await HandoffBrowser.launch({ headless: false });
await hb.page.goto(targetUrl);

// Auto-detect a wall and block until a human clears it (no-op if none):
await hb.ensureHuman();

// ...your agent keeps driving hb.page on the same session...

await hb.close();
```

- `hb.page` is a normal Playwright `Page` — drop it into whatever your agent
  already does.
- `ensureHuman({ reason })` only hands off if a wall is actually present.
- `hb.handoff({ reason })` forces a handoff for anything (2FA, a login, a manual
  approval step) — not just captchas.

### Attach to a browser your agent already drives (CDP)

You don't have to let volleybot launch the browser. If your agent stack exposes
a Chrome DevTools Protocol endpoint — **[agent-browser](https://github.com/vercel-labs/agent-browser)**
(CDP-first daemon), Browserless, browser-use, or a raw
`chromium --remote-debugging-port=9222` — attach to it and the same handoff runs
on the agent's own live session:

```js
const hb = await HandoffBrowser.attachOverCDP({ cdpEndpoint: 'http://localhost:9222' });
await hb.ensureHuman();     // stream + relay + notify + resume, on the agent's page
await hb.close();           // detaches only — never kills the agent's browser
```

Point both your agent and volleybot at the *same* debugging port so they share
one session. See `examples/agent-browser.js` for the full agent-browser recipe,
and `npm run test:attach` for a test that proves it end-to-end against a real
external CDP browser. This is what makes volleybot **agent-agnostic** — it's a
handoff layer, not another browser framework.

---

## The `volleybot` CLI (for agents)

Agents don't import a library — they run a command and wait. That's what the CLI
is for: **it blocks until the human has solved the wall, then exits.**

```bash
volleybot handoff --cdp http://localhost:9222 --reason "Cloudflare on ashby.com"
volleybot detect  --cdp http://localhost:9222     # exit 0 = wall present, 1 = clear
```

`handoff` attaches over CDP, and if a wall is present hands off and blocks;
stdout carries machine-readable markers an agent can key off:

| stdout | meaning |
|---|---|
| `HANDOFF_URL=<link>` | take-over link is live (also sent via Telegram) — wait |
| `HANDOFF_COMPLETE by=human` / `by=auto` | solved — re-snapshot and continue |
| `NO_HANDOFF_NEEDED` | no wall was present; just continue |

Set `$VOLLEYBOT_CDP` to skip `--cdp`. Add `--force` to hand off for a step with
no auto-detectable wall (a login, 2FA). Get it on `PATH` with `npm link` in this
repo.

## Use it from an OpenClaw agent

OpenClaw's browser skill already stops on captcha / 2FA / login as **manual
blockers** — this fills that gap so a human clears them and the agent continues.
Ships as a drop-in skill (`skills/human-handoff/`).

```bash
# 1. put the CLI on PATH
cd volleybot && npm link

# 2. install the skill
cp -r skills/human-handoff ~/.openclaw/skills/human-handoff

# 3. run your agent against a SHARED browser (so the human drives the same one)
chromium --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/agent &
export VOLLEYBOT_CDP=http://localhost:9222
export TUNNEL=cloudflared                       # off-LAN link
export TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=…   # push link to your phone
agent-browser --cdp 9222 open "<url>"           # your agent drives via agent-browser
```

Now when the agent hits a wall, the skill runs
`volleybot handoff` (blocking), you get a phone link, you solve it, and the agent
resumes on the same session. The skill's `description` makes OpenClaw invoke it
automatically on a blocker; you can also trigger it with `/skill human-handoff`.

---

## Configuration

All optional — see `.env.example`.

| Env | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Get a tappable link on your phone |
| `TUNNEL` | `auto` | Public URL provider: `auto`/`cloudflared`/`ngrok`/`localtunnel`/`lan` |
| `NGROK_AUTHTOKEN` | — | Free ngrok token, if you use `TUNNEL=ngrok` |
| `PUBLIC_BASE_URL` | — | Your own tunnel/reverse proxy — always wins |
| `HEADLESS` | `true` | `false` = headful (better against Cloudflare) |
| `CHROME_PATH` | `/usr/bin/chromium` | Which browser binary to launch |
| `CHROME_ARGS` | — | Extra Chromium flags (e.g. `--ozone-platform=wayland`) |
| `USER_DATA_DIR` | `./.chrome-profile` | Persistent profile (keeps you "verified") |
| `PORT` | `7411` | Live-view server port |

**Public access (NAT traversal):** the take-over link has to reach your phone,
not just the LAN. By default (`TUNNEL=auto`) volleybot creates a public URL for
you, preferring **cloudflared quick tunnels** (`https://<x>.trycloudflare.com`) —
free, no account, HTTPS, no click-through page. If the `cloudflared` binary isn't
on your `PATH` it's fetched once (~35 MB) into `~/.cache/volleybot`. Falls back to
`ngrok` (needs `NGROK_AUTHTOKEN`), then `localtunnel` (via `npx`), then the LAN
address. Set `PUBLIC_BASE_URL` to bring your own. These ephemeral URLs die when
the process exits — treat them like passwords while live.

---

## Security / trust model

- The live-view URL carries a **random 128-bit token**; only someone with the
  link can view or drive the browser. Treat the link like a password.
- Anyone with the link has **full control of that browser session**, including
  whatever it's logged into. Only send it to yourself; the ephemeral tunnel URL
  dies when the process exits.
- For anything beyond a prototype: put the live view behind auth (a shared
  secret, Cloudflare Access, or a reverse proxy with login) and use per-session
  tokens with short TTLs (the token map already supports expiry — wire a timeout).
- Nothing is sent to a third party: frames and input flow between the agent host
  and your device only (plus your tunnel provider, if you use one).

---

## Limitations & honest caveats

- **This does not defeat anti-bot systems** — it relies on a genuine human. If a
  site would block *you* personally, it still blocks you here.
- The screencast captures the **visible viewport**; scrolling is relayed, but
  very tall challenges need a scroll. Fine for the in-viewport widgets that
  captchas actually are.
- Keyboard relay covers text entry and common keys; exotic IME input is out of
  scope for the prototype.
- Headless sessions get challenged more and pass less. Prefer headful + Xvfb.
- One browser page per session in the demo (the code supports many sessions via
  the token map).

---

## Upgrade paths (where to take it next)

- **noVNC / Xvfb variant** — swap the CDP screencast for a full VNC of a headful
  Chromium in a container. Heavier and less mobile-friendly, but relays
  OS-level input, which is the most robust option for the pickiest challenges.
- **MCP tool** — expose `ensureHuman` / `handoff` as a Model Context Protocol
  tool so *any* MCP-capable agent (including openclaw setups) can call
  "I'm blocked, get a human" as a first-class action.
- **Signal / WhatsApp / Slack** — `notify.js` is one function; add channels next
  to Telegram.
- **Auto-resume on token issuance** — instead of a manual "resume" tap, watch for
  the Turnstile/hCaptcha token to appear and resume the instant it's valid.
- **Session recording** — persist the frames for an audit trail of what the human
  did during handoff.

---

## Files

```
bin/volleybot.js            the CLI agents call: `handoff`, `detect`
src/handoff-browser.js      agent API: launch / attachOverCDP / ensureHuman / handoff
src/live-view.js            CDP screencast ⇄ WebSocket ⇄ input relay + resume
src/detectors.js            challenge detection + wait-for-cleared
src/notify.js               Telegram + terminal QR
src/tunnel.js               cloudflared / ngrok / localtunnel / LAN (auto)
public/viewer.html          the take-over page you open on your phone
skills/human-handoff/       drop-in OpenClaw skill (SKILL.md + wrapper script)
examples/ashby.js           Cloudflare-gated Ashby demo (launches its own browser)
examples/agent-browser.js   attach-over-CDP recipe (agent-browser & friends)
examples/try-handoff.js     feel the handoff UX with no captcha
test/smoke.js               end-to-end plumbing test (no human, no captcha)
test/attach-cdp.js          proves the CDP-attach / agent-browser path
```

MIT.
