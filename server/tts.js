// Turns the spoken summary into audio with Piper (free, offline, neural), when it is installed
// (installed automatically in the background by ensure()). Audio files play in an <audio> tag, which keeps going with the phone locked;
// the browser's own speech synthesis stops as soon as the screen locks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const DIR = process.env.PIPER_DIR || path.join(os.homedir(), '.local', 'share', 'remote-terminal', 'piper');
const BIN = path.join(DIR, 'piper', 'piper');
const model = () => { try { return fs.readdirSync(DIR).filter((f) => f.endsWith('.onnx')).sort().map((f) => path.join(DIR, f))[0] || ''; } catch { return ''; } };

const REL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/';
const VOICE = 'en_US-lessac-medium';
const VOICE_URL = `https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/${VOICE}`;
const ARCHIVES = { 'linux-x64': 'piper_linux_x86_64.tar.gz', 'linux-arm64': 'piper_linux_aarch64.tar.gz', 'darwin-x64': 'piper_macos_x64.tar.gz', 'darwin-arm64': 'piper_macos_aarch64.tar.gz' };
let installing = null;
const st = { state: 'unknown', error: '' }; // installing | failed | unsupported | ready (see status())

async function get(url, file) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

// Downloads Piper and a voice (~110 MB) into DIR if they are missing. Best effort, once per process, in the
// background: until it finishes (or if it fails, e.g. offline or an unsupported platform) the page speaks with
// the browser's own voice. Built in a temp folder and moved into place, so a half download never counts.
export function ensure(log = () => {}) {
  if (fs.existsSync(BIN) && model()) return Promise.resolve(true);
  const archive = ARCHIVES[`${process.platform}-${process.arch}`];
  if (!archive) { st.state = 'unsupported'; log(`Piper voice: no build for ${process.platform}-${process.arch}`); return Promise.resolve(false); }
  st.state = 'installing'; st.error = '';
  installing ||= (async () => {
    const tmp = `${DIR}.part-${process.pid}-${Date.now()}`;
    try {
      log('Installing the Piper voice in the background (~110 MB)…');
      fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
      await get(REL + archive, path.join(tmp, 'piper.tgz'));
      await new Promise((res, rej) => { const t = spawn('tar', ['xzf', 'piper.tgz'], { cwd: tmp, stdio: 'ignore' }); t.on('error', rej); t.on('close', (c) => (c === 0 ? res() : rej(new Error('could not unpack Piper')))); });
      fs.rmSync(path.join(tmp, 'piper.tgz'));
      await get(`${VOICE_URL}.onnx`, path.join(tmp, `${VOICE}.onnx`));
      await get(`${VOICE_URL}.onnx.json`, path.join(tmp, `${VOICE}.onnx.json`));
      fs.chmodSync(path.join(tmp, 'piper', 'piper'), 0o755);
      fs.rmSync(DIR, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(DIR), { recursive: true });
      fs.renameSync(tmp, DIR);
      log('Piper voice installed.'); st.state = 'ready';
      return true;
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      st.state = 'failed'; st.error = String(e.message).slice(0, 200);
      log(`Piper voice install failed (will retry next start): ${e.message}`);
      return false;
    } finally { installing = null; }
  })();
  return installing;
}

export const status = () => (fs.existsSync(BIN) && model() ? (st.synthError ? { state: 'broken', error: st.synthError } : { state: 'ready', error: '' }) : { ...st });

export function createTts() {
  ensure((m) => console.log(m));
  const clips = new Map(); // id -> Buffer (wav), newest last
  const available = () => fs.existsSync(BIN) && !!model();

  function synth(text) {
    return new Promise((resolve, reject) => {
      const out = path.join(os.tmpdir(), `rt-tts-${crypto.randomUUID()}.wav`);
      const p = spawn(BIN, ['-m', model(), '-f', out, '-q'], { cwd: path.dirname(BIN), env: { ...process.env, DYLD_LIBRARY_PATH: path.dirname(BIN) + (process.env.DYLD_LIBRARY_PATH ? ':' + process.env.DYLD_LIBRARY_PATH : ''), LD_LIBRARY_PATH: path.dirname(BIN) + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '') }, stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err = (err + d).slice(-300); });
      const timer = setTimeout(() => p.kill('SIGKILL'), 120_000);
      p.on('error', (e) => { clearTimeout(timer); reject(e); }); // e.g. EACCES / bad CPU type
      p.on('close', (code) => {
        clearTimeout(timer);
        try { const b = fs.readFileSync(out); fs.rmSync(out, { force: true }); code === 0 && b.length ? resolve(b) : reject(new Error(err.trim().split('\n').pop() || `piper exited with code ${code}`)); }
        catch { reject(new Error(err.trim().split('\n').pop() || 'voice synthesis failed')); }
      });
      p.stdin.end(text.replace(/\s+/g, ' '));
    });
  }

  // Returns a relative URL for the audio, or null when Piper is not installed or fails (the page then talks itself).
  async function clip(text) {
    if (!available()) return null;
    try {
      const id = crypto.randomUUID();
      clips.set(id, await synth(text));
      while (clips.size > 6) clips.delete(clips.keys().next().value);
      st.synthError = '';
      return `api/tts/${id}.wav`;
    } catch (e) { st.synthError = String(e.message).slice(0, 200); return null; }
  }

  // GET /api/tts/<id>.wav, with Range support (iOS will not play audio without it).
  function serve(req, res, name) {
    const buf = clips.get(name.replace(/\.wav$/, ''));
    if (!buf) { res.writeHead(404); return res.end(); }
    const h = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { ...h, 'Content-Length': buf.length }); return res.end(buf); }
    let a = m[1] === '' ? Math.max(0, buf.length - Number(m[2])) : Number(m[1]);
    let b = m[1] === '' || m[2] === '' ? buf.length - 1 : Math.min(Number(m[2]), buf.length - 1);
    if (a > b || a >= buf.length) { res.writeHead(416, { 'Content-Range': `bytes */${buf.length}` }); return res.end(); }
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${b}/${buf.length}`, 'Content-Length': b - a + 1 });
    res.end(buf.subarray(a, b + 1));
  }
  return { available, clip, serve };
}
