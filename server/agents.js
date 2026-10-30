// Per-agent chat for the manager dashboard: send an agent a message, watch it work, and end with
// one summary. Agents started in this server's terminals get the text typed into their terminal;
// any other session gets it through Claude's own peer messaging (a headless Claude with only the
// SendMessage tool, addressed to the session's socket).
import { spawn } from 'node:child_process';
import os from 'node:os';
import { snapshot, digest } from './fleet.js';
import { askHaiku } from './haiku.js';

const TICK_MS = 3000;
const PROGRESS_MS = 40_000;   // at most one progress note per agent per this long
const PICKUP_MS = 90_000;     // idle this long after sending and never started: say so
const GIVE_UP_MS = 20 * 60_000;
const MAX_MSGS = 60;

const SUMMARY_SYSTEM = `You report on a Claude Code agent for someone reading on a phone. Plain text, no markdown,
at most 3 short sentences. Say what it did or is doing, and anything it needs from the person. Never invent anything.`;

const sockOk = (p) => /^\/[\w@.+\/-]+\.sock$/.test(p || '');

export function createAgents({ instances, sendTo, emit }) {
  const chats = new Map(); // session id -> { msgs, pending, summary }
  let timer = null, seq = 0;

  const chat = (id) => {
    if (!chats.has(id)) chats.set(id, { msgs: [], pending: null, summary: { text: '', for: 0, busy: false } });
    return chats.get(id);
  };
  const add = (c, who, text, extra = {}) => {
    const m = { n: ++seq, who, text: String(text).slice(0, 1500), t: Date.now(), ...extra };
    c.msgs.push(m);
    if (c.msgs.length > MAX_MSGS) c.msgs.splice(0, c.msgs.length - MAX_MSGS);
    return m;
  };
  const find = (id) => snapshot(instances).sessions.find((s) => s.id === id);

  function deliverPeer(s, text) {
    return new Promise((resolve) => {
      if (!sockOk(s.socket)) return resolve({ ok: false, error: 'this session has no message socket' });
      const msg = `From the Remote Terminal manager (the person is writing from their phone): ${text}`;
      const p = spawn('claude', ['-p', '--model', 'haiku', '--no-session-persistence', '--allowedTools', 'SendMessage'],
        { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const kill = setTimeout(() => p.kill(), 60_000);
      p.on('error', (e) => { clearTimeout(kill); resolve({ ok: false, error: e.message }); });
      p.on('close', (code) => {
        clearTimeout(kill);
        resolve(code === 0 && /sent/i.test(out) ? { ok: true } : { ok: false, error: out.trim().slice(0, 200) || `exit ${code}` });
      });
      p.stdin.end(`Use the SendMessage tool exactly once with to=${JSON.stringify('uds:' + s.socket)} and message=${JSON.stringify(msg)}. Then reply with only the tool result.`);
    });
  }

  async function send(id, text) {
    text = String(text || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 2000);
    const s = find(id);
    if (!s || !text) return { ok: false, error: s ? 'empty message' : 'no such agent' };
    const c = chat(id);
    if (c.pending) return { ok: false, error: 'wait for the agent to finish the last message' };
    const m = add(c, 'you', text, { state: 'sending' });
    c.pending = { since: Date.now(), sawBusy: s.status === 'busy', idle: 0, lastNote: 0, lastDigest: '', noted: new Set(), busy: false };
    emit();
    const r = s.terminal ? sendTo(s.terminal, text) : await deliverPeer(s, text);
    if (!r.ok) {
      m.state = 'failed'; add(c, 'note', `Could not reach the agent: ${r.error}`); c.pending = null;
    } else m.state = 'delivered';
    emit();
    return r;
  }

  async function summarize(c, id, prompt) {
    try { return (await askHaiku(SUMMARY_SYSTEM, prompt)).trim().slice(0, 700); } catch { return ''; }
  }

  // The blob at the top of an agent's page; refreshed when the transcript has moved on.
  async function refreshSummary(id) {
    const s = find(id), c = chat(id);
    if (!s || c.summary.busy || (c.summary.for && c.summary.for >= (s.mtime || 0)) || c.pending) return;
    const d = digest(s.sid);
    if (!d.count) { c.summary = { text: '', for: s.mtime || 0, busy: false }; return emit(); }
    c.summary.busy = true; emit();
    const text = await summarize(c, id, `Agent "${s.name}" (${s.status}) in ${s.cwd}. Recent activity:\n${d.text}\n\nSummarize where things stand.`);
    c.summary = { text: text || s.lastText || '', for: s.mtime || 0, busy: false };
    emit();
  }

  async function note(c, id, s) {
    const p = c.pending;
    const d = digest(s.sid, p.since);
    if (!d.count || d.text === p.lastDigest) return;
    p.lastDigest = d.text; p.lastNote = Date.now(); p.busy = true;
    const text = await summarize(c, id, `The person asked agent "${s.name}": "${c.msgs.findLast((m) => m.who === 'you')?.text}"\nSince then:\n${d.text}\n\nIn one short sentence, what is it doing right now?`);
    p.busy = false;
    if (c.pending === p && text) { add(c, 'progress', text); emit(); }
  }

  async function finish(c, id, s, why) {
    const p = c.pending;
    if (!p || p.finishing) return;
    p.finishing = true;
    let text = why;
    if (!why) {
      const d = digest(s.sid, p.since);
      text = (await summarize(c, id, `The person asked agent "${s.name}": "${c.msgs.findLast((m) => m.who === 'you')?.text}"\nWhat it did:\n${d.text}\n\nGive the final outcome: what was done, and anything the person must do next.`)) || s.lastText || 'Done.';
    }
    c.msgs = c.msgs.filter((m) => m.who !== 'progress'); // the little progress notes give way to one summary
    add(c, why ? 'note' : 'summary', text);
    c.pending = null;
    c.summary.for = 0; // the top blob is stale now
    emit();
    refreshSummary(id);
  }

  async function tick() {
    const waiting = [...chats].filter(([, c]) => c.pending);
    if (!waiting.length) { clearInterval(timer); timer = null; return; }
    const sessions = snapshot(instances).sessions;
    for (const [id, c] of waiting) {
      const p = c.pending, s = sessions.find((x) => x.id === id), age = Date.now() - p.since;
      if (!s) { finish(c, id, null, 'This agent ended.'); continue; }
      if (s.status === 'busy') { p.sawBusy = true; p.idle = 0; }
      else if (s.status === 'waiting') {
        p.sawBusy = true; p.idle = 0;
        if (!p.noted.has('waiting')) { p.noted.add('waiting'); add(c, 'progress', 'The agent is waiting for an answer or an approval.'); emit(); }
      } else if (p.sawBusy || (s.mtime || 0) * 1000 > p.since) p.idle++;
      if (p.idle >= 2) { finish(c, id, s); continue; }
      if (s.status !== 'busy' && !p.sawBusy && age > PICKUP_MS) { finish(c, id, s, 'The message was delivered, but the agent has not acted on it yet. It may be waiting on something else.'); continue; }
      if (age > GIVE_UP_MS) { finish(c, id, s, 'Stopped waiting after 20 minutes. The agent may still be working.'); continue; }
      if (s.status === 'busy' && !p.busy && Date.now() - p.lastNote > PROGRESS_MS) note(c, id, s);
    }
    emit();
  }

  const watch = () => { timer ||= setInterval(tick, TICK_MS); };

  return {
    async send(id, text) { const r = await send(id, text); if (chats.get(id)?.pending) watch(); return r; },
    open: refreshSummary,
    view() {
      const o = {};
      for (const [id, c] of chats) o[id] = { msgs: c.msgs, pending: !!c.pending, summary: c.summary.text, summarizing: c.summary.busy };
      return o;
    },
  };
}
