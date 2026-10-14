import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('rt.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rt.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('rt.' + k); } catch {} },
};

const isTouch = matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', isTouch);

const KEYS = {
  esc: '\x1b', tab: '\t', stab: '\x1b[Z', enter: '\r',
  ctrlc: '\x03', ctrld: '\x04', ctrll: '\x0c',
  up: 'A', down: 'B', right: 'C', left: 'D',
  pgup: '\x1b[5~', pgdn: '\x1b[6~',
};

const THEME = {
  background: '#0b0d12', foreground: '#d9dee8', cursor: '#e0825f', cursorAccent: '#0b0d12',
  selectionBackground: 'rgba(224,130,95,0.32)',
  black: '#1c1f29', red: '#f07178', green: '#a6da95', yellow: '#eed49f',
  blue: '#8aadf4', magenta: '#c6a0f6', cyan: '#8bd5ca', white: '#cad3f5',
  brightBlack: '#5b6178', brightRed: '#ff8b92', brightGreen: '#bdf2ab', brightYellow: '#ffe2ad',
  brightBlue: '#a6c3ff', brightMagenta: '#dcbcff', brightCyan: '#a5efe4', brightWhite: '#ffffff',
};

// ================= auth =================

let token = store.get('token', null);

async function login(password) {
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Login failed');
  return body.token;
}

async function tokenValid() {
  try { return (await fetch('/api/me', { headers: { authorization: 'Bearer ' + token } })).ok; }
  catch { return true; } // network trouble isn't proof the token is bad
}

function showLogin(msg = '') {
  disconnect();
  token = null; store.del('token');
  $('#termview').hidden = true;
  hidePicker();
  $('#login').hidden = false;
  $('#login-error').textContent = msg;
  setTimeout(() => $('#password').focus(), 50);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  btn.disabled = true; btn.textContent = 'Unlocking…';
  try {
    token = await login($('#password').value);
    store.set('token', token);
    $('#password').value = '';
    openTerminal();
  } catch (err) {
    $('#login-error').textContent = err.message;
    const card = $('.card');
    card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  } finally {
    btn.disabled = false; btn.textContent = 'Unlock';
  }
});

$('#reveal').addEventListener('click', () => {
  const p = $('#password');
  p.type = p.type === 'password' ? 'text' : 'password';
  p.focus();
});

// ================= terminal =================

let term, fit, ws;
let retry = 0, retryTimer = null, wantConnected = false;
let fontSize = store.get('fontSize', isTouch ? 12 : 14);

async function createTerminal() {
  if (term) return;
  await Promise.race([
    Promise.all([document.fonts.load(`${fontSize}px "JetBrains Mono"`), document.fonts.load(`bold ${fontSize}px "JetBrains Mono"`)]),
    new Promise((r) => setTimeout(r, 1500)),
  ]).catch(() => {});

  term = new Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
    fontSize, lineHeight: 1.15, letterSpacing: 0,
    theme: THEME, cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2,
    scrollback: 5000, allowProposedApi: true, macOptionIsMeta: true,
    smoothScrollDuration: 0, drawBoldTextInBrightColors: false,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';
  term.open($('#term'));
  // DOM renderer by default: crisp native text and works everywhere. ?webgl opts into the GPU renderer.
  if (new URLSearchParams(location.search).has('webgl')) try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch { /* DOM renderer fallback */ }

  term.onData((d) => sendInput(d));
  term.onBinary((d) => sendInput(d));

  // On phones, tapping the terminal shouldn't pop the keyboard; use compose or the ⌨ toggle.
  if (isTouch) setDirectTyping(false);

  new ResizeObserver(() => scheduleFit()).observe($('#term'));
  installTouchScroll();
  applyFontSize();
}

let fitTimer;
function scheduleFit() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(doFit, 60);
}
function doFit() {
  if (!term || $('#termview').hidden) return;
  try { fit.fit(); } catch { return; }
  sendResize();
}
function sendResize() {
  send({ t: 'resize', cols: term.cols, rows: term.rows });
}

