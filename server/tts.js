// Turns the spoken summary into audio with Piper (free, offline, neural), when it is installed
// (scripts/install-piper.sh). Audio files play in an <audio> tag, which keeps going with the phone locked;
// the browser's own speech synthesis stops as soon as the screen locks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const DIR = process.env.PIPER_DIR || path.join(os.homedir(), '.local', 'share', 'remote-terminal', 'piper');
const BIN = path.join(DIR, 'piper', 'piper');
const model = () => { try { return fs.readdirSync(DIR).filter((f) => f.endsWith('.onnx')).sort().map((f) => path.join(DIR, f))[0] || ''; } catch { return ''; } };

export function createTts() {
  const clips = new Map(); // id -> Buffer (wav), newest last
  const available = () => fs.existsSync(BIN) && !!model();

  function synth(text) {
    return new Promise((resolve, reject) => {
      const out = path.join(os.tmpdir(), `rt-tts-${crypto.randomUUID()}.wav`);
      const p = spawn(BIN, ['-m', model(), '-f', out, '-q'], { cwd: path.dirname(BIN), stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => p.kill('SIGKILL'), 120_000);
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        try { const b = fs.readFileSync(out); fs.rmSync(out, { force: true }); code === 0 && b.length ? resolve(b) : reject(new Error('voice synthesis failed')); }
        catch { reject(new Error('voice synthesis failed')); }
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
      return `api/tts/${id}.wav`;
    } catch { return null; }
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
