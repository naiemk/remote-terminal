// Regenerates the screenshots in docs/images:  npm run screenshots
//
// Everything runs against a throwaway home directory and a fake `tailscale` command
// (fake-tailscale.sh), so the pictures show "you@laptop" and laptop.tail1234.ts.net instead
// of whatever machine and tailnet you run this on. Needs Chromium: set CHROMIUM=/path/to/chrome
// if it isn't at /usr/bin/chromium (or run `npx playwright install chromium`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { chromium, devices } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'docs/images');
const PORT = 12811;           // shown as 12700 in the pictures
const SHOWN_PORT = '12700';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.argv.slice(2); // e.g. `npm run screenshots -- console`
const want = (name) => !only.length || only.some((o) => name.startsWith(o));

// ---------- a throwaway world ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-shots-'));
const HOME = path.join(tmp, 'home', 'you');
const FAKE_BIN = path.join(tmp, 'fakebin');
const TS_STATE = path.join(tmp, 'ts-state');
const NODE_DIR = path.dirname(process.execPath);
for (const d of [HOME, FAKE_BIN, TS_STATE, OUT]) fs.mkdirSync(d, { recursive: true });

fs.copyFileSync(path.join(ROOT, 'docs/scripts/fake-tailscale.sh'), path.join(FAKE_BIN, 'tailscale'));
fs.chmodSync(path.join(FAKE_BIN, 'tailscale'), 0o755);
fs.symlinkSync(path.join(ROOT, 'bin/remote-terminal-server'), path.join(FAKE_BIN, 'remote-terminal-server'));

fs.writeFileSync(path.join(HOME, '.bashrc'), [
  `PS1='\\[\\e[1;32m\\]you@laptop\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ '`,
  'export LS_COLORS="di=1;34:ex=1;32"',
  `alias ls='ls --color=auto'`,
  'HISTFILE=/dev/null',
].join('\n') + '\n');
fs.writeFileSync(path.join(HOME, '.bash_profile'), '. ~/.bashrc\n');

// A small project to look at in the terminal.
const APP = path.join(HOME, 'code', 'my-app');
fs.mkdirSync(path.join(APP, 'src'), { recursive: true });
fs.writeFileSync(path.join(APP, 'README.md'), '# my-app\n');
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: 'my-app', scripts: {
  dev: `node -e "console.log('\\x1b[32m✓\\x1b[0m Ready on http://localhost:3000'); setInterval(() => {}, 1e6)"`,
} }, null, 2) + '\n');
fs.writeFileSync(path.join(APP, 'src', 'index.js'), 'console.log("hi")\n');
const git = (...a) => execFileSync('git', a, { cwd: APP, env: { ...process.env, HOME, GIT_AUTHOR_NAME: 'You', GIT_AUTHOR_EMAIL: 'you@example.com', GIT_COMMITTER_NAME: 'You', GIT_COMMITTER_EMAIL: 'you@example.com' } });
git('init', '-q', '-b', 'main');
for (const msg of ['Initial commit', 'Add README', 'Wire up the API client', 'Fix login redirect on Safari', 'Cache user settings']) {
  fs.appendFileSync(path.join(APP, 'src', 'index.js'), `// ${msg}\n`);
  git('add', '-A'); git('commit', '-q', '-m', msg);
}

const baseEnv = {
  HOME, USER: 'you', LOGNAME: 'you', SHELL: '/bin/bash', TERM: 'xterm-256color', LANG: 'C.UTF-8',
  FAKE_TS_STATE: TS_STATE, FAKE_TS_PORT: String(PORT), PORT: String(PORT),
};
const withTailscale = { ...baseEnv, PATH: [FAKE_BIN, NODE_DIR, '/usr/bin', '/bin'].join(':') };
// No tailscale anywhere on PATH (the real one usually lives in /usr/bin).
const noTsBin = path.join(tmp, 'notsbin');
fs.mkdirSync(noTsBin);
for (const b of ['ls', 'clear']) try { fs.symlinkSync(execFileSync('which', [b]).toString().trim(), path.join(noTsBin, b)); } catch {}
fs.symlinkSync(path.join(ROOT, 'bin/remote-terminal-server'), path.join(noTsBin, 'remote-terminal-server'));
const withoutTailscale = { ...baseEnv, PATH: [noTsBin, NODE_DIR].join(':') };

function sanitize(s) {
  return s
    .replaceAll(HOME, '/home/you')
    .replaceAll(ROOT, '/home/you/src/remote-terminal')
    .replaceAll(process.execPath, '/usr/local/bin/node')
    .replaceAll(String(PORT), SHOWN_PORT);
}

// ---------- terminal transcripts ----------

