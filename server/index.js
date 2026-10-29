// remote-terminal-server: serves the web client, starts terminal instances from commands.json
// in PTYs, and relays each one to any number of web clients.
//
// No password: it only listens on 127.0.0.1 and is reached through `tailscale serve`.
// What stands in for auth is checkRequest() below, which keeps other websites (and DNS
// rebinding) from driving it through your own browser.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { isAutoResponse } from '../shared/input.js';
import { ensureConfig } from './config.js';
import { createFiles } from './files.js';
import { foreground } from './procinfo.js';
import { createConsoles } from './consoles.js';
import { createManager } from './manager.js';
import { createManagerServer } from './manager-http.js';
import { createUpdater } from './updater.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR_DIR = path.join(ROOT, 'node_modules', '@xterm');
const { CONFIG_DIR, COMMANDS_FILE, ENV_FILE } = ensureConfig();
// ~/.remote-terminal-server/.env, then a .env next to the code (for development). First one wins.
const { parsed: dotenvVars = {} } = dotenv.config({ path: [ENV_FILE, path.join(ROOT, '.env')], quiet: true });

const PORT = Number(process.env.PORT || 12700);
// Loopback only, on purpose: the server is reached exclusively through `tailscale serve`,
// never directly from the LAN or the internet. Not configurable.
const BIND = '127.0.0.1';
if (process.env.BIND && process.env.BIND !== BIND) {
  console.warn(`Ignoring BIND=${process.env.BIND}: remote-terminal-server only listens on ${BIND} (expose it with tailscale serve).`);
}
const SHELL = process.env.SHELL || '/bin/bash';
const DEFAULT_CWD = expandHome(process.env.DEFAULT_CWD || os.homedir());
const SCROLLBACK_BYTES = 512 * 1024;
const files = createFiles(path.join(CONFIG_DIR, 'scratch'));

// ---------- helpers ----------

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}
const tildify = (p) => (p === os.homedir() || p.startsWith(os.homedir() + '/') ? '~' + p.slice(os.homedir().length) : p);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveFile(res, baseDir, rel) {
  const file = path.resolve(baseDir, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(baseDir + path.sep)) return sendJson(res, 404, { error: 'not found' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-frame-options': 'DENY',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Only answer requests addressed to this machine by a name we expect (blocks DNS rebinding), and
// only take actions (API calls, WebSockets) from our own page: browsers let any site send those
// cross-origin, and without a password that would mean any site could run commands here.
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
function hostAllowed(host) {
  const name = (host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1'].includes(name) || name.endsWith('.ts.net') || ALLOWED_HOSTS.includes(name);
}
function checkRequest(req, action) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!hostAllowed(host)) return 'unexpected host';
  if (!action) return null;
  let origin = null;
  try { origin = new URL(req.headers.origin).host; } catch {}
  return origin === host ? null : 'cross-origin request refused';
}

// ---------- commands ----------

// ~/.remote-terminal-server/commands.json: { "name": "command line" } or { "name": { "cmd": "…", "cwd": "~/dir" } }.
// Re-read on every use, so edits apply without a restart.
function loadCommands() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') console.error(`${COMMANDS_FILE}: ${err.message}`);
    raw = { bash: SHELL };
  }
  const out = {};
  for (const [name, v] of Object.entries(raw)) {
    const spec = typeof v === 'string' ? { cmd: v } : v;
    if (spec && typeof spec.cmd === 'string' && spec.cmd.trim()) out[name] = { cmd: spec.cmd.trim(), cwd: spec.cwd };
  }
  return out;
}

// The commands get your normal environment, minus what came from .env.
function childEnv(extra = {}) {
  const env = { ...process.env, COLORTERM: 'truecolor', REMOTE_TERM: '1', ...extra };
  for (const k of Object.keys(dotenvVars)) delete env[k];
  return env;
}

