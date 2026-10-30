// One agent's page: where it stands, a chat with it, and what you can do to it.
// Text only (textContent); nothing from an agent or a model is parsed as HTML.
let shown = null, seen = 0;

function renderAgent(s, id) {
  const root = $('agent');
  const a = s.fleet.sessions.find((x) => x.id === id), chat = (s.agents || {})[id] || { msgs: [], pending: false, summary: '', summarizing: false };
  if (shown !== id) {
    shown = id; seen = 0; root.replaceChildren();
    const back = el('a', 'back', '← All agents'); back.href = '#';
    const head = el('div', 'top'); head.id = 'a-head';
    const acts = el('div', 'acts'); acts.id = 'a-acts';
    const blob = el('div', 'blob'); blob.id = 'a-blob';
    const tl = el('div', 'tl'); tl.id = 'a-tl';
    const form = el('form', 'row sendrow'), input = el('textarea'), btn = el('button', 'send', 'Send');
    input.rows = 2; input.placeholder = 'Tell this agent what to do…'; input.id = 'a-in';
    form.append(input, btn);
    const go = () => { const t = input.value.trim(); if (!t || btn.disabled) return; input.value = ''; btn.disabled = true; act('agent_send', { id }, t); };
    form.onsubmit = (e) => { e.preventDefault(); go(); };
    input.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } };
    root.append(back, head, acts, blob, tl, form);
    act('agent_open', { id });
  }
  const head = $('a-head'), acts = $('a-acts'), blob = $('a-blob'), tl = $('a-tl'), btn = root.querySelector('.send');
  if (!a) {
    head.replaceChildren(el('span', 'title', 'This agent has ended'));
    acts.replaceChildren(); blob.replaceChildren(); btn.disabled = true;
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

  blob.replaceChildren(el('div', 'lbl', 'Where it stands'));
  if (chat.summarizing && !chat.summary) { const w = el('div', 'wait'); w.append(el('i', 'spin'), el('span', '', 'Reading its recent work…')); blob.append(w); }
  else blob.append(el('div', '', chat.summary || a.lastText || 'Nothing to report yet.'));

  const kids = [];
  chat.msgs.forEach((m, i) => {
    if (m.who === 'you') {
      const b = el('div', 'm you', m.text);
      b.append(el('small', 'tick', m.state === 'failed' ? '✕ not delivered' : m.state === 'delivered' ? '✓ delivered' : 'sending…'));
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
  if (total !== seen) { seen = total; (tl.lastChild || tl).scrollIntoView({ block: 'nearest' }); }

  btn.disabled = chat.pending;
  btn.replaceChildren(...(chat.pending ? [el('i', 'spin'), document.createTextNode(' Working')] : [document.createTextNode('Send')]));
}
