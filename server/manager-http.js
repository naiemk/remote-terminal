// The dashboard: its own listener on 127.0.0.1 (so `tailscale serve` can publish it), speaking
// AG-UI style server-sent events. Same host/origin checks as the main server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export function createManagerServer({ manager, guide, dir, port, checkRequest, sendTo, readBody }) {
  const clients = new Set();
  const ev = (res, e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const view = () => ({ running: manager.isRunning(), fleet: manager.fleet(), summary: manager.state.summary, ui: manager.state.ui, error: manager.state.error, runs: manager.state.usage.runs, busy: manager.state.busy, log: manager.state.log });

  const broadcast = () => { const s = view(); for (const r of clients) ev(r, { type: 'STATE_SNAPSHOT', snapshot: s }); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const post = req.method === 'POST';
    const refused = checkRequest(req, post);
    if (refused) { res.writeHead(403); return res.end(refused); }

    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      ev(res, { type: 'RUN_STARTED', threadId: crypto.randomUUID(), runId: crypto.randomUUID() });
      ev(res, { type: 'STATE_SNAPSHOT', snapshot: view() });
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (post && url.pathname === '/api/act') {
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch {}
      const t = String(b.args?.terminal || '');
      const text = String(b.text || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 2000);
      let result = { ok: true };
      if ((b.action === 'ask_agent' || b.action === 'answer') && text) {
        result = sendTo(t, text);
        const name = manager.fleet().sessions.find((x) => x.terminal === t)?.name || t;
        manager.note(result.ok ? 'sent' : 'manager', result.ok ? `To ${name}: ${text}` : `Could not reach ${name}: ${result.error}`);
        manager.poll();
      }
      else if (b.action === 'inform_agents') {
        // Only idle agents inside our terminals: typing into a busy or waiting one would mangle its prompt.
        const idle = manager.fleet().sessions.filter((s) => s.terminal && s.status === 'idle');
        for (const s of idle) sendTo(s.terminal, `FYI: Remote Terminal can list web consoles you host and lets a manager agent reach you. Read ${guide} for how. No reply needed.`);
        result = { ok: true, told: idle.length };
      } else if (b.action === 'refresh') manager.poll();
      else if (b.action === 'message' && text) manager.message(text);
      else if (b.action === 'start') manager.start();
      else if (b.action === 'stop') manager.stop();
      else if (b.action !== 'open_console') result = { ok: false, error: 'unknown action' };
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(dir, rel);
    if (!file.startsWith(dir + path.sep) || !MIME[path.extname(file)] || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] });
    fs.createReadStream(file).pipe(res);
  });

  server.on('error', (e) => console.error(`Manager dashboard: ${e.code === 'EADDRINUSE' ? `port ${port} is in use` : e.message}`));
  return { broadcast, listen: () => server.listen(port, '127.0.0.1') };
}
