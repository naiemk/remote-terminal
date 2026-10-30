// What the other Claude sessions on this machine are doing, read from ~/.claude without any LLM:
// ~/.claude/sessions/<pid>.json (who is alive, idle or busy) and the tail of each transcript.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = path.join(os.homedir(), '.claude');
const tildify = (p) => (p || '').replace(os.homedir(), '~');

// One `ps` call gives every process's parent; works on Linux and macOS (there is no /proc on macOS).
function parents() {
  const map = new Map();
  try {
    for (const l of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }).split('\n')) {
      const [pid, ppid] = l.trim().split(/\s+/).map(Number);
      if (pid) map.set(pid, ppid);
    }
  } catch {}
  return map;
}

// Is `pid` the process `root`, or one of its descendants?
export function descendsFrom(pid, root, map = parents()) {
  for (let p = pid, i = 0; p > 1 && i < 40; p = map.get(p) || 0, i++) if (p === root) return true;
  return false;
}

function tailLines(file, n = 60, size = 200_000) {
  const fd = fs.openSync(file, 'r');
  try {
    const end = fs.fstatSync(fd).size;
    const start = Math.max(0, end - size);
    const buf = Buffer.alloc(end - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8').split('\n').slice(-n);
  } finally { fs.closeSync(fd); }
}

function findTranscript(sessionId) {
  const dir = path.join(HOME, 'projects');
  try {
    for (const p of fs.readdirSync(dir)) {
      const f = path.join(dir, p, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}

export function activity(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return {};
  let text = '', tool = '', prompt = '';
  for (const l of tailLines(file).reverse()) {
    let d; try { d = JSON.parse(l); } catch { continue; }
    const c = d.message?.content;
    if (d.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && !text) text = b.text;
        if (b.type === 'tool_use' && !tool) tool = b.name;
      }
    }
    if (d.type === 'user' && !prompt) {
      if (typeof c === 'string') prompt = c;
      else if (Array.isArray(c)) prompt = c.find((b) => b.type === 'text')?.text || '';
    }
    if (text && prompt) break;
  }
  return { lastText: text.slice(0, 400), lastTool: tool, lastPrompt: prompt.slice(0, 200), mtime: fs.statSync(file).mtimeMs / 1000 };
}

// A plain-text digest of what the agent said and did since `sinceMs` (or its last `max` entries),
// small enough to hand to a model. `count` is how many entries it holds.
export function digest(sessionId, sinceMs = 0, max = 30) {
  const file = findTranscript(sessionId);
  if (!file) return { text: '', count: 0 };
  const out = [];
  for (const l of tailLines(file, 400, 600_000)) {
    let d; try { d = JSON.parse(l); } catch { continue; }
    if (sinceMs && Date.parse(d.timestamp) < sinceMs) continue;
    const c = d.message?.content;
    if (d.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) out.push(`agent: ${b.text.trim().slice(0, 500)}`);
        else if (b.type === 'tool_use') out.push(`tool: ${b.name} ${JSON.stringify(b.input || {}).slice(0, 120)}`);
      }
    } else if (d.type === 'user' && !sinceMs) {
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b.type === 'text')?.text : '';
      if (t) out.push(`user: ${t.trim().slice(0, 300)}`);
    }
  }
  const last = out.slice(-max);
  return { text: last.join('\n'), count: out.length };
}

// `instances` is the server's Map of terminals; a session started in one of them gets its id
// (`terminal`) so it can be talked to and opened. Others are visible but read-only.
export function snapshot(instances) {
  const sessions = [];
  const procs = parents();
  let files = [];
  try { files = fs.readdirSync(path.join(HOME, 'sessions')).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of files) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', f), 'utf8')); } catch { continue; }
    if (s.kind !== 'interactive' || !s.pid || !procs.has(s.pid)) continue;
    const owner = [...instances.values()].find((x) => descendsFrom(s.pid, x.pty.pid, procs));
    sessions.push({
      id: String(s.sessionId).slice(0, 8), name: s.name || path.basename(s.cwd || '') || String(s.pid),
      status: s.status || 'unknown', cwd: tildify(s.cwd), started: s.startedAt / 1000, updated: (s.updatedAt || 0) / 1000,
      terminal: owner?.id || null, sid: String(s.sessionId), socket: s.messagingSocketPath || '', ...activity(s.sessionId),
    });
  }
  sessions.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return { now: Date.now() / 1000, sessions };
}

// What changed between two snapshots, small enough to hand to a model.
export function diff(prev, cur) {
  const before = new Map((prev?.sessions || []).map((s) => [s.id, s]));
  const changes = [];
  for (const s of cur.sessions) {
    const o = before.get(s.id);
    if (!o) changes.push({ id: s.id, name: s.name, change: 'new', status: s.status, lastText: s.lastText });
    else if (o.status !== s.status || o.lastText !== s.lastText) {
      changes.push({ id: s.id, name: s.name, change: `${o.status} -> ${s.status}`, status: s.status, lastText: s.lastText });
    }
    before.delete(s.id);
  }
  for (const o of before.values()) changes.push({ id: o.id, name: o.name, change: 'ended' });
  return changes;
}
