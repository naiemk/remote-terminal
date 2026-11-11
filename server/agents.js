// Per-agent chat for the manager dashboard: send an agent a message, watch it work, and end with
// one summary. Agents started in this server's terminals get the text typed into their terminal;
// any other session gets it through Claude's own peer messaging (a headless Claude with only the
// SendMessage tool, addressed to the session's socket).
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import { snapshot, digest, projectContext } from './fleet.js';
import { askHaiku } from './haiku.js';

const TICK_MS = 3000;
const PROGRESS_MS = 40_000;   // at most one progress note per agent per this long
const PICKUP_MS = 90_000;     // idle this long after sending and never started: say so
const GIVE_UP_MS = 20 * 60_000;
const MAX_MSGS = 60;

const SUMMARY_SYSTEM = `You report on a Claude Code agent for someone reading on a phone. Plain text, no markdown,
at most 3 short sentences. Say what it did or is doing, and anything it needs from the person. Never invent anything.`;

// Haiku words its result differently each time ("DELIVERED", "The message was delivered...", "sent"),
// so judge by meaning: a clear failure word loses, otherwise a delivery word wins.
const delivered = (t) => !/\b(FAILED|fail(ed|ure)?|unable|could not|couldn't|cannot|can't|error|denied|refused|not (been )?(sent|delivered))\b/i.test(t) && /\b(DELIVERED|sent|inbox|queued)\b/i.test(t);
// Only an explicit failure is safe to retry; a timeout or odd reply may have sent it already, and a retry would duplicate.
const failedBeforeSend = (t, code) => /\bFAILED\b/.test(t) || (code !== 0 && !t);