function applyFontSize() {
  fontSize = Math.max(8, Math.min(24, fontSize));
  store.set('fontSize', fontSize);
  $('#font-size').textContent = fontSize;
  if (term) { term.options.fontSize = fontSize; scheduleFit(); }
}

// Touch scrolling (xterm's own touch handling is limited). With local scrollback we scroll
// the viewport; full-screen apps (alt screen, e.g. Claude Code) have none, so we feed xterm a
// synthetic wheel event instead and it does what a desktop terminal would: a mouse-wheel report
// when the app tracks the mouse, otherwise up/down arrows.
function installTouchScroll() {
  const el = $('#term');
  let ptX = 0, ptY = 0, lastY = null, acc = 0, velocity = 0, lastT = 0, raf = null;
  const lineH = () => (term._core?._renderService?.dimensions?.css?.cell?.height) || fontSize * 1.15;
  const localScrollback = () => term.buffer.active.type === 'normal' && term.modes.mouseTrackingMode === 'none';
  const scrollBy = (px) => {
    if (!localScrollback()) {
      term.element.dispatchEvent(new WheelEvent('wheel', {
        deltaY: px, deltaMode: WheelEvent.DOM_DELTA_PIXEL, clientX: ptX, clientY: ptY,
        bubbles: true, cancelable: true,
      }));
      return;
    }
    acc += px;
    const lines = Math.trunc(acc / lineH());
    if (lines) { term.scrollLines(lines); acc -= lines * lineH(); }
  };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    cancelAnimationFrame(raf);
    ptX = e.touches[0].clientX; ptY = lastY = e.touches[0].clientY;
    lastT = performance.now(); velocity = 0; acc = 0;
  }, { passive: true, capture: true });
  el.addEventListener('touchmove', (e) => {
    if (lastY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY, now = performance.now();
    const dy = lastY - y;
    velocity = dy / Math.max(1, now - lastT);
    ptX = e.touches[0].clientX; ptY = lastY = y; lastT = now;
    scrollBy(dy);
    e.preventDefault(); e.stopPropagation();
  }, { passive: false, capture: true });
  el.addEventListener('touchend', () => {
    lastY = null;
    const glide = () => {
      velocity *= 0.95;
      if (Math.abs(velocity) < 0.02) return;
      scrollBy(velocity * 16);
      raf = requestAnimationFrame(glide);
    };
    raf = requestAnimationFrame(glide);
  }, { passive: true, capture: true });
}

// ================= connection =================

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function sendInput(d) {
  if (!d) return;
  send({ t: 'in', d });
}

function connect() {
  clearTimeout(retryTimer);
  wantConnected = true;
  setState('wait', 'connecting');
  showBanner('Connecting…');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws/client?token=${encodeURIComponent(token)}&session=${encodeURIComponent(sessionId)}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  let opened = false;

  sock.onopen = () => {
    opened = true; retry = 0;
    doFit();
  };
  sock.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) return term.write(new Uint8Array(e.data), liftSoon);
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.t === 'status') onStatus(msg);
    else if (msg.t === 'reset') { term.reset(); doFit(); }
  };
  sock.onclose = async (e) => {
    if (ws !== sock || !wantConnected) return;
    if (e.code === 4404) {
      disconnect();
      forgetSession();
      return showPicker({ auto: true, note: 'That session has ended.' });
    }
    if (!opened && !(await tokenValid())) return showLogin('Session expired. Sign in again.');
    setState('off', 'offline');
    const delay = Math.min(10_000, 400 * 2 ** retry++);
    showBanner(`Disconnected · retrying in ${Math.ceil(delay / 1000)}s`);
    retryTimer = setTimeout(connect, delay);
  };
}

function disconnect() {
  wantConnected = false;
  clearTimeout(retryTimer);
  ws?.close();
  ws = null;
}

