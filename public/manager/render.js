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
    case 'text': return el('p', '', n.text);
    case 'list': { const e = el('ul'); for (const i of n.items) e.append(el('li', '', i)); return e; }
    case 'button': {
      const b = el('button', '', n.label);
      b.onclick = () => (n.action === 'open_console' ? location.assign(consoleUrl(n.args.terminal)) : act(n.action, n.args));
      return b;
    }
    case 'input': {
      const f = el('form', 'row'), i = el('input'), b = el('button', '', 'Send');
      i.placeholder = n.placeholder || '';
      f.append(i, b);
      f.onsubmit = (ev) => { ev.preventDefault(); if (i.value.trim()) { act(n.action, n.args, i.value); i.value = ''; } };
      return f;
    }
  }
  return el('span');
}

// The main app's address comes from the menu link (?app=<origin>) and is remembered.
const app = (() => { const q = new URLSearchParams(location.search).get('app'); try { if (q) localStorage.setItem('app', q); return q || localStorage.getItem('app') || ''; } catch { return q || ''; } })();
const consoleUrl = (id) => `${app || location.origin}/#${encodeURIComponent(id)}`;

// What to show before the manager has designed anything, or when it is off.
function fallback(fleet) {
  const S = fleet.sessions, active = S.filter((s) => s.status !== 'idle').length;
  return { type: 'stack', children: [
    { type: 'stats', items: [{ label: 'sessions', value: S.length }, { label: 'active', value: active }, { label: 'idle', value: S.length - active }] },
    ...S.map((s) => ({ type: 'card', title: s.name, subtitle: s.cwd, badge: s.status, text: s.lastText || '', children: s.terminal ? [
      { type: 'button', label: 'Open console', action: 'open_console', args: { terminal: s.terminal } },
      { type: 'input', placeholder: 'Tell this agent…', action: 'ask_agent', args: { terminal: s.terminal } }] : [] })),
  ] };
}

function render(s) {
  last = s;
  $('summary').textContent = s.summary || (s.running ? 'Manager is starting…' : 'Manager is off. Showing a plain overview.');
  $('err').textContent = s.error ? 'Manager error: ' + s.error : '';
  const bar = $('bar'); bar.replaceChildren();
  const b = el('button', '', s.running ? 'Stop manager' : 'Start manager');
  b.onclick = () => act(s.running ? 'stop' : 'start');
  const r = el('button', '', 'Refresh'); r.onclick = () => act('refresh');
  bar.append(b, r);
  $('ui').replaceChildren(node(s.running && s.ui ? s.ui : fallback(s.fleet), s.fleet));
}

function go() {
  const es = new EventSource('events');
  es.onopen = () => { $('dot').className = 'dot'; $('conn').textContent = 'live'; };
  es.onerror = () => { $('dot').className = 'dot off'; $('conn').textContent = 'reconnecting'; };
  es.onmessage = (e) => { const v = JSON.parse(e.data); if (v.type === 'STATE_SNAPSHOT') { const f = document.activeElement; if (!(f && f.tagName === 'INPUT' && f.value)) render(v.snapshot); } };
}
$('msg').onsubmit = (e) => { e.preventDefault(); const i = e.target.t; if (i.value.trim()) { act('message', {}, i.value); i.value = ''; } };
go();

$('more').onclick = () => { $('more-menu').hidden = !$('more-menu').hidden; };
$('more-menu').onclick = async (e) => {
  const m = e.target.dataset.m; if (!m) return;
  $('more-menu').hidden = true;
  const r = await fetch('api/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: m }) });
  const j = await r.json().catch(() => ({}));
  $('summary').textContent = r.ok ? `Told ${j.told} idle agent(s).` : (j.error || 'failed');
};
