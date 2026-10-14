// Remote Term server: serves the web client, issues JWTs, and relays
// a single terminal session between the local host process and web clients.
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { isAutoResponse } from '../shared/input.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR_DIR = path.join(ROOT, 'node_modules', '@xterm');

const PORT = Number(process.env.PORT || 12700);
// Loopback only, on purpose: the server is reached exclusively through `tailscale serve`,
// never directly from the LAN or the internet. Not configurable.
const BIND = '127.0.0.1';
if (process.env.BIND && process.env.BIND !== BIND) {
  console.warn(`Ignoring BIND=${process.env.BIND}: remote-term only listens on ${BIND} (expose it with tailscale serve).`);
}
const { PASSWORD, JWT_SECRET, HOST_TOKEN } = process.env;
const TOKEN_TTL = process.env.TOKEN_TTL || '30d';
const SCROLLBACK_BYTES = 512 * 1024;

for (const [k, v] of Object.entries({ PASSWORD, JWT_SECRET, HOST_TOKEN })) {
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

// ---------- helpers ----------

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

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
    });
    fs.createReadStream(file).pipe(res);
  });
}

// Naive per-IP brute-force protection: 5 failures => locked for a minute.
const failures = new Map();
function isLocked(ip) {
  const f = failures.get(ip);
  return f && f.count >= 5 && Date.now() - f.last < 60_000;
}
function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, last: 0 };
  if (Date.now() - f.last > 60_000) f.count = 0;
  f.count++; f.last = Date.now();
  failures.set(ip, f);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------- http ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const ip = req.socket.remoteAddress;
    if (isLocked(ip)) return sendJson(res, 429, { error: 'Too many attempts. Wait a minute.' });
    let password = '';
    try { password = JSON.parse(await readBody(req)).password || ''; } catch {}
    if (!safeEqual(password, PASSWORD)) {
      recordFailure(ip);
      await new Promise((r) => setTimeout(r, 400));
      return sendJson(res, 401, { error: 'Wrong password' });
    }
    failures.delete(ip);
    const token = jwt.sign({ sub: 'remote-term' }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    return sendJson(res, 200, { token });
  }

  if (req.method === 'GET' && (url.pathname === '/api/me' || url.pathname === '/api/sessions')) {
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    try { jwt.verify(bearer, JWT_SECRET); } catch { return sendJson(res, 401, { error: 'unauthorized' }); }
    if (url.pathname === '/api/me') return sendJson(res, 200, { ok: true });
    return sendJson(res, 200, { sessions: [...sessions.values()].map(sessionInfo).sort((x, y) => x.created - y.created) });
  }

  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  if (url.pathname.startsWith('/vendor/')) return serveFile(res, VENDOR_DIR, url.pathname.slice(8));
  if (url.pathname === '/') return serveFile(res, PUBLIC_DIR, 'index.html');
  return serveFile(res, PUBLIC_DIR, url.pathname);
});

// ---------- session relay ----------

// One session per rterm process, keyed by the id the host picks at startup. A host that drops
// (network blip, server restart) reconnects with the same id and picks its session back up;
// one that exits cleanly ends it. Sessions whose host never comes back are dropped after a while.
const ORPHAN_TTL = 10 * 60_000;
const sessions = new Map();

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      host: null,          // ws of the host process
      meta: null,          // { name, hostname, cmd, cwd, cols, rows }
      clients: new Set(),
      active: null,        // client that last typed or resized; only its query replies are forwarded
      scrollback: [],      // Buffer chunks
      scrollbackSize: 0,
      created: Date.now(),
      orphanTimer: null,
    };
    sessions.set(id, s);
  }
  return s;
}

function sessionInfo(s) {
  const { name, hostname, cmd, cwd } = s.meta || {};
  return { id: s.id, name, hostname, cmd, cwd, host: !!s.host, clients: s.clients.size, created: s.created };
}

function endSession(s, reason) {
  clearTimeout(s.orphanTimer);
  sessions.delete(s.id);
  for (const c of s.clients) c.close(4404, reason);
  console.log(`session ${s.id} ended (${reason})`);
}