// Folders for the "start in" field: what's typed so far ("~/nk/re") → the folders it could be
// ("~/nk/remote-terminal/", …), written the way it was typed. A path ending in "/" lists its
// folders, which is also how the folder browser walks the tree. Hidden folders only show once
// a "." is typed. Relative paths are from the default folder, like the start field itself.
function listDirs(typed, limit) {
  typed = String(typed || '');
  if (typed === '~') typed = '~/';
  const cut = typed.lastIndexOf('/') + 1;
  const head = typed.slice(0, cut), prefix = typed.slice(cut);
  const dir = path.resolve(DEFAULT_CWD, expandHome(head || '.'));
  let names = [], exists = true;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || (d.isSymbolicLink() && fs.statSync(path.join(dir, d.name), { throwIfNoEntry: false })?.isDirectory())))
      .map((d) => d.name);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR' && err.code !== 'EACCES') throw err;
    exists = err.code === 'EACCES';
  }
  const lower = prefix.toLowerCase();
  const rank = (n) => (n.startsWith(prefix) ? 0 : 1);
  names = names
    .filter((n) => n.toLowerCase().startsWith(lower) && (prefix.startsWith('.') || !n.startsWith('.')))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  return {
    path: tildify(dir), exists, parent: dir === '/' ? null : tildify(path.dirname(dir)),
    total: names.length, dirs: names.slice(0, limit).map((n) => `${head}${n}/`),
  };
}

// ---------- instances ----------

const instances = new Map();

function instanceInfo(x) {
  return {
    id: x.id, command: x.command, cmd: x.cmd, cwd: tildify(x.cwd), created: x.created, clients: x.clients.size,
    name: x.name || '', // what the user called it; empty until they rename it
    // What's running now (e.g. cursor-agent inside bash) and where.
    program: x.fg?.name || x.command, where: tildify(x.fg?.cwd || x.cwd),
    scratch: x.scratch, scratchName: path.basename(x.scratch),
  };
}

// Look up what each terminal runs every couple of seconds (and soon after Enter), and tell
// its viewers when it changes.
async function detect(x) {
  const fg = await foreground(x.pty.pid);
  if (!fg || !instances.has(x.id)) return;
  if (fg.name === x.fg?.name && fg.cwd === x.fg?.cwd) return;
  x.fg = fg;
  notifyStatus(x);
}
setInterval(() => { for (const x of instances.values()) detect(x); }, 2000);

function startInstance(command, cwdInput) {
  const spec = loadCommands()[command];
  if (!spec) throw new Error(`Unknown command "${command}"`);
  const cwd = path.resolve(DEFAULT_CWD, expandHome(String(cwdInput || spec.cwd || DEFAULT_CWD)));
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`No such directory: ${tildify(cwd)}`);

  const id = crypto.randomBytes(6).toString('hex');
  const x = {
    id,
    scratch: files.dirFor(command, id),
    command, cmd: spec.cmd, cwd,
    created: Date.now(),
    clients: new Set(),
    active: null,        // client that last typed or resized; it owns the PTY size and its query replies go through
    scrollback: [],      // Buffer chunks, replayed to clients that join later
    scrollbackSize: 0,
    size: { cols: 100, rows: 30 },
  };
  // A login shell, so PATH and friends match a normal terminal (mise, nvm, ~/.local/bin…).
  // No `exec` prefix: it breaks `FOO=1 cmd` and `a; b`, and bash/zsh already exec a lone simple command.
  x.pty = pty.spawn(SHELL, ['-lc', spec.cmd], {
    name: 'xterm-256color', cols: x.size.cols, rows: x.size.rows, cwd, env: childEnv({ REMOTE_TERM_SCRATCH: x.scratch }),
  });
  x.pty.onData((d) => {
    const buf = Buffer.from(d, 'utf8');
    x.scrollback.push(buf);
    x.scrollbackSize += buf.length;
    while (x.scrollbackSize > SCROLLBACK_BYTES && x.scrollback.length > 1) x.scrollbackSize -= x.scrollback.shift().length;
    for (const c of x.clients) if (c.readyState === 1) c.send(buf, { binary: true });
  });
  x.pty.onExit(({ exitCode, signal }) => {
    clearTimeout(x.killTimer);
    clearTimeout(x.detectTimer);
    try { fs.rmdirSync(x.scratch); } catch {} // only if empty: files left there are kept
    instances.delete(x.id);
    const how = signal ? `signal ${signal}` : `code ${exitCode}`;
    console.log(`instance ${x.id} (${command}) exited with ${how}`);
    for (const c of x.clients) c.close(4404, `exited with ${how}`);
  });
  instances.set(x.id, x);
  console.log(`instance ${x.id} started: ${spec.cmd} in ${cwd}`);
  return x;
}

function killInstance(x) {
  x.pty.kill('SIGHUP');
  clearTimeout(x.killTimer);
  x.killTimer = setTimeout(() => { try { x.pty.kill('SIGKILL'); } catch {} }, 3000);
}

