---
name: human-handoff
description: When a browser task is blocked by a captcha, Cloudflare/Turnstile, hCaptcha/reCAPTCHA, a "verify you are human" wall, 2FA/OTP, or a login you can't complete, hand the LIVE browser to a human who solves it remotely on their phone, then resume the same session. Use this instead of giving up or guessing whenever you hit a manual verification blocker.
metadata: {"openclaw":{"emoji":"🙋","homepage":"https://github.com/danicuki/volleybot","requires":{"bins":["node"]}}}
---

# Human handoff for verification walls (volleybot)

Your browser tooling (agent-browser / the browser skill) already flags
captcha, 2FA, and login as **manual blockers** it won't guess past. This skill
is what to do about them: hand the *live* browser session to a human who solves
the check from anywhere, then continue exactly where you left off.

## When to use
Trigger this the moment you detect any of:
- Cloudflare interstitial ("Just a moment…", "Verify you are human") or Turnstile
- hCaptcha / reCAPTCHA / DataDome image or checkbox challenges
- 2FA / OTP / email-code prompts, or a login you don't have credentials for
- any "manual action required" blocker your browser skill reports

## Setup
The human must drive the **same** live browser you're driving. If you use
**agent-browser**, this is automatic — the wrapper discovers your browser's CDP
endpoint via `agent-browser get cdp-url`, so there's nothing to configure.

Only if you're NOT on agent-browser, point volleybot at your browser's CDP
endpoint yourself:

```bash
export VOLLEYBOT_CDP=http://localhost:9222   # or a ws://…/devtools/browser/<id> URL
```

Optional but recommended, so the human can solve from their phone:
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — push the take-over link to the phone
- `TUNNEL=cloudflared` — make the link reachable off-LAN

## What to do when blocked
Run this with the `exec` tool. **It BLOCKS until the human has solved the wall,
then returns** — do not do anything else until it exits:

```bash
bash {baseDir}/scripts/handoff.sh "Cloudflare Turnstile on <site> — need a human to verify"
```

Read the output:
- `HANDOFF_URL=<link>` — the take-over link is live and has been sent to the
  human. Wait.
- `HANDOFF_COMPLETE by=human` (or `by=auto`) — **success.** Now **re-snapshot the
  page** and continue your original task on the same session; the wall is gone.
- `NO_HANDOFF_NEEDED` — there was no wall after all; just continue.
- non-zero exit / error — report it; don't loop blindly.

## Notes
- This is human-in-the-loop by design: a real person passes the check. It does
  not auto-solve captchas.
- The link grants control of the live browser — it's single-use, token-gated,
  and dies when the command exits.
- To force a handoff for something with no auto-detectable wall (e.g. a login
  only the human can complete), add `--force`:
  `volleybot handoff --cdp "$VOLLEYBOT_CDP" --force --reason "log into <site>"`.
