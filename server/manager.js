// The manager: one Haiku-backed "claude" that summarises the fleet and designs the dashboard.
// It costs nothing while the fleet is quiet: it is only run when something changed (batched,
// at most once per MIN_GAP) or when you send it a message.
import { spawn } from 'node:child_process';
import { snapshot, diff } from './fleet.js';
import { validateSpec } from './spec.js';

const POLL_MS = 20_000;
const MIN_GAP_MS = Number(process.env.MANAGER_MIN_GAP_MS || 3 * 60_000);
const MODEL = process.env.MANAGER_MODEL || 'haiku';

const SYSTEM = `You are the manager of the Claude Code agents running on this machine. You get a JSON list of
changes (or a message from the user) plus the current sessions. Reply with ONE JSON object and nothing else:
{"summary": "<=3 short sentences: what happened lately", "ui": <node>}
A node is {"type": ..., ...} from: "stack" {children}, "stats" {items:[{label,value}]}, "card" {title, subtitle, badge, text, children},
"text" {text}, "list" {items:[string]}, "button" {label, action, args}, "input" {placeholder, action, args}.
Actions: "ask_agent" args {terminal} (input text is sent to that agent), "answer" args {terminal} (input text answers it),
"open_console" args {terminal}, "refresh" {}. Only give buttons/inputs to sessions that have a "terminal" value.
Put sessions that are "waiting" first. Keep it compact for a phone screen. Never invent sessions or terminals.`;

export function createManager(instances, emit) {
  let running = false, timer = null, last = null, pending = [], lastRun = 0, busy = false;
  const state = { summary: '', ui: null, usage: { runs: 0 }, error: '' };

  function ask(prompt) {
    return new Promise((resolve, reject) => {
      const p = spawn('claude', ['-p', '--model', MODEL, '--system-prompt', SYSTEM, '--tools', '', '--no-session-persistence',
        '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', ''], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().slice(0, 200) || `exit ${code}`))));
      p.stdin.end(prompt);
    });
  }

  async function run(reason, userMessage) {
    if (busy) return;
    busy = true;
    const changes = pending; pending = []; lastRun = Date.now();
    try {
      const compact = last.sessions.map((s) => ({ id: s.id, name: s.name, status: s.status, cwd: s.cwd, terminal: s.terminal, lastText: s.lastText?.slice(0, 200) }));
      const out = await ask(JSON.stringify({ reason, userMessage, changes, sessions: compact, previousSummary: state.summary }));
      const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      state.summary = String(json.summary || '').slice(0, 600);
      state.ui = validateSpec(json.ui);
      state.usage.runs++; state.error = '';
    } catch (e) { state.error = e.message; }
    busy = false;
    emit();
  }

  function tick() {
    const cur = snapshot(instances);
    const changes = diff(last, cur);
    const first = !last;
    last = cur;
    if (first || changes.length) { pending.push(...changes); emit(); }
    if (running && pending.length && Date.now() - lastRun >= MIN_GAP_MS) run('changes');
  }

  return {
    state,
    fleet: () => last || snapshot(instances),
    isRunning: () => running,
    start() { if (running) return; running = true; tick(); timer ||= setInterval(tick, POLL_MS); run('start'); },
    stop() { running = false; clearInterval(timer); timer = null; state.ui = null; emit(); },
    message(text) { if (running) run('user', String(text).slice(0, 500)); },
    poll: tick,
  };
}