function resize(x, cols, rows) {
  if (cols === x.size.cols && rows === x.size.rows) return;
  x.size = { cols, rows };
  try { x.pty.resize(cols, rows); } catch {}
}

function notifyStatus(x) {
  const msg = JSON.stringify({ t: 'status', ...instanceInfo(x) });
  for (const c of x.clients) if (c.readyState === 1) c.send(msg);
}

// ---------- manager ----------

const MANAGER_PORT = Number(process.env.MANAGER_PORT || PORT + 1);

// Type a message into one of our terminals and press Enter (the text first, then Enter a moment
// later, so a TUI treats it as typed input rather than part of a paste).
function sendTo(id, text) {
  const x = instances.get(id);
  if (!x) return { ok: false, error: 'not a terminal of this server' };
  x.pty.write(text);
  setTimeout(() => { if (instances.has(x.id)) { x.pty.write('\r'); clearTimeout(x.detectTimer); x.detectTimer = setTimeout(() => detect(x), 400); } }, 300);
  return { ok: true };
}

function proxy(req, res, port, target) {
  const up = http.request({ host: BIND, port, method: req.method, path: target, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) sendJson(res, 502, { error: 'console unavailable' }); else res.destroy(); });
  res.on('close', () => up.destroy());
  req.pipe(up);
}

const GUIDE = path.join(CONFIG_DIR, 'AGENT_GUIDE.md'); // what agents are told about (see manager "Tell agents")
try { fs.copyFileSync(path.join(ROOT, 'server', 'agent-guide.md'), GUIDE); } catch {}
const consoles = createConsoles(path.join(CONFIG_DIR, 'consoles'), [PORT, MANAGER_PORT]);

const updater = createUpdater({
  root: ROOT, shutdown: (code) => shutdown(code),
  version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
});
let managerHttp;
const manager = createManager(instances, () => managerHttp?.broadcast());
managerHttp = createManagerServer({
  manager, guide: GUIDE, dir: path.join(PUBLIC_DIR, 'manager'), port: MANAGER_PORT, checkRequest, sendTo, readBody,
});

