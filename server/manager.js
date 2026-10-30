// The manager: one Haiku-backed "claude" that summarises the fleet and designs the dashboard.
// It costs nothing while the fleet is quiet: it is only run when something changed (batched,
// at most once per MIN_GAP) or when you send it a message.
import fs from 'node:fs';
import { askHaiku } from './haiku.js';
import { snapshot, diff } from './fleet.js';
import { validateSpec } from './spec.js';

const POLL_MS = 20_000;
const MIN_GAP_MS = Number(process.env.MANAGER_MIN_GAP_MS || 3 * 60_000);
const MODEL = process.env.MANAGER_MODEL || 'haiku';

const SKILL = fs.readFileSync(new URL('./manager-skill.md', import.meta.url), 'utf8');
const SYSTEM = `You are the manager of the Claude Code agents running on this machine. You get a JSON list of
changes (or a message from the user) plus the current sessions. Follow this skill.

${SKILL}

A node is {"type": ..., ...} from: "stack" {children}, "stats" {items:[{label,value}]}, "card" {title, subtitle, badge, text, children},
"session" {id} (a live card for that session; ALWAYS use this for a session instead of copying its status), "text" {text}, "list" {items:[string]},
"button" {label, action, args}, "input" {placeholder, action, args}.
Actions: "open_chat" args {id}, "open_console" args {terminal}, "ask_agent" args {terminal} (input text is sent), "answer" args {terminal}, "refresh" {}.
Put sessions that are "waiting" first. Keep it compact for a phone screen.`;

export function createManager(instances, emit) {
  let running = false, timer = null, last = null, pending = [], lastRun = 0, busy = false;
  const state = { summary: '', ui: null, usage: { runs: 0 }, error: '', busy: null, log: [] };
  const queue = [];
  const note = (who, text) => { state.log.push({ who, text: String(text).slice(0, 600), t: Date.now() }); if (state.log.length > 30) state.log.shift(); };

  const ask = (prompt) => askHaiku(SYSTEM, prompt, MODEL);

  async function run(reason, userMessage) {
    if (busy) return;
    busy = true;
    state.busy = { reason, since: Date.now() };
    emit();
    const changes = pending; pending = []; lastRun = Date.now();
    try {
      const compact = last.sessions.map((s) => ({ id: s.id, name: s.name, status: s.status, cwd: s.cwd, terminal: s.terminal, lastText: s.lastText?.slice(0, 200) }));
      const out = await ask(JSON.stringify({ reason, userMessage, changes, sessions: compact, agentSummaries: api.summaries?.() || {}, previousSummary: state.summary }));
      const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      state.summary = String(json.summary || '').slice(0, 600);
      state.ui = validateSpec(json.ui);
      state.usage.runs++; state.error = '';
      if (userMessage) note('manager', state.summary || 'Done.');
    } catch (e) { state.error = e.message; if (userMessage) note('manager', `Sorry, that failed: ${e.message}`); }
    busy = false; state.busy = null;
    emit();
    if (queue.length) run('user', queue.shift());
  }

  function tick() {
    const cur = snapshot(instances);
    const changes = diff(last, cur);
    const first = !last;
    last = cur;
    pending.push(...changes);
    emit(); // the live cards update every poll, at no token cost
    if (running && pending.length && Date.now() - lastRun >= MIN_GAP_MS) run('changes');
  }

  const api = {
    state,
    fleet: () => last || snapshot(instances),
    isRunning: () => running,
    start() { if (running) return; running = true; tick(); timer ||= setInterval(tick, POLL_MS); run('start'); },
    stop() { running = false; queue.length = 0; clearInterval(timer); timer = null; state.ui = null; emit(); },
    note,
    message(text) {
      const t = String(text).slice(0, 500);
      note('you', t);
      if (!running) { note('manager', 'I am off. Press Start manager first.'); return emit(); }
      if (busy) { queue.push(t); note('manager', 'Still working on the last one; yours is queued.'); return emit(); }
      run('user', t);
    },
    poll: tick,
  };
  return api;
}
