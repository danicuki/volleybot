// Public URL for the live view, so you can solve the challenge from a phone on
// cellular — anywhere, not just the agent host's LAN.
//
// Providers are tried in order; force one with the TUNNEL env var
// (cloudflared | ngrok | localtunnel | lan). PUBLIC_BASE_URL always wins.
//
//   TUNNEL=auto (default): PUBLIC_BASE_URL -> cloudflared -> ngrok -> localtunnel -> LAN
//
// cloudflared "quick tunnels" (https://<x>.trycloudflare.com) are the default:
// free, no account, HTTPS, and no click-through interstitial. If the binary
// isn't installed we fetch it once (~35 MB) into ~/.cache/volleybot.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'volleybot');

/**
 * @param {number} port
 * @returns {Promise<{baseUrl: string, kind: string, close: () => void}>}
 */
export async function openPublicUrl(port) {
  const forced = (process.env.TUNNEL || 'auto').toLowerCase();

  if (process.env.PUBLIC_BASE_URL) {
    return lan(process.env.PUBLIC_BASE_URL.replace(/\/$/, ''), 'env');
  }
  if (forced === 'lan' || forced === 'none') {
    return lan(`http://${lanAddress()}:${port}`, 'lan');
  }

  // Ordered candidate providers.
  const order =
    forced === 'auto'
      ? ['cloudflared', 'ngrok', 'localtunnel']
      : [forced];

  for (const name of order) {
    const provider = PROVIDERS[name];
    if (!provider) {
      console.warn(`   (unknown TUNNEL="${name}"; skipping)`);
      continue;
    }
    try {
      console.log(`   … opening ${name} tunnel`);
      const t = await provider(port);
      console.log(`   ✓ public URL via ${name}: ${t.baseUrl}`);
      return t;
    } catch (e) {
      console.warn(`   (${name} unavailable: ${e.message})`);
    }
  }

  const url = `http://${lanAddress()}:${port}`;
  console.warn(
    `   ⚠ no public tunnel available — using LAN URL ${url}\n` +
      `     (same-Wi-Fi only. Install cloudflared, set NGROK_AUTHTOKEN, or set PUBLIC_BASE_URL.)`
  );
  return lan(url, 'lan');
}

const PROVIDERS = {
  cloudflared: cloudflaredTunnel,
  ngrok: ngrokTunnel,
  localtunnel: localtunnelTunnel,
};

// ---- cloudflared (default) ------------------------------------------------

async function cloudflaredTunnel(port) {
  const bin = await ensureCloudflared();
  return spawnAndMatch({
    bin,
    args: ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
    // cloudflared prints the URL to stderr.
    re: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
    kind: 'cloudflared',
    timeoutMs: 20_000,
  });
}

/** Resolve a cloudflared binary: PATH -> cache -> download once. */
async function ensureCloudflared() {
  if (await onPath('cloudflared')) return 'cloudflared';

  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : 'amd64';
  const dest = path.join(CACHE_DIR, `cloudflared-linux-${arch}`);
  if (await isExecutable(dest)) return dest;

  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
  console.log(`   ↓ fetching cloudflared (one-time, ~35 MB) → ${dest}`);
  await mkdir(CACHE_DIR, { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  await chmod(dest, 0o755);
  return dest;
}

// ---- ngrok ----------------------------------------------------------------
// Uses the ngrok CLI if present. ngrok v3 needs a (free) authtoken: either
// already configured, or provided via NGROK_AUTHTOKEN.

async function ngrokTunnel(port) {
  if (!(await onPath('ngrok'))) throw new Error('ngrok CLI not installed');
  const args = ['http', String(port), '--log', 'stdout'];
  if (process.env.NGROK_AUTHTOKEN) args.push('--authtoken', process.env.NGROK_AUTHTOKEN);
  const proc = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.on('error', () => {});
  // ngrok exposes a local API with the assigned public URL.
  try {
    const baseUrl = await pollJson(
      'http://127.0.0.1:4040/api/tunnels',
      (j) => j?.tunnels?.find((t) => t.public_url?.startsWith('https'))?.public_url,
      20_000
    );
    return { baseUrl, kind: 'ngrok', close: () => proc.kill() };
  } catch (e) {
    proc.kill();
    throw e;
  }
}

// ---- localtunnel (no account, no binary; via npx) -------------------------
// Note: loca.lt shows a one-time click-through page to visitors. Fine, just
// less slick than cloudflared.

async function localtunnelTunnel(port) {
  return spawnAndMatch({
    bin: 'npx',
    args: ['--yes', 'localtunnel', '--port', String(port)],
    re: /https:\/\/[a-z0-9-]+\.loca\.lt/,
    kind: 'localtunnel',
    timeoutMs: 45_000, // npx may install first
  });
}

// ---- helpers --------------------------------------------------------------

function spawnAndMatch({ bin, args, re, kind, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    let settled = false;
    const onData = (buf) => {
      const m = buf.toString().match(re);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ baseUrl: m[0], kind, close: () => proc.kill() });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => !settled && (clearTimeout(timer), reject(e)));
    proc.on('close', (code) => {
      if (!settled) {
        clearTimeout(timer);
        reject(new Error(`exited (code ${code}) before printing a URL`));
      }
    });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error('timed out waiting for tunnel URL'));
      }
    }, timeoutMs);
  });
}

function onPath(cmd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, ['--version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

async function isExecutable(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function pollJson(url, pick, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const j = await (await fetch(url)).json();
      const v = pick(j);
      if (v) return v;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timed out waiting for tunnel URL');
}

function lan(baseUrl, kind) {
  return { baseUrl, kind, close() {} };
}

function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}
