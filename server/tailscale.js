// Finds out how this machine is reachable over Tailscale. Never required: without Tailscale the
// server still runs on 127.0.0.1, it just isn't reachable from your phone.
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';

export const DOWNLOAD_URL = 'https://tailscale.com/download';
export const SERVE_DOCS_URL = 'https://tailscale.com/kb/1312/serve';

const CANDIDATES = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale', // macOS App Store / standalone app
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code, stdout, stderr: stderr || err?.message || '' }));
  });
}

async function findBinary() {
  for (const c of CANDIDATES) {
    if (c.includes('/') && !fs.existsSync(c)) continue;
    const r = await run(c, ['version']);
    if (r.ok) return c;
  }
  return null;
}

// Which https URL (if any) `tailscale serve` maps to http://127.0.0.1:<port>, and whether
// anything is exposed with Funnel (the public internet).
function readServe(cfg, port, dnsName) {
  const out = { url: null, funnel: false, rootTaken: null, usedPorts: Object.keys(cfg?.TCP || {}) };
  const target = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`);
  for (const [hostPort, web] of Object.entries(cfg?.Web || {})) {
    const proxy = web?.Handlers?.['/']?.Proxy || '';
    const [, p] = hostPort.split(/:(?=\d+$)/);
    if (target.test(proxy)) {
      out.url = `https://${dnsName}${p === '443' ? '' : ':' + p}`;
      if (cfg?.AllowFunnel?.[hostPort]) out.funnel = true;
    } else if (p === '443' && proxy) {
      out.rootTaken = proxy;
    }
  }
  return out;
}

// { installed, running, dnsName, url, funnel, rootTaken, bin, error }
export async function detect(port) {
  const bin = await findBinary();
  if (!bin) return { installed: false };
  const st = await run(bin, ['status', '--json']);
  let status = null;
  try { status = JSON.parse(st.stdout); } catch {}
  if (!status || status.BackendState !== 'Running') {
    return { installed: true, running: false, bin, state: status?.BackendState || 'unknown', error: st.ok ? '' : st.stderr.trim() };
  }
  const dnsName = (status.Self?.DNSName || '').replace(/\.$/, '');
  const sv = await run(bin, ['serve', 'status', '--json']);
  let cfg = {};
  try { cfg = JSON.parse(sv.stdout || '{}'); } catch {}
  return { installed: true, running: true, bin, dnsName, magicDNS: status.CurrentTailnet?.MagicDNSEnabled !== false, ...readServe(cfg, port, dnsName) };
}

// `tailscale serve --bg <port>`, or on another HTTPS port when 443 is already used by something else.
export function serveArgs(port, ts) {
  const https = ['443', '8443', '10000'].find((p) => !ts.usedPorts?.includes(p)) || '10000';
  return https === '443' ? ['serve', '--bg', String(port)] : ['serve', '--bg', `--https=${https}`, String(port)];
}

// Shows tailscale's own output as it goes: the first time, it may print a link to turn on
// HTTPS / Serve for the tailnet and wait until you do.
export function enableServe(port, ts) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(ts.bin, serveArgs(port, ts), { stdio: ['ignore', 'pipe', 'pipe'] });
    const tee = (to) => (chunk) => { output += chunk; to.write(chunk); };
    child.stdout.on('data', tee(process.stdout));
    child.stderr.on('data', tee(process.stderr));
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on('error', (err) => { output += err.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Linux: only root (or the operator) may change serve config.
      const needsOperator = /access denied|permission denied|operator/i.test(output);
      resolve({ ok: code === 0, output: output.trim(), needsOperator });
    });
  });
}
