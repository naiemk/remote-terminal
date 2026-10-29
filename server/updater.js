// Upgrades the running server from the UI: re-runs the installer, then restarts the process.
// Which version is installed comes from `.version` (the commit the installer downloaded);
// "latest" is the head of the branch the installer pulls from.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = 'naiemk/remote-terminal';
const INSTALL_URL = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;
const CHECK_TTL = 10 * 60_000;

export function createUpdater({ root, version, shutdown }) {
  let latest = null, checkedAt = 0, running = false, last = null;

  const installed = () => {
    try { return fs.readFileSync(path.join(root, '.version'), 'utf8').trim() || null; } catch { return null; }
  };

  async function check(force = false) {
    if (!force && Date.now() - checkedAt < CHECK_TTL) return latest;
    checkedAt = Date.now();
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
        headers: { accept: 'application/vnd.github.sha', 'user-agent': 'remote-terminal-server' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) latest = (await res.text()).trim();
    } catch {}
    return latest;
  }

  async function status(force) {
    const have = installed();
    const want = await check(force);
    return {
      version, installed: have?.slice(0, 7) || null, latest: want?.slice(0, 7) || null,
      // Unknown installed commit (installed before this feature) counts as upgradable.
      available: !!want && want !== have,
      running, last,
    };
  }

  // Runs the installer. Resolves { ok, output }. On success the caller restarts.
  function run() {
    if (running) return Promise.resolve({ ok: false, output: 'An upgrade is already running.' });
    running = true;
    return new Promise((resolve) => {
      let output = '';
      const child = spawn('bash', ['-c', `curl -fsSL ${INSTALL_URL} | bash`], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
      const take = (d) => { output = (output + d).slice(-4000); };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', (err) => { running = false; last = { ok: false, output: err.message }; resolve(last); });
      child.on('exit', (code) => { running = false; last = { ok: code === 0, output }; resolve(last); });
    });
  }

  // Replaces this process with a fresh one running the new code. Under a service manager
  // (systemd, launchd) just exit and let it restart us; otherwise start a detached copy
  // that waits for this one to release the port. Running terminals end either way.
  function restart() {
    const supervised = !!(process.env.INVOCATION_ID || process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME !== '0');
    if (!supervised) {
      const args = [process.execPath, ...process.argv.slice(1)].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
      spawn('sh', ['-c', `sleep 1; exec ${args}`], { detached: true, stdio: 'ignore', env: { ...process.env, REMOTE_TERMINAL_RESTARTED: '1' } }).unref();
    }
    shutdown(supervised ? 1 : 0); // non-zero so Restart=on-failure fires
  }

  return { status, run, restart };
}
