// Remote Term host: runs a command in a PTY, mirrors it to this terminal,
// and streams it to the server so web clients can watch and type.
//
//   rterm                 # your $SHELL
//   rterm claude          # any command
//   rterm --headless ...  # no local terminal passthrough
//   rterm --name api ...  # label shown in the web session picker
//
// Every rterm is its own session; run as many as you like.
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pty from 'node-pty';
import WebSocket from 'ws';
import { isAutoResponse } from '../shared/input.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parsed: dotenvVars = {} } = dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const args = process.argv.slice(2);
let headless = !process.stdin.isTTY;
let name = process.env.RTERM_NAME || '';
while (args[0]?.startsWith('--')) {
  const flag = args.shift();
  if (flag === '--headless') headless = true;
  else if (flag === '--name') name = args.shift() || '';
  else if (flag.startsWith('--name=')) name = flag.slice(7);
  else if (flag === '--') break;
  else { console.error(`Unknown option ${flag}`); process.exit(2); }
}
const SESSION = crypto.randomBytes(6).toString('hex');

const SERVER = process.env.SERVER_URL || `ws://127.0.0.1:${process.env.PORT || 12700}`;
const { HOST_TOKEN } = process.env;
if (!HOST_TOKEN) { console.error('Missing HOST_TOKEN in .env'); process.exit(1); }

const [cmd, ...cmdArgs] = args.length ? args : [process.env.SHELL || 'bash'];
// The command gets your normal environment, minus what came from .env (PASSWORD, JWT_SECRET,
// HOST_TOKEN…): anything run in the shared terminal shouldn't be able to read the server's secrets.
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(dotenvVars)) delete env[k];
  return env;
}
const localSize = () => ({ cols: process.stdout.columns || 100, rows: process.stdout.rows || 30 });

let size = headless ? { cols: 100, rows: 30 } : localSize();
const term = pty.spawn(cmd, cmdArgs, {
  name: 'xterm-256color',
  cols: size.cols,
  rows: size.rows,
  cwd: process.cwd(),
  env: { ...childEnv(), COLORTERM: 'truecolor', REMOTE_TERM: '1' },
});

// Whoever typed (or resized) last owns the PTY size, so the active screen renders correctly.
let owner = headless ? 'remote' : 'local';
let remoteSize = null;
let ws = null;

function input(src, d) {
  if (isAutoResponse(d)) {
    // Query replies: only the owner's go through, and they never flip ownership.
    if (src === owner) term.write(d);
    return;
  }
  owner = src;
  resize(src === 'local' ? localSize() : remoteSize);
  term.write(d);
}

function resize(next) {
  if (!next || (next.cols === size.cols && next.rows === size.rows)) return;
  size = next;
  term.resize(size.cols, size.rows);
  send({ t: 'size', ...size });
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

// ---------- local terminal ----------

term.onData((d) => {
  if (!headless) process.stdout.write(d);
  if (ws?.readyState === WebSocket.OPEN) ws.send(Buffer.from(d, 'utf8'), { binary: true });
});

term.onExit(({ exitCode }) => {
  if (!headless) process.stdin.setRawMode(false);
  const done = () => process.exit(exitCode ?? 0);
  if (ws?.readyState !== WebSocket.OPEN) return done();
  // Tell the server the session is over (not just a dropped link), and let the frames flush.
  send({ t: 'exit' });
  ws.once('close', done);
  ws.close(1000, 'exited');
  setTimeout(done, 500);
});

if (!headless) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => input('local', d.toString('utf8')));
  process.stdout.on('resize', () => { owner = 'local'; resize(localSize()); });
}

// ---------- server link ----------

let retry = 500;
function connect() {
  ws = new WebSocket(`${SERVER}/ws/host?token=${encodeURIComponent(HOST_TOKEN)}&session=${SESSION}`);

  ws.on('open', () => {
    retry = 500;
    send({ t: 'hello', name, hostname: os.hostname(), cmd: [cmd, ...cmdArgs].join(' '), cwd: process.cwd(), ...size });
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 'in') {
      input('remote', msg.d);
    } else if (msg.t === 'resize') {
      remoteSize = { cols: msg.cols, rows: msg.rows };
      owner = 'remote';
      resize(remoteSize);
    }
  });

  ws.on('close', (code) => {
    if (code === 4000) { if (headless) console.error('Replaced by another host.'); return; }
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10_000);
  });
  ws.on('error', () => {}); // close follows; reconnect handled there
}
connect();