let meta = null;
function onStatus(msg) {
  meta = msg.meta;
  if (msg.host) {
    hideBanner();
    setState('on', sessionLabel(meta));
  } else {
    setState('wait', 'host away');
    showBanner('Host disconnected · waiting for it to come back', true);
  }
  $('#menu-head').innerHTML = meta
    ? `<b>${esc(sessionLabel(meta))}</b><br>${esc(meta.cmd || '')}<br>${esc(meta.hostname || '')} · ${msg.clients} viewer${msg.clients === 1 ? '' : 's'}`
    : 'No host connected';
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const baseName = (p) => (p || '').replace(/\/+$/, '').split('/').pop() || p || '';
function sessionLabel(m) {
  return m?.name || baseName(m?.cwd) || m?.cmd || 'session';
}
function ago(t) {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// visibility: reconnect immediately when the phone comes back to the tab
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantConnected && ws?.readyState !== WebSocket.OPEN) connect();
});

// ================= HUD =================

function setState(state, text) {
  $('#status .dot').dataset.state = state;
  $('#status-text').textContent = text;
}
function showBanner(html, steady = false) {
  $('#banner-text').innerHTML = html;
  $('#banner .spinner').hidden = steady;
  $('#banner').hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }

let idleTimer;
function wakeHud() {
  $('#hud').classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => $('#hud').classList.add('idle'), 3000);
}
['pointerdown', 'keydown'].forEach((ev) => addEventListener(ev, wakeHud, { passive: true }));

const menu = $('#menu');
function toggleMenu(open = menu.hidden) {
  menu.hidden = !open;
  $('#status').setAttribute('aria-expanded', open);
}
$('#status').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !$('#hud').contains(e.target)) toggleMenu(false); });

let keysOn = store.get('keys', isTouch);
function applyKeys() {
  document.body.classList.toggle('no-keys', !keysOn);
  $('#keys-switch').classList.toggle('on', keysOn);
  store.set('keys', keysOn);
}

const canFullscreen = !!document.documentElement.requestFullscreen;
$('#fs-item').hidden = !canFullscreen;
document.addEventListener('fullscreenchange', () => {
  $('#fs-item').firstChild.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
});

menu.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'font+') { fontSize++; applyFontSize(); return; }
  if (act === 'font-') { fontSize--; applyFontSize(); return; }
  toggleMenu(false);
  if (act === 'sessions') showPicker();
  if (act === 'keys') { keysOn = !keysOn; applyKeys(); }
  if (act === 'fullscreen') {
    document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
  }
  if (act === 'redraw') { term.clear(); sendInput('\x0c'); }
  if (act === 'logout') showLogin();
});

// ================= key bar =================