const BRIEF_SYSTEM = `You are the project manager for one Claude Code agent. The person runs several agents and forgets what each is
doing, so you tell them, in full and concretely. You get its working directory, project files, git state and recent
activity. You may also have read-only tools (Read, Glob, Grep) in the project: when the agent is idle or its next step is unclear,
spend them to understand the project (README, docs, roadmap/TODO, source layout, open work) before answering.
Reply with ONE JSON object and nothing else (plain text values, no markdown):
{"title": "a short name for this piece of work, 3-8 words",
 "project": "what the project is and the bigger goal, 1-2 sentences",
 "kind": "feature" | "app" | "research" | "bugfix" | "ops" | "other",
 "task": "the current job or task: what is being done right now and why, 2-5 sentences, enough that someone who forgot can pick it back up",
 "chat": "summary of the latest conversation with the person: what they asked, what the agent answered or did, what was left open, 2-5 sentences",
 "state": "where things stand: done, in progress, untested, what remains. 3-6 sentences",
 "blocker": "what blocks it and how to resolve it, or empty string if nothing is blocked",
 "next": [{"label": "3-6 words", "prompt": "the exact instruction to send this agent, 1-3 sentences, written to the agent, specific enough to act on"}, x3]}
"next" has EXACTLY 3 distinct options, the most valuable first (the person adds their own as a 4th). If the agent is idle or done:
propose what to build or fix next in this project, drawn from its roadmap, gaps and what the work just done makes possible
(next feature, tests, PR, docs, cleanup, a new capability). If it is mid-task: finish or verify it, then the natural follow-up.
If blocked: a way to unblock, and work that is not blocked. Be concrete to THIS project; never invent facts, files or results.`;

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

  // One attempt: a headless Haiku calls SendMessage once. It must answer DELIVERED or FAILED: <why>;
  // anything else (a refusal, chatter, a timeout) counts as a failure so we can retry.
  function peerOnce(socket, text) {
    return new Promise((resolve) => {
      const msg = `From the Remote Terminal manager (the person is writing from their phone): ${text}`;
      // SendMessage may be a deferred tool, so ToolSearch has to be allowed to load it.
      const p = spawn('claude', ['-p', '--model', 'haiku', '--no-session-persistence', '--allowedTools', 'SendMessage,ToolSearch'],
        { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', done = false;
      const end = (r) => { if (done) return; done = true; clearTimeout(kill); resolve(r); };
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const kill = setTimeout(() => { p.kill('SIGKILL'); end({ ok: false, error: 'timed out; the message may have been delivered, check the agent', retry: false }); }, 60_000);
      p.on('error', (e) => end({ ok: false, error: e.code === 'ENOENT' ? 'the claude command was not found' : e.message }));
      p.on('close', (code) => {
        const t = out.trim();
        if (code === 0 && delivered(t)) end({ ok: true });
        else end({ ok: false, error: t.slice(0, 200) || `exit ${code}`, retry: failedBeforeSend(t, code) });
      });
      p.stdin.on('error', () => {});
      p.stdin.end(`Send one message to another Claude session.
1. If the SendMessage tool is not available yet, load it with ToolSearch query "select:SendMessage".
2. Call SendMessage exactly once with to=${JSON.stringify('uds:' + socket)} and message=${JSON.stringify(msg)}.
3. If the tool result says the message was sent or delivered, reply with exactly: DELIVERED
   Otherwise reply with exactly: FAILED: <the reason in a few words>
Never call SendMessage a second time. Reply with nothing else.`);
    });
  }

  // Retried, because a model-driven send fails now and then for no lasting reason. A stale socket is
  // not retried: the session is gone. The socket is re-read each time in case the session restarted.
  async function deliverPeer(s, text) {
    let err = 'unknown error';
    for (let i = 0; i < 3; i++) {
      const cur = i ? find(s.id) : s;
      if (!cur) return { ok: false, error: 'this agent ended' };
      if (!sockOk(cur.socket)) return { ok: false, error: 'this session has no message socket' };
      if (!fs.existsSync(cur.socket)) return { ok: false, error: 'the session\'s message socket is gone; it may have exited' };
      const r = await peerOnce(cur.socket, text);
      if (r.ok) return r;
      err = r.error;
      if (!r.retry) break;
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
    return { ok: false, error: err };
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
    let r;
    try { r = s.terminal ? sendTo(s.terminal, text) : await deliverPeer(s, text); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) {
      m.state = 'failed'; add(c, 'note', `Could not reach the agent: ${r.error}`); c.pending = null;
    } else m.state = 'delivered';
    emit();
    return r;
  }

  async function summarize(c, id, prompt) {
    try { return (await askHaiku(SUMMARY_SYSTEM, prompt)).trim().slice(0, 700); } catch { return ''; }
  }

  // The brief at the top of an agent's page: where it stands, the project behind it, any blocker, and
  // three suggested next moves; refreshed when the transcript has moved on.
  async function brief(s) {
    const d = digest(s.sid);
    const prompt = `Agent "${s.name}" (${s.status}) in ${s.cwd}\n\nPROJECT\n${projectContext(s.cwd)}\n\nRECENT ACTIVITY\n${d.text}`;
    let lastErr;
    for (let i = 0; i < 2; i++) {
      try {
        // Idle agents get a real look at the project; busy ones are summarised from their transcript alone.
        const out = await (s.status === 'idle' && s.cwd
          ? askHaiku(BRIEF_SYSTEM, prompt, 'sonnet', 240_000, { cwd: s.cwd.replace(/^~/, os.homedir()), tools: ['Read', 'Glob', 'Grep'] })
          : askHaiku(BRIEF_SYSTEM, prompt));
        const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
        const next = (Array.isArray(j.next) ? j.next : []).map((n) => ({ label: String(n?.label || '').slice(0, 60), prompt: String(n?.prompt || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 600) }))
          .filter((n) => n.label && n.prompt).slice(0, 3);
        if (!next.length && !j.state) throw new Error('empty brief');
        const f = (v, n) => String(v || '').slice(0, n);
        return { title: f(j.title, 100), project: f(j.project, 500), kind: f(j.kind || 'other', 20), task: f(j.task, 1200), chat: f(j.chat, 1200), text: f(j.state, 1500), blocker: String(j.blocker || '').slice(0, 400), next };
      } catch (e) { lastErr = e; }
    }
    return { text: '', error: lastErr?.message || 'failed' };
  }

  async function refreshSummary(id) {
    const s = find(id), c = chat(id);
    if (!s || c.summary.busy || (c.summary.for && c.summary.for >= (s.mtime || 0)) || c.pending) return;
    const d = digest(s.sid);
    if (!d.count) { c.summary = { text: '', for: s.mtime || 0, busy: false }; return emit(); }
    c.summary.busy = true; emit();
    const b = await brief(s);
    // keep the old brief if this one failed; retry next time the page is opened
    c.summary = b.error ? { ...c.summary, text: c.summary.text || s.lastText || '', for: 0, busy: false, error: b.error } : { ...b, for: s.mtime || 0, busy: false };
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

  // Keep every session's brief fresh in the background, two at a time, so the board is ready when opened.
  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const todo = snapshot(instances).sessions.filter((s) => {
        const c = chat(s.id).summary;
        return !c.busy && !(c.for && c.for >= (s.mtime || 0)) && !(c.error && Date.now() - (c.failedAt || 0) < 300_000);
      });
      const lane = async () => { for (let s; (s = todo.shift());) { await refreshSummary(s.id); const c = chat(s.id).summary; if (c.error) c.failedAt = Date.now(); } };
      await Promise.all([lane(), lane()]);
    } catch {} finally { scanning = false; }
  }
  const scanTimer = setInterval(scan, 45_000);
  scanTimer.unref?.();
  setTimeout(scan, 2000).unref?.();

  return {
    async send(id, text) { const r = await send(id, text); if (chats.get(id)?.pending) watch(); return r; },
    open: refreshSummary,
    // Briefs for every session, one at a time (each is a model call); skips ones already current.
    async openAll(ids) { for (const id of ids) await refreshSummary(id); },
    // The first suggested move of each given agent, for "keep them going".
    nextMoves(ids) { return ids.map((id) => [id, chats.get(id)?.summary?.next?.[0]?.prompt]).filter(([, p]) => p); },
    scan,
    stop() { clearInterval(scanTimer); if (timer) clearInterval(timer); },
    view() {
      const o = {};
      for (const [id, c] of chats) o[id] = { msgs: c.msgs, pending: !!c.pending, summary: c.summary.text, summarizing: c.summary.busy, brief: { title: c.summary.title || '', task: c.summary.task || '', chat: c.summary.chat || '', project: c.summary.project || '', kind: c.summary.kind || '', blocker: c.summary.blocker || '', next: c.summary.next || [] } };
      return o;
    },
  };
}