function pushScrollback(s, buf) {
  s.scrollback.push(buf);
  s.scrollbackSize += buf.length;
  while (s.scrollbackSize > SCROLLBACK_BYTES && s.scrollback.length > 1) {
    s.scrollbackSize -= s.scrollback.shift().length;
  }
}

function broadcast(s, msg, binary = false) {
  for (const c of s.clients) if (c.readyState === 1) c.send(msg, { binary });
}

function statusMsg(s) {
  return JSON.stringify({ t: 'status', id: s.id, host: !!s.host, meta: s.meta, clients: s.clients.size });
}

function notifyStatus(s) {
  broadcast(s, statusMsg(s));
  if (s.host?.readyState === 1) {
    s.host.send(JSON.stringify({ t: 'clients', n: s.clients.size }));
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const SESSION_ID = /^[\w-]{4,64}$/;

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token') || '';
  const id = url.searchParams.get('session') || (url.pathname === '/ws/host' ? 'default' : ''); // pre-multi-session rterm
  let role = null;

  if (url.pathname === '/ws/host' && safeEqual(token, HOST_TOKEN) && SESSION_ID.test(id)) role = 'host';
  if (url.pathname === '/ws/client') {
    try { jwt.verify(token, JWT_SECRET); role = 'client'; } catch {}
  }
  if (!role) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    role === 'host' ? onHost(ws, id) : onClient(ws, id);
  });
});

function onHost(ws, id) {
  const s = getSession(id);
  clearTimeout(s.orphanTimer);
  if (s.host) s.host.close(4000, 'replaced by a new host');
  s.host = ws;
  // The host replays nothing on reconnect, so start viewers from a clean screen.
  s.scrollback = [];
  s.scrollbackSize = 0;
  broadcast(s, JSON.stringify({ t: 'reset' }));
  console.log(`host connected (session ${id})`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      pushScrollback(s, data);
      return broadcast(s, data, true);
    }
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 'hello' || msg.t === 'size') {
      s.meta = { ...s.meta, ...msg, t: undefined };
      notifyStatus(s);
    } else if (msg.t === 'exit') {
      s.exited = true;
    }
  });

  ws.on('close', (code) => {
    if (s.host !== ws) return;
    s.host = null;
    if (s.exited || code === 1000) return endSession(s, 'exited');
    console.log(`host disconnected (session ${id})`);
    s.orphanTimer = setTimeout(() => endSession(s, 'host gone'), ORPHAN_TTL);
    notifyStatus(s);
  });
  notifyStatus(s);
}

function onClient(ws, id) {
  const s = sessions.get(id);
  if (!s) return ws.close(4404, 'no such session');
  s.clients.add(ws);
  console.log(`client connected (session ${id}, ${s.clients.size})`);
  ws.send(statusMsg(s));
  if (s.scrollback.length) ws.send(Buffer.concat(s.scrollback), { binary: true });

  ws.on('message', (data, isBinary) => {
    if (isBinary || s.host?.readyState !== 1) return;
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 'in' && typeof msg.d === 'string') {
      if (isAutoResponse(msg.d)) {
        if (s.active && s.active !== ws) return;
      } else {
        s.active = ws;
      }
      s.host.send(JSON.stringify({ t: 'in', d: msg.d }));
    } else if (msg.t === 'resize' && msg.cols > 0 && msg.rows > 0) {
      s.active = ws;
      s.host.send(JSON.stringify({ t: 'resize', cols: msg.cols | 0, rows: msg.rows | 0 }));
    }
  });

  ws.on('close', () => {
    s.clients.delete(ws);
    if (s.active === ws) s.active = null;
    console.log(`client disconnected (session ${id}, ${s.clients.size})`);
    notifyStatus(s);
  });
  notifyStatus(s);
}

// Keep connections alive through proxies / mobile networks.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

server.listen(PORT, BIND, () => console.log(`remote-term server on http://${BIND}:${PORT}`));
