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
    case 'text': return el('p', '', n.text);
    case 'list': { const e = el('ul'); for (const i of n.items) e.append(el('li', '', i)); return e; }
    case 'button': {
      const b = el('button', '', n.label);
      b.onclick = () => (n.action === 'open_chat' ? (location.hash = '#/a/' + n.args.id) : n.action === 'open_console' ? window.open(consoleUrl(n.args.terminal), '_blank') : act(n.action, n.args));
      return b;
    }
    case 'move': {
      const b = el('button', 'opt', n.label); b.title = n.prompt;
      b.onclick = () => { b.disabled = true; act('agent_send', { id: n.id }, n.prompt).finally(() => (b.disabled = false)); };
      return b;
    }
    case 'tell': {
      const f = el('form', 'row'), i = el('input'), b = el('button', '', 'Send');
      i.placeholder = 'Your own instruction…'; i.dataset.key = 'tell:' + n.id;
      f.append(i, b);
      f.onsubmit = (ev) => { ev.preventDefault(); if (i.value.trim()) { act('agent_send', { id: n.id }, i.value); i.value = ''; } };
      return f;
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
// A card per session: what it is doing, its three suggested next moves (one tap sends it), and a box for
// your own instruction. Sends go through the agent's chat, so progress shows on its page.
function sessionCard(s) {
  const b = last?.agents?.[s.id]?.brief || {};
  const kids = [{ type: 'button', label: 'Chat', action: 'open_chat', args: { id: s.id } }];
  for (const n of b.next || []) kids.push({ type: 'move', label: n.label, prompt: n.prompt, id: s.id });
  kids.push({ type: 'tell', id: s.id });
  return { type: 'card', title: b.title || s.name, subtitle: s.cwd, badge: s.status, text: b.blocker ? 'Needs you: ' + b.blocker : (last?.agents?.[s.id]?.summary || s.lastText || ''), children: kids };
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
  $('err').textContent = s.error ? 'Manager error: ' + s.error : '';
  const bar = $('bar'); bar.replaceChildren();
  const b = el('button', '', s.running ? 'Stop manager' : 'Start manager');
  b.onclick = () => act(s.running ? 'stop' : 'start');
  const r = el('button', '', 'Refresh'); r.onclick = () => act('refresh');
  const k = el('button', '', 'Keep all going'); k.title = "Send each idle agent its top suggested move";
  k.onclick = async () => { k.disabled = true; await act('continue_all'); k.disabled = false; };
  bar.append(b, r, k);
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
  const r = await fetch('api/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: m }) });
  const j = await r.json().catch(() => ({}));
  $('summary').textContent = !r.ok ? (j.error || 'failed') : m === 'reload' ? 'Reloading the manager…' : `Told ${j.told} idle agent(s).`;
};

$('tellall').onsubmit = async (e) => {
  e.preventDefault(); const i = e.target.t, t = i.value.trim(); if (!t) return;
  i.value = ''; await act('tell_all', {}, t);
};

$('about').onclick = async () => {
  $('more-menu').hidden = true;
  const d = $('about-dlg'), body = $('about-body'); body.textContent = 'Checking…'; d.showModal();
  const a = await fetch('api/about').then((r) => r.json()).catch(() => ({ error: 'unreachable' }));
  if (a.error && !a.version) { body.textContent = 'Could not check: ' + a.error; return; }
  const short = (c) => (c ? String(c).slice(0, 7) : 'unknown');
  const state = !a.latest ? 'Latest version unknown (offline?).' : a.available ? 'A newer version is available.' : 'You are up to date.';
  body.replaceChildren(el('p', '', `Running: v${a.version} (${short(a.installed)})`), el('p', '', `Latest: ${short(a.latest)}`), el('p', a.available ? 'err' : '', state));
};
$('about-close').onclick = () => $('about-dlg').close();