// Runs an interactive bash in a PTY, types `steps` into it, and returns everything it printed.
async function session({ env, cols = 96, rows = 30, steps }) {
  const p = pty.spawn('/bin/bash', ['--rcfile', path.join(HOME, '.bashrc'), '-i'], { name: 'xterm-256color', cols, rows, cwd: HOME, env });
  let out = '';
  p.onData((d) => (out += d));
  await sleep(400);
  for (const s of steps) {
    if (s.type) for (const ch of s.type) { p.write(ch); await sleep(12); }
    if (s.wait) await sleep(s.wait);
    if (s.until) for (let i = 0; i < 600 && !s.until.test(out); i++) await sleep(250);
  }
  p.kill();
  return { out: sanitize(out), cols, rows };
}

const XTERM = path.join(ROOT, 'node_modules/@xterm/xterm');
function terminalPage({ out, cols, rows, lineHeight = 1.2 }, title) {
  const file = path.join(tmp, `term-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@500&display=swap">
<link rel="stylesheet" href="file://${XTERM}/css/xterm.css">
<style>
  html,body{margin:0;background:transparent}
  #win{display:inline-block;margin:28px;border-radius:12px;overflow:hidden;background:#0b0d12;
       box-shadow:0 0 0 1px rgba(255,255,255,.08),0 18px 50px rgba(0,0,0,.35)}
  #bar{height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#161a22;
       font:500 12.5px Inter,sans-serif;color:#8a91a5;position:relative}
  #bar i{width:12px;height:12px;border-radius:50%;display:block}
  #bar span{position:absolute;left:0;right:0;text-align:center;pointer-events:none}
  #t{padding:10px 14px 14px}
  .xterm-viewport{overflow:hidden!important}
</style></head><body>
<div id="win"><div id="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>${title}</span></div><div id="t"></div></div>
<script src="file://${XTERM}/lib/xterm.js"></script>
<script>
  document.fonts.load('14px "JetBrains Mono"').then(() => document.fonts.load('bold 14px "JetBrains Mono"')).finally(() => {
    const term = new Terminal({ cols: ${cols}, rows: ${rows}, fontFamily: '"JetBrains Mono", monospace', fontSize: 14, lineHeight: ${lineHeight},
      cursorBlink: false, cursorStyle: 'bar', scrollback: 0,
      theme: { background: '#0b0d12', foreground: '#d9dee8', cursor: '#0b0d12', black: '#1c1f29', red: '#f07178', green: '#a6da95',
        yellow: '#eed49f', blue: '#8aadf4', magenta: '#c6a0f6', cyan: '#8bd5ca', white: '#cad3f5', brightBlack: '#5b6178',
        brightRed: '#ff8b92', brightGreen: '#bdf2ab', brightYellow: '#ffe2ad', brightBlue: '#a6c3ff', brightMagenta: '#dcbcff',
        brightCyan: '#a5efe4', brightWhite: '#ffffff' } });
    term.open(document.getElementById('t'));
    term.write(${JSON.stringify(out)}, () => setTimeout(() => (window.done = true), 200));
  });
</script></body></html>`);
  return 'file://' + file;
}

// Trims empty rows off the bottom so each picture is only as tall as its content.
function trimRows(out, rows) {
  const lines = out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g, '').split('\n');
  return Math.max(6, Math.min(rows, lines.length + 1));
}

async function shootTerminal(browser, name, transcript, title) {
  const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1400, height: 1200 } });
  await page.goto(terminalPage({ ...transcript, rows: trimRows(transcript.out, transcript.rows) }, title));
  await page.waitForFunction(() => window.done, null, { timeout: 15000 });
  await page.locator('#win').screenshot({ path: path.join(OUT, name), omitBackground: true });
  await page.close();
  console.log(`  docs/images/${name}`);
}

