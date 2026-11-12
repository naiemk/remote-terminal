// One agent's page: where it stands, a chat with it, and what you can do to it.
// Text only (textContent); nothing from an agent or a model is parsed as HTML.
let shown = null, seen = 0;

// Where a message to an agent is right now: received by the manager, forwarded, delivered, being worked on, done.
const STAGES = ['received', 'forwarding', 'delivered', 'working', 'done'];
function stageBar(m) {
  const w = el('div', 'stages');
  const st = m.state === 'delivered' || m.state === 'forwarding' || m.state === 'received' || m.state === 'working' || m.state === 'done' ? m.state : m.state === 'waiting' ? 'working' : m.state === 'ended' ? 'done' : null;
  const at = STAGES.indexOf(st);
  const names = { received: 'Received', forwarding: 'Forwarding', delivered: 'Delivered', working: 'Agent working', done: 'Done' };
  if (m.state === 'failed') { w.append(el('span', 'stg bad', '✕ Not delivered')); return w; }
  STAGES.forEach((n, i) => w.append(el('span', 'stg' + (i < at ? ' ok' : i === at ? (st === 'done' ? ' ok' : ' now') : ''), (i < at || (i === at && st === 'done') ? '✓ ' : '') + names[n])));
  if (m.state === 'waiting') w.append(el('span', 'stg bad', 'Agent is waiting for you'));
  return w;
}

function renderAgent(s, id) {
  const root = $('agent');
  const a = s.fleet.sessions.find((x) => x.id === id), chat = (s.agents || {})[id] || { msgs: [], pending: false, summary: '', summarizing: false };
  if (shown !== id) {
    shown = id; seen = 0; root.replaceChildren();
    const back = el('a', 'back', '← All agents'); back.href = '#';
    const head = el('div', 'top'); head.id = 'a-head';
    const acts = el('div', 'acts'); acts.id = 'a-acts';
    const blob = el('div', 'blob'); blob.id = 'a-blob';
    const nx = el('div', 'next'); nx.id = 'a-next';
    const tl = el('div', 'tl'); tl.id = 'a-tl';
    const hist = el('details', 'hist'); hist.id = 'a-hist'; hist.append(el('summary', '', 'History'), tl);
    const form = el('form', 'row sendrow'), input = el('textarea'), btn = el('button', 'send', 'Send');
    input.rows = 2; input.placeholder = 'Tell this agent what to do…'; input.id = 'a-in';
    form.append(input, btn);
    const go = () => { const t = input.value.trim(); if (!t || btn.disabled) return; input.value = ''; btn.disabled = true; act('agent_send', { id }, t); };
    form.onsubmit = (e) => { e.preventDefault(); go(); };
    input.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } };
    root.append(back, head, acts, blob, nx, form, hist);
    act('agent_open', { id });
  }
  const head = $('a-head'), acts = $('a-acts'), blob = $('a-blob'), nx = $('a-next'), tl = $('a-tl'), btn = root.querySelector('.send');
  if (!a) {
    head.replaceChildren(el('span', 'title', 'This agent has ended'));
    acts.replaceChildren(); blob.replaceChildren(); nx.replaceChildren(); btn.disabled = true;
    return;
  }
  head.replaceChildren(el('span', 'title', a.name), el('span', 'badge ' + a.status.toLowerCase().replace(/\W/g, ''), a.status));
  if (a.terminal) {
    const open = el('a', 'btn tr', 'Open terminal'); open.href = consoleUrl(a.terminal); open.target = '_blank'; open.rel = 'noopener';
    head.append(open);
  }
  const sub = el('div', 'sub', a.cwd);
  acts.replaceChildren(sub);
  if (a.terminal) {
    const kill = el('button', 'danger', 'Stop agent');
    kill.onclick = () => { if (confirm(`Stop ${a.name}? Its terminal closes.`)) act('kill', { terminal: a.terminal }); };
    const r = el('div', 'row'); r.append(kill); acts.append(r);
  } else {
    acts.append(el('div', 'hint', 'Started outside Remote Terminal. You can message it from here, but it can’t be opened or stopped here.'));
  }

  const br = chat.brief || { next: [] };
  const sec = (label, text) => { const d = el('div', 'sec'); d.append(el('div', 'lbl', label), el('div', '', text)); return d; };
  blob.replaceChildren();
  if (chat.screen) blob.append(el('div', 'lbl', 'Waiting on you'), el('pre', 'screen', chat.screen));
  if (br.title) blob.append(el('div', 'atitle', br.title));
  if (br.project) blob.append(el('div', 'proj', `${br.kind ? br.kind + ' · ' : ''}${br.project}`));
  if (chat.summarizing && !chat.summary) { const w = el('div', 'wait'); w.append(el('i', 'spin'), el('span', '', 'Reading the project and its recent work…')); blob.append(w); }
  else {
    if (br.task) blob.append(sec('Current task', br.task));
    if (br.chat) blob.append(sec('Latest chat', br.chat));
    blob.append(sec('Where it stands', chat.summary || a.lastText || 'Nothing to report yet.'));
  }
  if (br.blocker) { const b = el('div', 'blocker'); b.append(el('div', 'lbl', 'Blocked'), el('div', '', br.blocker)); blob.append(b); }

  // Three suggested next moves; the fourth is your own message in the box below.
  const opts = br.next.map((n) => {
    const b = el('button', 'opt', n.label); b.title = n.prompt; b.disabled = chat.pending;
    b.onclick = () => { b.disabled = true; act('agent_send', { id }, n.prompt); };
    const row = el('div', 'optrow'); row.append(b, el('small', '', n.prompt)); return row;
  });
  nx.replaceChildren(...(opts.length ? [el('div', 'lbl', 'Next moves'), ...opts, el('small', 'hint', 'Or write your own below.')] : []));

  const hist = $('a-hist');
  if (chat.pending && !hist.dataset.wasPending) hist.open = true; // show progress while it works, then leave it to you
  hist.dataset.wasPending = chat.pending ? '1' : '';
  hist.querySelector('summary').textContent = `History (${chat.msgs.length})`;
  const kids = [];
  chat.msgs.forEach((m, i) => {
    if (m.who === 'you') {
      const b = el('div', 'm you', m.text);
      b.append(stageBar(m));
      kids.push(b);
    } else if (m.who === 'progress') {
      const p = el('div', 'prog'); if (chat.pending && i === chat.msgs.length - 1) p.append(el('i', 'spin'));
      p.append(el('span', '', m.text)); kids.push(p);
    } else if (m.who === 'summary') {
      const c = el('div', 'sumcard'); c.append(el('div', 'lbl', 'Summary'), el('div', '', m.text)); kids.push(c);
    } else kids.push(el('div', 'hint', m.text));
  });
  if (chat.pending && !(chat.msgs.length && chat.msgs[chat.msgs.length - 1].who === 'progress')) {
    const w = el('div', 'prog'); w.append(el('i', 'spin'), el('span', '', 'Working on it…')); kids.push(w);
  }
  tl.replaceChildren(...kids);
  const total = chat.msgs.length + (chat.pending ? 1 : 0);
  if (total !== seen) { seen = total; if (hist.open) (tl.lastChild || tl).scrollIntoView({ block: 'nearest' }); }

  btn.disabled = chat.pending;
  btn.replaceChildren(...(chat.pending ? [el('i', 'spin'), document.createTextNode(' Working')] : [document.createTextNode('Send')]));
}