$('#keybar .keys').addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus where it is
$('#keybar .keys').addEventListener('click', (e) => {
  const key = e.target.closest('[data-key]')?.dataset.key;
  if (!key) return;
  let seq = KEYS[key];
  if (seq.length === 1 && 'ABCD'.includes(seq)) {
    seq = (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + seq;
  }
  navigator.vibrate?.(6);
  sendInput(seq);
});

let direct = !isTouch;
function setDirectTyping(on) {
  direct = on;
  const ta = term?.textarea;
  if (ta) {
    ta.setAttribute('inputmode', on ? 'text' : 'none');
    if (on) ta.focus(); else ta.blur();
  }
  $('#kbd').setAttribute('aria-pressed', on && isTouch);
}
$('#kbd').addEventListener('pointerdown', (e) => e.preventDefault());
$('#kbd').addEventListener('click', () => setDirectTyping(!direct));

// ================= compose sheet =================

const sheet = $('#sheet'), compose = $('#compose'), scrim = $('#scrim');
const autoEnter = $('#auto-enter');
autoEnter.checked = store.get('autoEnter', true);
autoEnter.addEventListener('change', () => store.set('autoEnter', autoEnter.checked));
compose.value = store.get('draft', '');

function openCompose() {
  if (isTouch) setDirectTyping(false);
  document.body.classList.add('composing');
  sheet.setAttribute('aria-hidden', 'false');
  scrim.hidden = false;
  autosize();
  compose.focus({ preventScroll: true });
}
function closeCompose() {
  stopMic();
  document.body.classList.remove('composing');
  sheet.setAttribute('aria-hidden', 'true');
  scrim.hidden = true;
  updateLift();
  compose.blur();
  if (!isTouch) term?.focus();
}
function autosize() {
  compose.style.height = 'auto';
  compose.style.height = Math.min(compose.scrollHeight + 2, innerHeight * 0.4) + 'px';
  updateLift();
}

let liftQueued = false;
function liftSoon() {
  if (liftQueued || !document.body.classList.contains('composing')) return;
  liftQueued = true;
  requestAnimationFrame(() => { liftQueued = false; updateLift(); });
}

// While composing, slide the terminal up (without resizing the PTY) so its
// bottom rows - where the prompt usually is - stay visible above the sheet.
function updateLift() {
  let lift = 0;
  if (document.body.classList.contains('composing')) {
    const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb')) || 0;
    const sheetTop = innerHeight - kb - sheet.offsetHeight - (isTouch ? 0 : 24);
    const screen = term.element.querySelector('.xterm-screen').getBoundingClientRect();
    const cellH = screen.height / term.rows;
    const cursorBottom = screen.top + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lift')) || 0)
      + (term.buffer.active.cursorY + 1) * cellH;
    lift = Math.max(0, cursorBottom - sheetTop + cellH);
  }
  document.documentElement.style.setProperty('--lift', lift + 'px');
}

function submitCompose() {
  const text = compose.value;
  if (!text && !autoEnter.checked) return;
  // term.paste wraps in bracketed-paste markers when the app asked for them,
  // so multi-line prompts land as one block instead of being submitted line by line.
  if (text) term.paste(text);
  if (autoEnter.checked) setTimeout(() => sendInput('\r'), text ? 30 : 0);
  compose.value = '';
  store.set('draft', '');
  autosize();
  navigator.vibrate?.(10);
  if (!isTouch) closeCompose();
}

$('#fab').addEventListener('click', openCompose);
scrim.addEventListener('click', closeCompose);
$('#send').addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard up
$('#send').addEventListener('click', submitCompose);
compose.addEventListener('input', () => { autosize(); store.set('draft', compose.value); });
compose.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!isTouch && !e.shiftKey))) { e.preventDefault(); submitCompose(); }
  if (e.key === 'Escape') { e.preventDefault(); closeCompose(); }
});
addEventListener('keydown', (e) => {
  // Ctrl/Cmd+K opens compose on desktop.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !document.body.classList.contains('composing')) {
    e.preventDefault(); e.stopPropagation(); openCompose();
  }
}, true);

// Swipe the sheet down to dismiss.
{
  let startY = null;
  $('.grip').parentElement.addEventListener('touchstart', (e) => {
    if (e.target === compose) return;
    startY = e.touches[0].clientY;
  }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (startY !== null && e.changedTouches[0].clientY - startY > 50) closeCompose();
    startY = null;
  }, { passive: true });
}

// ================= voice =================

const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
if (Speech && isSecureContext) {
  $('#mic').hidden = false;
  $('#mic').addEventListener('pointerdown', (e) => e.preventDefault());
  $('#mic').addEventListener('click', () => (rec ? stopMic() : startMic()));
}
function startMic() {
  rec = new Speech();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  const base = compose.value ? compose.value.replace(/\s*$/, ' ') : '';
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    compose.value = base + finalText + interim;
    autosize();
  };
  rec.onend = () => { rec = null; $('#mic').classList.remove('live'); store.set('draft', compose.value); };
  rec.onerror = () => rec?.stop();
  rec.start();
  $('#mic').classList.add('live');
  navigator.vibrate?.(15);
}
function stopMic() { rec?.stop(); }

