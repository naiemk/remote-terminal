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
    case 'move': {
      const b = el('button', 'opt', n.label); b.title = n.prompt;
      b.onclick = () => { b.disabled = true; act('agent_send', { id: n.id }, n.prompt).finally(() => (b.disabled = false)); };
      return b;
    }
    case 'tell': {
      const f = el('form', 'row'), i = el('input'), b = el('button', '', 'Send');
      i.placeholder = 'Your own instruction…'; i.dataset.key = 'tell:' + n.id;
      f.append(i, b);
      f.onsubmit = (ev) => { ev.preventDefault(); const x = ev.target.querySelector('input'); if (x.value.trim()) { act('agent_send', { id: n.id }, x.value); x.value = ''; } };
      return f;
    }
    case 'input': {
      const f = el('form', 'row'), i = el('input'), b = el('button', '', 'Send');
      i.placeholder = n.placeholder || '';
      f.append(i, b);
      i.dataset.key = n.action + ':' + n.args.terminal;
      f.onsubmit = (ev) => { ev.preventDefault(); const x = ev.target.querySelector('input'); if (x.value.trim()) { act(n.action, n.args, x.value); x.value = ''; } };
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
  e.dataset.id = id;
  if (b.blocker) e.append(el('div', 'blocker', 'Blocked: ' + b.blocker));
  const opts = b.next || [];
  if (!opts.length) e.append(el('div', 'hint', a.summarizing ? 'Reading the project to suggest next moves…' : 'No suggestions yet.'));
  if (a.screen) e.append(el('pre', 'screen', a.screen), el('div', 'hint', 'Waiting on you. Type the option number (or your answer) and Send; check the terminal to confirm.'));
  const send = el('button', 'send', 'Send');
  const input = el('input'); input.dataset.key = 'ctx:' + id; input.value = d.text; input.autocomplete = 'off';
  // Handlers read the live DOM, never captured nodes: a patched card keeps its old elements and takes the new handlers.
  const sync = (root) => {
    const dd = draft.get(id), inp = root.querySelector('input'), sb = root.querySelector('button.send');
    inp.placeholder = dd.opt >= 0 ? 'Add context (optional)…' : 'Or type your own instruction…';
    sb.disabled = !!(((last?.agents || {})[id] || {}).pending) || (dd.opt < 0 && !dd.text.trim());
  };
  opts.forEach((o, i) => {
    const bt = el('button', 'opt' + (d.opt === i ? ' sel' : ''), o.label); bt.title = o.prompt;
    bt.onclick = (ev) => {
      const root = ev.target.closest('.nextbox'), dd = draft.get(id);
      dd.opt = dd.opt === i ? -1 : i;
      root.querySelectorAll('button.opt').forEach((x, j) => x.classList.toggle('sel', j === dd.opt));
      sync(root);
    };
    e.append(bt);
  });
  const f = el('form', 'row'); f.append(input, send);
  input.oninput = (ev) => { draft.get(id).text = ev.target.value; sync(ev.target.closest('.nextbox')); };
  f.onsubmit = (ev) => {
    ev.preventDefault();
    const dd = draft.get(id), root = ev.target.closest('.nextbox'), cur = ((last?.agents || {})[id]?.brief?.next) || [];
    const t = [dd.opt >= 0 ? cur[dd.opt]?.prompt : '', dd.text.trim() ? (dd.opt >= 0 ? 'Additional context: ' : '') + dd.text.trim() : ''].filter(Boolean).join('\n\n');
    if (!t) return;
    draft.set(id, { opt: -1, text: '' }); root.querySelector('input').value = '';
    root.querySelectorAll('button.opt').forEach((x) => x.classList.remove('sel'));
    sync(root);
    act('agent_send', { id }, t);
  };
  e.append(f);
  sync(e);
  const m = (a.msgs || []).findLast((x) => x.who === 'you');
  if (m && (a.pending || m.state === 'failed')) e.append(stageBar(m));
  return e;
}