// ---------- http ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const isApi = url.pathname.startsWith('/api/');
  const refused = checkRequest(req, isApi && req.method !== 'GET');
  if (refused) return sendJson(res, 403, { error: refused });

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const commands = Object.entries(loadCommands()).map(([name, s]) => ({ name, cmd: s.cmd, cwd: s.cwd }));
    const list = [...instances.values()].map(instanceInfo).sort((a, b) => a.created - b.created);
    return sendJson(res, 200, { commands, instances: list, defaultCwd: tildify(DEFAULT_CWD), scratchRoot: files.root, consoles: consoles.list(), manager: { running: manager.isRunning() } });
  }

  if (req.method === 'POST' && url.pathname === '/api/instances') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    try { return sendJson(res, 200, instanceInfo(startInstance(body.command, body.cwd))); }
    catch (err) { return sendJson(res, 400, { error: err.message }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/dirs') {
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    try { return sendJson(res, 200, listDirs(url.searchParams.get('q'), limit)); }
    catch { return sendJson(res, 500, { error: 'failed' }); }
  }

  if (url.pathname.startsWith('/api/files')) {
    const rel = url.searchParams.get('path') || '';
    try {
      if (req.method === 'GET' && url.pathname === '/api/files') return sendJson(res, 200, { root: files.root, path: rel, entries: files.list(rel) });
      if (req.method === 'GET' && url.pathname === '/api/files/download') return await files.download(rel, res);
      if (req.method === 'POST' && url.pathname === '/api/files/upload') return sendJson(res, 200, await files.upload(rel, url.searchParams.get('name'), req));
      if (req.method === 'DELETE' && url.pathname === '/api/files') { files.remove(rel); return sendJson(res, 200, { ok: true }); }
    } catch (err) {
      if (res.headersSent) return res.destroy();
      return sendJson(res, err.status || 500, { error: err.status ? err.message : 'failed' });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  // Web consoles: the manager dashboard, and anything other agents registered (see consoles.js).
  // Reached through this server's own address; opening the manager's starts it if needed.
  if (url.pathname === '/manager' || /^\/c\/[\w-]+$/.test(url.pathname)) { res.writeHead(302, { Location: url.pathname + '/' }); return res.end(); }
  if (url.pathname.startsWith('/manager/')) {
    if (url.pathname === '/manager/' && req.method === 'GET' && !manager.isRunning()) manager.start();
    return proxy(req, res, MANAGER_PORT, url.pathname.slice(8) + url.search);
  }
  const cm = url.pathname.match(/^\/c\/([\w-]+)(\/.*)$/);
  if (cm) {
    const port = consoles.port(cm[1]);
    return port ? proxy(req, res, port, cm[2] + url.search) : sendJson(res, 404, { error: 'no such console' });
  }

  // GET: installed vs latest. POST: run the installer, answer, then restart onto the new code.
  if (url.pathname === '/api/update') {
    if (req.method === 'POST') {
      const r = await updater.run();
      if (!r.ok) return sendJson(res, 500, { error: 'Upgrade failed', output: r.output });
      sendJson(res, 200, { ok: true });
      return res.end(() => setTimeout(() => updater.restart(), 300));
    }
    return sendJson(res, 200, await updater.status(url.searchParams.has('force')));
  }

  if (url.pathname === '/api/manager') {
    if (req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      if (body.on === true) manager.start(); else if (body.on === false) manager.stop();
    }
    return sendJson(res, 200, { running: manager.isRunning(), port: MANAGER_PORT });
  }

  const m = url.pathname.match(/^\/api\/instances\/([\w-]+)$/);
  // Rename: { name }. An empty name goes back to showing the program.
  if (req.method === 'PATCH' && m) {
    const x = instances.get(m[1]);
    if (!x) return sendJson(res, 404, { error: 'no such instance' });
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    if (typeof body.name !== 'string') return sendJson(res, 400, { error: 'name must be a string' });
    x.name = body.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60);
    notifyStatus(x);
    return sendJson(res, 200, instanceInfo(x));
  }
  if (req.method === 'DELETE' && m) {
    const x = instances.get(m[1]);
    if (!x) return sendJson(res, 404, { error: 'no such instance' });
    killInstance(x);
    return sendJson(res, 200, { ok: true });
  }

  if (isApi) return sendJson(res, 404, { error: 'not found' });
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  if (url.pathname.startsWith('/vendor/')) return serveFile(res, VENDOR_DIR, url.pathname.slice(8));
  if (url.pathname === '/') return serveFile(res, PUBLIC_DIR, 'index.html');
  return serveFile(res, PUBLIC_DIR, url.pathname);
});

// ---------- websocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const refused = url.pathname === '/ws' ? checkRequest(req, true) : 'not found';
  if (refused) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    onClient(ws, url.searchParams.get('id') || '');
  });
});

function onClient(ws, id) {
  const x = instances.get(id);
  if (!x) return ws.close(4404, 'no such instance');
  x.clients.add(ws);
  if (x.scrollback.length) ws.send(Buffer.concat(x.scrollback), { binary: true });
  notifyStatus(x);

  ws.on('message', (data, isBinary) => {
    if (isBinary || !instances.has(x.id)) return;
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 'in' && typeof msg.d === 'string') {
      // Terminal query replies only count from the active client, and never make it active.
      if (isAutoResponse(msg.d)) {
        if (x.active && x.active !== ws) return;
      } else {
        x.active = ws;
        if (ws.size) resize(x, ws.size.cols, ws.size.rows);
      }
      x.pty.write(msg.d);
      if (msg.d.includes('\r')) { clearTimeout(x.detectTimer); x.detectTimer = setTimeout(() => detect(x), 400); }
    } else if (msg.t === 'resize' && msg.cols > 0 && msg.rows > 0) {
      ws.size = { cols: Math.min(msg.cols | 0, 1000), rows: Math.min(msg.rows | 0, 500) };
      x.active = ws;
      resize(x, ws.size.cols, ws.size.rows);
    }
  });

  ws.on('close', () => {
    x.clients.delete(ws);
    if (x.active === ws) x.active = null;
    notifyStatus(x);
  });
}

// Keep connections alive through proxies / mobile networks.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

// Instances are children of the server; take them down with it.
function shutdown(code = 0) {
  for (const x of instances.values()) try { x.pty.kill('SIGHUP'); } catch {}
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Is remote-terminal-server already running? Pick another with --port.`);
  else console.error(err.message);
  process.exit(1);
});
export const listening = new Promise((resolve) => server.listen(PORT, BIND, () => {
  managerHttp.listen();
  resolve({ port: PORT, configDir: CONFIG_DIR });
}));