// ================= viewport (mobile keyboard) =================

// The terminal keeps a stable size while composing; the sheet rides on top of the keyboard.
function onViewport() {
  const vv = visualViewport;
  const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
  document.body.classList.toggle('kb-open', kb > 80);
  document.documentElement.style.setProperty('--kb', kb + 'px');
  // In direct-typing mode, shrink the terminal so the cursor stays above the keyboard.
  const h = direct && isTouch ? vv.height : innerHeight;
  document.documentElement.style.setProperty('--app-h', h + 'px');
  updateLift();
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', onViewport);
  visualViewport.addEventListener('scroll', onViewport);
}
addEventListener('resize', onViewport);

// ================= boot =================

async function openTerminal() {
  $('#login').hidden = true;
  $('#termview').hidden = false;
  applyKeys();
  await createTerminal();
  onViewport();
  doFit();
  wakeHud();
  // Rejoin the last session if it's still running, go straight in if there's only one, otherwise ask.
  const list = await fetchSessions();
  if (!list) return;
  const pick = list.find((x) => x.id === sessionId) || (list.length === 1 ? list[0] : null);
  if (pick) attach(pick.id); else showPicker({ auto: true, list });
}

// ================= sessions =================

let sessionId = store.get('session', null);
let pickerTimer = null, pickerAuto = false;

function forgetSession() { sessionId = null; store.del('session'); }

async function fetchSessions() {
  try {
    const res = await fetch('/api/sessions', { headers: { authorization: 'Bearer ' + token } });
    if (res.status === 401) { showLogin('Session expired. Sign in again.'); return null; }
    const { sessions } = await res.json();
    $('#session-count').textContent = sessions.length > 1 ? sessions.length : '';
    return sessions;
  } catch { return []; }
}

function attach(id) {
  hidePicker();
  if (id === sessionId && ws) return;
  disconnect();
  sessionId = id; store.set('session', id);
  meta = null;
  term.reset();
  if (!isTouch) term.focus();
  connect();
}

// auto: opened because there was nothing to attach to; it attaches by itself once exactly one session exists.
async function showPicker({ auto = false, note = '', list = null } = {}) {
  pickerAuto = auto;
  $('#picker-note').textContent = note;
  $('#picker-close').hidden = !sessionId;
  $('#picker').hidden = false;
  clearInterval(pickerTimer);
  pickerTimer = setInterval(refreshPicker, 2500);
  renderSessions(list || await fetchSessions());
}
function hidePicker() {
  clearInterval(pickerTimer);
  $('#picker').hidden = true;
}
async function refreshPicker() {
  if ($('#picker').hidden || document.visibilityState !== 'visible') return;
  const list = await fetchSessions();
  if (!list || $('#picker').hidden) return;
  if (pickerAuto && !sessionId && list.length === 1) return attach(list[0].id);
  renderSessions(list);
}

function renderSessions(list) {
  if (!list) return;
  const box = $('#session-list');
  if (!list.length) {
    box.innerHTML = '<div class="empty">No sessions running.</div>';
    return;
  }
  box.innerHTML = list.map((x) => `
    <button class="session" data-id="${esc(x.id)}" aria-current="${x.id === sessionId}">
      <span class="dot" data-state="${x.host ? 'on' : 'wait'}"></span>
      <span class="s-main"><b>${esc(sessionLabel(x))}</b><small>${esc(x.cmd || '')} · ${esc(x.cwd || '')}</small></span>
      <span class="s-meta">${ago(x.created)}<br>${x.host ? plural(x.clients, 'viewer') : 'host away'}</span>
    </button>`).join('');
}

$('#session-list').addEventListener('click', (e) => {
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id) attach(id);
});
$('#picker-close').addEventListener('click', () => { hidePicker(); if (!isTouch) term?.focus(); });

if (token) openTerminal(); else showLogin();