// Patch the live DOM to match a freshly built tree instead of replacing it, so a box you are typing in keeps
// its text, focus, cursor and on-screen keyboard however often the board updates.
function morph(old, nw) {
  if (old.nodeType === 3 || nw.nodeType === 3) { if (old.nodeType === 3 && nw.nodeType === 3) { if (old.data !== nw.data) old.data = nw.data; return old; } old.replaceWith(nw); return nw; }
  if (old.tagName !== nw.tagName) { old.replaceWith(nw); return nw; }
  if (old.className !== nw.className) old.className = nw.className;
  for (const a of [...old.attributes]) if (a.name !== 'class' && a.name !== 'value' && !nw.hasAttribute(a.name)) old.removeAttribute(a.name);
  for (const a of nw.attributes) if (a.name !== 'class' && a.name !== 'value' && old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
  for (const h of ['onclick', 'onsubmit', 'oninput']) old[h] = nw[h];
  if (old.disabled !== nw.disabled) old.disabled = nw.disabled;
  if (old.tagName === 'INPUT' || old.tagName === 'TEXTAREA') {
    if (old.placeholder !== nw.placeholder) old.placeholder = nw.placeholder;
    if (old.dataset.key !== nw.dataset.key) old.value = nw.value; // a different box now: take its text
    return old;
  }
  const o = [...old.childNodes], n = [...nw.childNodes];
  n.forEach((c, i) => { if (o[i]) morph(o[i], c); else old.append(c); });
  for (let i = n.length; i < o.length; i++) o[i].remove();
  return old;
}

// What to show before the manager has designed anything, or when it is off.
function fallback(fleet) {
  const S = fleet.sessions, active = S.filter((s) => s.status !== 'idle').length;
  return { type: 'stack', children: [
    { type: 'stats', items: [{ label: 'sessions', value: S.length }, { label: 'active', value: active }, { label: 'idle', value: S.length - active }] },
    ...S.map(sessionCard),
  ] };
}

// Which voice the briefing will use: the server's neural one (plays with the phone locked) or the browser's.
let srv = null; // the server's own voice list (macOS), when it has one
function vstatus(v) {
  const t = $('vstat'), x = v?.state;
  const had = srv?.voices?.length; srv = v?.voices?.length ? v : null; if (!!srv !== !!had || srv) window.fillVoices?.();
  t.textContent = x === 'ready' && srv ? `Voice: ${srv.voice} (plays with the screen locked)` : x === 'ready' ? 'Voice: neural (plays with the screen locked)' : x === 'installing' ? 'Voice: installing the neural voice (~110 MB)…'
    : x === 'failed' ? `Voice: install failed (${v.error}). Using the browser voice.` : x === 'broken' ? `Voice: neural voice is installed but failed to run (${v.error}). Using the browser voice.` : x === 'unsupported' ? 'Voice: no neural voice for this machine. Using the browser voice.'
    : 'Voice: browser voice (the server has not started the neural install; restart it or retry)';
  if (x === 'failed' || x === 'unknown') { const b = el('button', '', 'Retry install'); b.onclick = () => act('voice_install'); t.append(' ', b); }
}

function route() { const m = location.hash.match(/^#\/a\/([\w-]+)$/); return m ? m[1] : null; }

function render(s) {
  last = s;
  vstatus(s.voice);
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
  const tree = node(s.running && s.ui ? s.ui : fallback(s.fleet), s.fleet), ui = $('ui');
  if (ui.firstChild) morph(ui.firstChild, tree); else ui.append(tree);
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
  // Snapshots arrive on every poll; draw at most once a frame, and not at all when nothing changed.
  let queued = null, prev = '';
  es.onmessage = (e) => {
    const v = JSON.parse(e.data); if (v.type !== 'STATE_SNAPSHOT') return;
    if (e.data === prev) return; prev = e.data;
    if (!queued) requestAnimationFrame(() => { const x = queued; queued = null; render(x); });
    queued = v.snapshot;
  };
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

// Spoken briefing: "Play summary" tells the whole story; "What's new" only what changed since the last listen.
// Speech must be started from the tap itself (iOS), so we prime the synthesizer before waiting on the server.
(() => {
  const full = $('vfull'), news = $('vnew'), txt = $('vtext'), ss = window.speechSynthesis;
  const get = () => { try { return Number(localStorage.getItem('voiceAt')) || 0; } catch { return 0; } };
  const set = (t) => { try { localStorage.setItem('voiceAt', String(t)); } catch {} };
  let playing = false;
  // The built-in voices vary a lot: the best ones are "Enhanced/Premium/Siri/Natural/Neural" ones, which are free
  // but have to be installed on the phone (iOS: Settings > Accessibility > Spoken Content > Voices).
  const BAD = /compact|fred|albert|zarvox|bahh|bells|boing|bubbles|cellos|deranged|hysterical|organ|trinoids|whisper|wobble|superstar|jester|junior|kathy|princess|ralph|bad news|good news/i;
  const score = (v) => (/^en/i.test(v.lang) ? 0 : -100) - (BAD.test(v.name) ? 50 : 0) + (/premium/i.test(v.name) ? 40 : 0) + (/enhanced/i.test(v.name) ? 30 : 0)
    + (/natural|neural|online/i.test(v.name) ? 35 : 0) + (/siri/i.test(v.name) ? 25 : 0) + (/google/i.test(v.name) ? 15 : 0) + (/^(ava|zoe|evan|nathan|allison|samantha|serena|daniel|moira|karen|aaron|nicky)\b/i.test(v.name) ? 10 : 0)
    + (/^en[-_]US/i.test(v.lang) ? 3 : 0) + (v.localService ? 1 : 0);
  // Novelty voices (Bells, Organ, ...) are never useful for a briefing, so they are hidden; other languages stay listed,
  // after the English ones, because the phone may expose a voice you installed under a different language.
  const voices = () => (ss?.getVoices() || []).filter((v) => !BAD.test(v.name) || /premium|enhanced/i.test(v.name)).sort((a, b) => score(b) - score(a));
  const chosen = () => { let n = ''; try { n = localStorage.getItem('voiceName') || ''; } catch {} const all = voices(); return all.find((v) => v.name === n) || all[0]; };
  const sel = $('vpick');
  let key = '';
  const fill = () => {
    if (srv) { // the server speaks: choose among the voices installed on its machine
      const k = srv.voices.map((v) => v.name).join('|') + '\n' + srv.voice;
      if (k === key) return; key = k;
      sel.replaceChildren(...srv.voices.map((v) => { const o = el('option', '', v.name + (/^en/i.test(v.lang) ? '' : ` (${v.lang})`) + (/premium|enhanced/i.test(v.name) ? ' ★' : '')); o.value = v.name; o.selected = v.name === srv.voice; return o; }));
      return;
    }
    key = ''; const all = voices(), cur = chosen(); sel.replaceChildren(...all.map((v) => { const o = el('option', '', v.name + (/^en/i.test(v.lang) ? '' : ` (${v.lang})`) + (/premium|enhanced|natural|neural|siri/i.test(v.name) ? ' ★' : '')); o.value = v.name; o.selected = v === cur; return o; }));
  };
  window.fillVoices = fill;
  if (ss) { fill(); ss.onvoiceschanged = fill; }
  sel.onchange = async () => {
    if (srv) { // tell the server, then play a sample in the new voice
      au.src = SILENT; au.play().catch(() => {});
      const r = await fetch('api/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'voice_set', args: { name: sel.value } }) }).then((x) => x.json()).catch(() => ({}));
      if (r.audio) play(r.audio);
      return;
    }
    try { localStorage.setItem('voiceName', sel.value); } catch {} if (ss) { ss.cancel(); const u = new SpeechSynthesisUtterance('Hello, this is how I sound.'); u.voice = chosen(); ss.speak(u); } };
  const label = () => { full.textContent = playing ? '■ Stop' : '▶ Play summary'; };
  const au = $('vaudio'), SILENT = 'data:audio/wav;base64,UklGRiQAAAAXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  const stop = () => { playing = false; ss?.cancel(); au.pause(); au.currentTime = 0; label(); };
  au.onended = au.onerror = () => { if (au.src && !au.src.startsWith('data:')) { playing = false; label(); } };
  // Recorded audio keeps playing with the screen locked or another app open (speech synthesis does not).
  const play = async (url) => {
    au.src = url; playing = true; label();
    try {
      await au.play();
      if (navigator.mediaSession) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: 'Claude Manager summary', artist: 'Remote Terminal' });
        navigator.mediaSession.setActionHandler('play', () => { au.play(); playing = true; label(); });
        navigator.mediaSession.setActionHandler('pause', () => { au.pause(); playing = false; label(); });
      }
      return true;
    } catch { playing = false; label(); return false; }
  };
  const say = (text) => {
    if (!ss) return;
    ss.cancel(); playing = true; label();
    // short chunks: some phones cut a long utterance off after about fifteen seconds
    const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    parts.forEach((p, i) => { const u = new SpeechSynthesisUtterance(p.trim()); const v = chosen(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US'; u.rate = 0.98; if (i === parts.length - 1) u.onend = u.onerror = () => { playing = false; label(); }; ss.speak(u); });
  };
  async function run(since, btn) {
    if (playing) return stop();
    if (ss) { ss.cancel(); ss.speak(new SpeechSynthesisUtterance('')); } // unlock audio inside the tap
    au.src = SILENT; au.play().catch(() => {});
    const old = btn.textContent; full.disabled = news.disabled = true; btn.textContent = 'Writing…';
    const at = Date.now();
    const r = await fetch('api/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'voice', args: { since } }) }).then((x) => x.json()).catch(() => ({ error: 'unreachable' }));
    full.disabled = news.disabled = false; btn.textContent = old; label();
    if (!r.ok) { txt.hidden = false; txt.textContent = 'Could not write the summary: ' + (r.error || 'failed'); return; }
    set(at); txt.hidden = false; txt.textContent = r.text;
    if (!(r.audio && await play(r.audio))) say(r.text);
  }
  full.onclick = () => run(0, full);
  news.onclick = () => run(get(), news);
})();
