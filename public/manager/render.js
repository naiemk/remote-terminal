// Renders the manager's UI spec (validated on the server) with textContent only: model text is
// never parsed as HTML.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let last = null;

async function act(action, args, text) {
  const r = await fetch('api/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args, text }) });
  if (!r.ok) $('err').textContent = (await r.json().catch(() => ({}))).error || 'failed';
}

function node(n, fleet) {
  switch (n.type) {
    case 'stack': { const e = el('div', 'stack'); for (const c of n.children) e.append(node(c, fleet)); return e; }
    case 'stats': { const e = el('div', 'stats'); for (const i of n.items) { const s = el('div', 'stat'); s.append(el('b', '', i.value), el('span', '', i.label)); e.append(s); } return e; }
    case 'card': {
      const e = el('div', 'card'), top = el('div', 'top');
      top.append(el('span', 'title', n.title));
      if (n.badge) top.append(el('span', 'badge ' + n.badge.toLowerCase().replace(/\W/g, ''), n.badge));
      e.append(top);
      if (n.subtitle) e.append(el('div', 'sub', n.subtitle));
      if (n.text) e.append(el('div', 'text', n.text));
      for (const c of n.children) e.append(node(c, fleet));
      return e;
    }
    case 'session': { const x = fleet.sessions.find((y) => y.id === n.id); return x ? node(sessionCard(x), fleet) : el('span'); }
    case 'next': return nextBox(n.id);
    case 'text': return el('p', '', n.text);
    case 'list': { const e = el('ul'); for (const i of n.items) e.append(el('li', '', i)); return e; }
    case 'button': {
      const b = el('button', '', n.label);
      b.onclick = () => (n.action === 'open_chat' ? (location.hash = '#/a/' + n.args.id) : n.action === 'open_console' ? window.open(consoleUrl(n.args.terminal), '_blank') : act(n.action, n.args));
      return b;
    }
    case 'input': {
      const f = el('form', 'row'), i = el('input'), b = el('button', '', 'Send');
      i.placeholder = n.placeholder || '';
      f.append(i, b);
      i.dataset.key = n.action + ':' + n.args.terminal;
      f.onsubmit = (ev) => { ev.preventDefault(); if (i.value.trim()) { act(n.action, n.args, i.value); i.value = ''; } };
      return f;
    }
  }
  return el('span');
}

// The main app's address comes from the menu link (?app=<origin>) and is remembered.
const app = (() => { const q = new URLSearchParams(location.search).get('app'); try { if (q) localStorage.setItem('app', q); return q || localStorage.getItem('app') || ''; } catch { return q || ''; } })();
const consoleUrl = (id) => `${app || location.origin}/#${encodeURIComponent(id)}`;

// A live card for one session; the manager refers to it by id so status and latest text never go stale.
function sessionCard(s) {
  const a = (last?.agents || {})[s.id], b = a?.brief || {};
  return { type: 'card', title: b.title || s.name, subtitle: b.project || s.cwd, badge: s.status, text: b.task || s.lastText || '', children: [
    { type: 'next', id: s.id },
    { type: 'button', label: 'Open chat', action: 'open_chat', args: { id: s.id } }] };
}

// Pick one of the suggested next moves and/or add your own words, then send: the whole dispatch for one agent.
const draft = new Map();
function nextBox(id) {
  const a = (last?.agents || {})[id] || {}, b = a.brief || {}, d = draft.get(id) || (draft.set(id, { opt: -1, text: '' }), draft.get(id));
  const e = el('div', 'nextbox');
  if (b.blocker) e.append(el('div', 'blocker', 'Blocked: ' + b.blocker));
  const opts = b.next || [];
  if (!opts.length) e.append(el('div', 'hint', a.summarizing ? 'Reading the project to suggest next moves…' : 'No suggestions yet.'));
  const send = el('button', 'send', 'Send');
  const input = el('input'); input.dataset.key = 'ctx:' + id; input.value = d.text; input.autocomplete = 'off';
  const sync = () => { input.placeholder = d.opt >= 0 ? 'Add context (optional)…' : 'Or type your own instruction…'; send.disabled = a.pending || (d.opt < 0 && !d.text.trim()); };
  opts.forEach((o, i) => {
    const bt = el('button', 'opt' + (d.opt === i ? ' sel' : ''), o.label); bt.title = o.prompt;
    bt.onclick = () => { d.opt = d.opt === i ? -1 : i; for (const x of e.querySelectorAll('button.opt')) x.classList.remove('sel'); if (d.opt >= 0) bt.classList.add('sel'); sync(); };
    e.append(bt);
  });
  const f = el('form', 'row'); f.append(input, send);
  input.oninput = () => { d.text = input.value; sync(); };
  f.onsubmit = (ev) => {
    ev.preventDefault();
    const t = [d.opt >= 0 ? opts[d.opt]?.prompt : '', d.text.trim() ? (d.opt >= 0 ? 'Additional context: ' : '') + d.text.trim() : ''].filter(Boolean).join('\n\n');
    if (!t) return;
    draft.set(id, { opt: -1, text: '' }); send.disabled = true; input.value = '';
    act('agent_send', { id }, t);
  };
  sync();
  e.append(f);
  if (a.pending) e.append(el('div', 'hint', 'Sent. The agent is working on it…'));
  return e;
}

// What to show before the manager has designed anything, or when it is off.
function fallback(fleet) {
  const S = fleet.sessions, active = S.filter((s) => s.status !== 'idle').length;
  return { type: 'stack', children: [
    { type: 'stats', items: [{ label: 'sessions', value: S.length }, { label: 'active', value: active }, { label: 'idle', value: S.length - active }] },
    ...S.map(sessionCard),
  ] };
}

function route() { const m = location.hash.match(/^#\/a\/([\w-]+)$/); return m ? m[1] : null; }

function render(s) {
  last = s;
  const id = route();
  $('board').hidden = !!id; $('agent').hidden = !id;
  if (id) return renderAgent(s, id);
  $('summary').textContent = s.summary || (s.running ? 'Manager is starting…' : 'Manager is off. Showing a plain overview.');
  const ab = s.about;
  if (ab) $('about').textContent = `Claude Manager\nversion ${ab.version}${ab.installed ? ' (' + ab.installed + ')' : ''}\nmanager code loaded ${new Date(ab.loadedAt).toLocaleString()}${ab.reloads ? ' · reloaded ' + ab.reloads + '×' : ''}`;
  $('err').textContent = s.error ? 'Manager error: ' + s.error : '';
  const bar = $('bar'); bar.replaceChildren();
  const b = el('button', '', s.running ? 'Stop manager' : 'Start manager');
  b.onclick = () => act(s.running ? 'stop' : 'start');
  const r = el('button', '', 'Refresh'); r.onclick = () => act('refresh');
  bar.append(b, r);
  // Redraw in place, keeping whatever is being typed in the cards' boxes.
  const typed = new Map(), f = document.activeElement;
  for (const i of document.querySelectorAll('#ui input')) if (i.value) typed.set(i.dataset.key, i.value);
  const focusKey = f && f.closest('#ui') ? f.dataset.key : null, pos = focusKey ? f.selectionStart : 0;
  $('ui').replaceChildren(node(s.running && s.ui ? s.ui : fallback(s.fleet), s.fleet));
  for (const i of document.querySelectorAll('#ui input')) {
    if (typed.has(i.dataset.key)) i.value = typed.get(i.dataset.key);
    if (i.dataset.key === focusKey) { i.focus(); try { i.setSelectionRange(pos, pos); } catch {} }
  }
  const busy = $('busy'); busy.hidden = !s.busy;
  if (s.busy) busy.lastChild.textContent = s.busy.reason === 'user' ? 'Manager is thinking about your message…' : 'Manager is updating the board…';
  const log = $('log'), atEnd = log.children.length !== (s.log || []).length;
  log.replaceChildren(...(s.log || []).map((m) => el('div', 'm ' + m.who, m.text)));
  if (atEnd) log.lastChild?.scrollIntoView({ block: 'nearest' });
}

window.addEventListener('hashchange', () => last && render(last));

function go() {
  const es = new EventSource('events');
  es.onopen = () => { $('dot').className = 'dot'; $('conn').textContent = 'live'; };
  es.onerror = () => { $('dot').className = 'dot off'; $('conn').textContent = 'reconnecting'; };
  es.onmessage = (e) => { const v = JSON.parse(e.data); if (v.type === 'STATE_SNAPSHOT') render(v.snapshot); };
}
$('msg').onsubmit = async (e) => { e.preventDefault(); const i = e.target.t; if (i.value.trim()) { const t = i.value; i.value = ''; $('busy').hidden = false; $('busy').lastChild.textContent = 'Sending…'; await act('message', {}, t); } };
go();

$('more').onclick = () => { $('more-menu').hidden = !$('more-menu').hidden; };
$('more-menu').onclick = async (e) => {
  const m = e.target.dataset.m; if (!m) return;
  $('more-menu').hidden = true;
  if (m === 'about') { $('about').hidden = !$('about').hidden; return; }
  const r = await fetch('api/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: m }) });
  const j = await r.json().catch(() => ({}));
  $('summary').textContent = !r.ok ? (j.error || 'failed') : m === 'reload' ? 'Reloading the manager…' : `Told ${j.told} idle agent(s).`;
};