// ---------- run ----------

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined) });
let server;
try {
  if (want('install')) {
    console.log('install (compiles node-pty; about a minute)…');
    const t = await session({
      env: { ...withTailscale, REMOTE_TERMINAL_SOURCE: ROOT, REMOTE_TERMINAL_NO_MODIFY_PATH: '1' }, cols: 104, rows: 26,
      steps: [{ type: `bash ${ROOT}/install.sh\r`, until: /Docs:/ }, { wait: 300 }],
    });
    t.out = t.out
      .replace(`bash /home/you/src/remote-terminal/install.sh`, 'curl -fsSL https://raw.githubusercontent.com/naiemk/remote-terminal/main/install.sh | bash')
      .replace(/Installing from \/home\/you\/src\/remote-terminal/, 'Downloading naiemk/remote-terminal@main');
    await shootTerminal(browser, 'install.png', t, 'Terminal');
  }

  if (want('cli')) {
    console.log('cli…');
    await shootTerminal(browser, 'cli-no-tailscale.png', await session({
      env: withoutTailscale, rows: 22,
      steps: [{ type: 'remote-terminal-server\r', until: /Stop with Ctrl\+C/ }, { wait: 300 }],
    }), 'remote-terminal-server — no Tailscale');

    fs.rmSync(path.join(TS_STATE, 'served'), { force: true });
    await shootTerminal(browser, 'cli-serve-prompt.png', await session({
      env: withTailscale, rows: 12,
      steps: [{ type: 'remote-terminal-server\r', until: /\[Y\/n\]/ }, { wait: 300 }],
    }), 'remote-terminal-server — first run');

    fs.rmSync(path.join(TS_STATE, 'served'), { force: true });
    await shootTerminal(browser, 'cli-ready.png', await session({
      env: withTailscale, rows: 46,
      steps: [{ type: 'remote-terminal-server\r', until: /\[Y\/n\]/ }, { wait: 500 }, { type: 'y\r', until: /▀|▄|█/ }, { wait: 800 }],
    }).then((t) => ({ ...t, lineHeight: 1 })), 'remote-terminal-server');

    await shootTerminal(browser, 'tailscale-dns.png', await session({
      env: withTailscale, rows: 16,
      steps: [
        { type: 'tailscale status\r', wait: 400 },
        { type: 'tailscale status --json | jq -r .Self.DNSName\r', wait: 500 },
        { type: 'tailscale serve status\r', wait: 500 },
      ],
    }), 'Finding your machine’s name');
  }

  if (want('console')) {
    console.log('console…');
    fs.mkdirSync(path.join(HOME, '.remote-terminal-server'), { recursive: true });
    fs.writeFileSync(path.join(HOME, '.remote-terminal-server', 'commands.json'), JSON.stringify({
      bash: 'bash', claude: 'claude', codex: 'codex', btop: 'btop', 'my-app dev': { cmd: 'npm run dev', cwd: '~/code/my-app' },
    }, null, 2));
    server = spawn(process.execPath, [path.join(ROOT, 'bin/remote-terminal-server'), '--no-serve', '--no-qr'], { env: withTailscale, stdio: 'ignore' });
    const base = `http://127.0.0.1:${PORT}`;
    for (let i = 0; i < 40; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(250); } }
    const start = (command, cwd) => fetch(base + '/api/instances', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ command, cwd }),
    }).then((r) => r.json());
    const bash = await start('bash', '~/code/my-app');
    await sleep(300);
    const dev = await start('my-app dev');

    // Phone
    const ctx = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForSelector('[data-join]');
    await page.fill('#cwd', '~/code/my-app');
    await sleep(800);
    await page.screenshot({ path: path.join(OUT, 'console-home.png') });
    console.log('  docs/images/console-home.png');

    await page.click(`[data-join="${bash.id}"]`);
    await sleep(1200);
    // The compose sheet stays open after sending; tapping outside it closes it.
    const openCompose = async () => {
      if (await page.getAttribute('#sheet', 'aria-hidden') === 'true') { await page.click('#fab'); await sleep(500); }
    };
    const closeCompose = async () => {
      if (await page.getAttribute('#sheet', 'aria-hidden') === 'false') { await page.click('#scrim', { position: { x: 20, y: 120 } }); await sleep(500); }
    };
    await openCompose();
    await page.fill('#compose', 'ls');
    await page.click('#send'); await sleep(900);
    await openCompose();
    await page.fill('#compose', 'git log --oneline');
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, 'console-compose.png') });
    console.log('  docs/images/console-compose.png');
    await page.click('#send'); await sleep(900);
    await closeCompose(); await sleep(600);
    await page.screenshot({ path: path.join(OUT, 'console-terminal.png') });
    console.log('  docs/images/console-terminal.png');

    await page.click('#status'); await sleep(500);
    await page.screenshot({ path: path.join(OUT, 'console-menu.png') });
    console.log('  docs/images/console-menu.png');
    await ctx.close();

    // Desktop: the same terminal, viewed from a second browser at the same time
    const desk = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    const dpage = await desk.newPage();
    await dpage.goto(base);
    await dpage.waitForSelector(`[data-join="${bash.id}"]`);
    await dpage.screenshot({ path: path.join(OUT, 'console-desktop-home.png') });
    console.log('  docs/images/console-desktop-home.png');
    await dpage.click(`[data-join="${bash.id}"]`);
    await sleep(1200);
    await dpage.keyboard.type('cat src/index.js\n', { delay: 15 });
    await sleep(1000);
    await dpage.screenshot({ path: path.join(OUT, 'console-desktop.png') });
    console.log('  docs/images/console-desktop.png');
    await desk.close();
  }
} finally {
  await browser.close();
  server?.kill('SIGTERM');
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}
