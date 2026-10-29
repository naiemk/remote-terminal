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
    scrollback: 5000, allowProposedApi: true, macOptionIsMeta: true, macOptionClickForcesSelection: true,
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
  term.attachCustomKeyEventHandler(clipboardKeys);

  // On phones, tapping the terminal shouldn't pop the keyboard; use compose or the ⌨ toggle.
  if (isTouch) setDirectTyping(false);

  new ResizeObserver(() => scheduleFit()).observe($('#term'));
  installScrolling();
  installSelection();
  // ?debug exposes internals to the end-to-end tests.
  if (location.search.includes('debug')) window.__rt = { term, cellAt, get sel() { return sel; }, get scrollPx() { return scrollPx; }, get shift() { return shiftApplied; } };
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

// ================= scrolling =================
//
// xterm only scrolls a whole line at a time and has no native touch scrolling, which feels
// wrong on a phone. So the terminal's position is kept in pixels: xterm shows the line at the
// top of the view, and the screen is shifted by the leftover pixels. On touch devices an
// invisible, natively scrolling layer sits on top, so a swipe gets the browser's own scrolling,
// momentum and bounce. On a computer, the wheel and trackpad drive the same pixel position.
//
// Full-screen apps (alt screen, e.g. less or Codex) and apps that track the mouse have no
// local history: the same gestures become mouse-wheel input for the app (xterm turns that into
// a wheel report, or arrow keys).

const BIG = 200_000; // spacer height while the gestures go to an app
let scroller, spacer, screenEl;
let scrollPx = 0;          // where the view is, in pixels from the top of the history
let ourLine = -1;          // the line we last scrolled xterm to (its scroll events for it are ours)
let echoTop = null;        // scroll events from setting the layer's position ourselves
let touching = false;
let lastTop = 0, wheelAcc = 0;
let pendingShift = 0, shiftApplied = 0;

const cellH = () => term._core?._renderService?.dimensions?.css?.cell?.height || screenEl.offsetHeight / term.rows || fontSize * 1.15;
// History scrolls locally, unless the app has the alt screen or the mouse.
const localHistory = () => term.buffer.active.type === 'normal' && term.modes.mouseTrackingMode === 'none';
const maxPx = () => term.buffer.active.baseY * cellH();
const atBottom = () => term.buffer.active.viewportY >= term.buffer.active.baseY && Math.abs(shiftApplied) < 0.5;

function installScrolling() {
  screenEl = term.element.querySelector('.xterm-screen');

  // Move the terminal to `px`: whole lines through xterm, the rest as a pixel shift.
  // Past either end (iOS bounce) the shift just keeps going, like a native page.
  term.onRender(() => { applyShift(); placeSelectionUi(); }); // after xterm drew the new line, in the same frame
  term.onScroll((y) => {
    if (y === ourLine) return;
    // xterm moved by itself (output while at the bottom, typing, trimmed history): follow it.
    scrollPx = term.buffer.active.viewportY * cellH();
    pendingShift = 0; applyShift();
    syncScroller();
  });
  term.onWriteParsed(() => syncScroller());
  term.onResize(() => { scrollPx = term.buffer.active.viewportY * cellH(); pendingShift = 0; applyShift(); syncScroller(); });
  term.buffer.onBufferChange(() => { pendingShift = 0; applyShift(); syncScroller(true); });

  // Wheel and trackpad (and mice on tablets).
  let target = null, raf = 0;
  $('#term').addEventListener('wheel', (e) => {
    if (!localHistory() || e.shiftKey || e.ctrlKey) return; // apps get xterm's own wheel handling
    e.preventDefault(); e.stopPropagation();
    const unit = e.deltaMode === 1 ? cellH() : e.deltaMode === 2 ? cellH() * term.rows : 1;
    const dy = e.deltaY * unit;
    // Trackpads send small steps: follow them exactly. Mouse wheels jump: glide there.
    if (Math.abs(dy) < 40 && target === null) return moveTo(scrollPx + dy);
    target = Math.max(0, Math.min(maxPx(), (target ?? scrollPx) + dy));
    cancelAnimationFrame(raf);
    const glide = () => {
      const d = target - scrollPx;
      if (Math.abs(d) < 0.5) { moveTo(target); target = null; return; }
      moveTo(scrollPx + d * 0.3);
      raf = requestAnimationFrame(glide);
    };
    raf = requestAnimationFrame(glide);
  }, { passive: false, capture: true });

  if (!isTouch) return;

  scroller = document.createElement('div');
  scroller.className = 'scroller';
  spacer = document.createElement('div');
  scroller.append(spacer);
  $('#term').append(scroller);

  scroller.addEventListener('touchstart', () => { touching = true; syncScroller(true); }, { passive: true });
  scroller.addEventListener('touchend', () => { touching = false; }, { passive: true });
  scroller.addEventListener('touchcancel', () => { touching = false; }, { passive: true });
  scroller.addEventListener('scroll', () => {
    const top = scroller.scrollTop;
    if (echoTop !== null && Math.abs(top - echoTop) < 1) { echoTop = null; return; }
    echoTop = null;
    if (scroller.dataset.mode === 'history') return moveTo(top, true);
    // App mode: turn the movement into wheel lines for the app.
    wheelAcc += top - lastTop;
    lastTop = top;
    const lines = Math.trunc(wheelAcc / cellH());
    if (!lines) return;
    wheelAcc -= lines * cellH();
    const r = screenEl.getBoundingClientRect();
    screenEl.dispatchEvent(new WheelEvent('wheel', { // xterm listens on the screen, not its root
      deltaY: lines, deltaMode: WheelEvent.DOM_DELTA_LINE, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      bubbles: true, cancelable: true,
    }));
  }, { passive: true });
  // Taps select text (see selection below); in ⌨ mode they also keep the keyboard up.
  scroller.addEventListener('click', (e) => { onTap(e); if (direct) term.focus(); });
}

function moveTo(px, fromScroller = false) {
  const h = cellH(), max = maxPx();
  if (Math.abs(px - max) < 0.5) px = max; // the bottom is exactly the bottom
  scrollPx = px;
  const line = Math.max(0, Math.min(term.buffer.active.baseY, Math.floor(Math.max(0, Math.min(max, px)) / h + 1e-6)));
  pendingShift = px - line * h;
  if (Math.abs(pendingShift) < 0.25) pendingShift = 0;
  if (line !== term.buffer.active.viewportY) {
    ourLine = line;
    term.scrollToLine(line); // the shift is applied when xterm renders the new line
  } else {
    applyShift();
  }
  if (!fromScroller) syncScroller();
}

function applyShift() {
  if (!screenEl || pendingShift === shiftApplied) return;
  shiftApplied = pendingShift;
  screenEl.style.transform = shiftApplied ? `translateY(${-shiftApplied}px)` : '';
  $('#term').classList.toggle('scrolled', !atBottom());
  placeSelectionUi();
}

// Keep the native layer the right size and, unless a finger is on it, at the right place.
function syncScroller(force = false) {
  $('#term').classList.toggle('scrolled', !atBottom());
  if (!scroller) return;
  const history = localHistory();
  const mode = history ? 'history' : 'app';
  if (scroller.dataset.mode !== mode) { scroller.dataset.mode = mode; force = true; }
  if (history) {
    spacer.style.height = scroller.clientHeight + maxPx() + 'px';
    const want = Math.round(scrollPx);
    if (!touching && Math.abs(scroller.scrollTop - want) > 1) setTop(want);
  } else if (force) {
    // Park in the middle at the start of each touch, so a fling never hits an end.
    spacer.style.height = BIG + 'px';
    setTop(BIG / 2);
    lastTop = scroller.scrollTop;
    wheelAcc = 0;
  }
}

function setTop(v) {
  scroller.scrollTop = v;
  echoTop = scroller.scrollTop;
}

// ================= selection =================
//
// Phones: tap a word to select it, tap three times for the whole paragraph, then drag the
// handles at either end to change it. The view scrolls when a handle gets near the top or
// bottom. The bar above the selection copies it. Computers: xterm's own mouse selection
// (drag, double-click a word) plus triple-click for the paragraph.

const DEFAULT_SEPARATORS = ' ()[]{}\',"`';
let sel = null;                  // { start: {row, col}, end: {row, col} }: buffer rows, end exclusive
let taps = { n: 0, t: 0, x: 0, y: 0 };
let dragging = null;             // { which: 'start' | 'end', x, y } while a handle is held

function cellAt(x, y) {
  const r = screenEl.getBoundingClientRect(), buf = term.buffer.active;
  const col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - r.left) / (r.width / term.cols))));
  const row = buf.viewportY + Math.floor((y - r.top) / cellH());
  return { col, row: Math.max(0, Math.min(buf.length - 1, row)) };
}

// A row together with the rows it wraps onto, as one string of `cols`-wide pieces.
function logicalLine(row) {
  const buf = term.buffer.active;
  let start = row, end = row;
  while (start > 0 && buf.getLine(start)?.isWrapped) start--;
  while (buf.getLine(end + 1)?.isWrapped) end++;
  let text = '';
  for (let r = start; r <= end; r++) text += (buf.getLine(r)?.translateToString(false) ?? '').padEnd(term.cols).slice(0, term.cols);
  return { start, end, text };
}
const posIn = (line, i) => ({ row: line.start + Math.floor(i / term.cols), col: i % term.cols });
const indexIn = (line, cell) => (cell.row - line.start) * term.cols + cell.col;
const isWordChar = (ch) => !!ch && !/\s/.test(ch) && !(term.options.wordSeparator ?? DEFAULT_SEPARATORS).includes(ch);

function selectWord(cell) {
  const line = logicalLine(cell.row), i = indexIn(line, cell);
  if (!isWordChar(line.text[i])) return false;
  let a = i, b = i + 1;
  while (a > 0 && isWordChar(line.text[a - 1])) a--;
  while (b < line.text.length && isWordChar(line.text[b])) b++;
  setSelection(posIn(line, a), posIn(line, b));
  return true;
}

// Consecutive non-blank lines around the cell.
function selectParagraph(cell, ui = true) {
  const blank = (l) => !l.text.trim();
  let first = logicalLine(cell.row);
  if (blank(first)) return false;
  let last = first;
  for (let l; first.start > 0 && !blank(l = logicalLine(first.start - 1));) first = l;
  for (let l; last.end < term.buffer.active.length - 1 && !blank(l = logicalLine(last.end + 1));) last = l;
  setSelection({ row: first.start, col: 0 }, posIn(last, last.text.trimEnd().length), ui);
  return true;
}

function setSelection(a, b, ui = true) {
  if (a.row > b.row || (a.row === b.row && a.col > b.col)) [a, b] = [b, a];
  const length = (b.row - a.row) * term.cols + b.col - a.col;
  if (length <= 0) return;
  sel = ui ? { start: a, end: b } : null;
  term.select(a.col, a.row, length);
  placeSelectionUi();
}

function clearSelection() {
  sel = null;
  term.clearSelection();
  placeSelectionUi();
}

function onTap(e) {
  const now = performance.now();
  const again = now - taps.t < 450 && Math.hypot(e.clientX - taps.x, e.clientY - taps.y) < 30;
  taps = { n: Math.max(e.detail || 1, again ? taps.n + 1 : 1), t: now, x: e.clientX, y: e.clientY };
  const cell = cellAt(e.clientX, e.clientY);
  if (taps.n >= 3) { selectParagraph(cell); return; }
  if (taps.n === 1 && !selectWord(cell)) clearSelection();
}

// Handles and the copy bar follow the selection as the terminal scrolls.
function placeSelectionUi() {
  const handles = [$('#sel-start'), $('#sel-end')], bar = $('#sel-bar');
  if (!sel || !screenEl) { handles.forEach((h) => (h.hidden = true)); bar.hidden = true; return; }
  const t = $('#term').getBoundingClientRect(), r = screenEl.getBoundingClientRect();
  const cw = r.width / term.cols, h = cellH(), top = r.top - t.top, left = r.left - t.left;
  const vY = term.buffer.active.viewportY;
  const sx = left + sel.start.col * cw, sy = top + (sel.start.row - vY) * h;
  const ex = left + sel.end.col * cw, ey = top + (sel.end.row - vY + 1) * h;
  const visible = (y) => y > -h && y < t.height + h;
  place(handles[0], sx, sy, visible(sy + h));
  place(handles[1], ex, ey - h, visible(ey - h)); // its caret covers the last selected row
  // The bar sits above the selection, or below it when there's no room.
  bar.hidden = false;
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  const by = sy - bh - 14 > 8 ? sy - bh - 14 : Math.min(ey + 22, t.height - bh - 8);
  bar.style.transform = `translate(${Math.max(8, Math.min(t.width - bw - 8, (sx + ex) / 2 - bw / 2))}px, ${Math.max(8, by)}px)`;
  function place(el, x, y, show) {
    el.hidden = !show;
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.style.height = h + 'px';
  }
}

function installSelection() {
  // Desktop: triple-click selects the paragraph (xterm's own would select just the line).
  term.element.addEventListener('mouseup', (e) => {
    if (e.detail === 3 && e.button === 0) setTimeout(() => selectParagraph(cellAt(e.clientX, e.clientY), false));
  });
  // Selections xterm drops on its own (new output over it, buffer switch) take the UI with them.
  term.onSelectionChange(() => { if (sel && !term.hasSelection()) { sel = null; placeSelectionUi(); } });

  $('#sel-copy').addEventListener('click', () => { copyText(term.getSelection()); clearSelection(); });
  $('#sel-all').addEventListener('click', () => {
    const buf = term.buffer.active, last = buf.length - 1;
    setSelection({ row: 0, col: 0 }, posIn(logicalLine(last), logicalLine(last).text.trimEnd().length));
  });

  for (const which of ['start', 'end']) {
    const el = $(`#sel-${which}`);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      dragging = { which, x: e.clientX, y: e.clientY };
      autoScroll();
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dragging.x = e.clientX; dragging.y = e.clientY;
      dragHandle();
    });
    const stop = () => { dragging = null; };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  }
}

// The start knob sits above the text and the end knob below it, so aim a little away from the
// finger: it lands on the text the handle points at, not under the fingertip.
function dragHandle() {
  if (!dragging || !sel) return;
  const h = cellH();
  const cell = cellAt(dragging.x, dragging.y + (dragging.which === 'start' ? h * 0.7 : -h * 0.7));
  let { start, end } = sel;
  if (dragging.which === 'start') start = cell;
  else end = { row: cell.row, col: cell.col + 1 };
  // Dragged past the other end: they swap roles.
  if (start.row > end.row || (start.row === end.row && start.col >= end.col)) {
    [start, end] = dragging.which === 'start' ? [sel.end, { row: cell.row, col: cell.col + 1 }] : [cell, sel.start];
    dragging.which = dragging.which === 'start' ? 'end' : 'start';
  }
  setSelection(start, end);
}

// Near the top or bottom edge, keep scrolling while the handle is held there.
function autoScroll() {
  if (!dragging) return;
  const t = $('#term').getBoundingClientRect(), edge = 48;
  const over = dragging.y < t.top + edge ? dragging.y - (t.top + edge) : dragging.y > t.bottom - edge ? dragging.y - (t.bottom - edge) : 0;
  if (over && localHistory()) {
    moveTo(Math.max(0, Math.min(maxPx(), scrollPx + over * 0.25)));
    dragHandle();
  }
  requestAnimationFrame(autoScroll);
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
  const sock = new WebSocket(`${proto}//${location.host}/ws?id=${encodeURIComponent(instanceId)}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;

  sock.onopen = () => {
    retry = 0;
    doFit();
  };
  // The server starts every connection by replaying the scrollback, so after a reconnect
  // clear what's already on screen first, or everything shows up twice.
  let replay = true;
  sock.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      if (replay) { replay = false; term.reset(); }
      return term.write(new Uint8Array(e.data), liftSoon);
    }
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.t === 'status') onStatus(msg);
  };
  sock.onclose = (e) => {
    if (ws !== sock || !wantConnected) return;
    if (e.code === 4404) {
      const name = meta ? nameOf(meta) : 'The instance';
      disconnect();
      instanceId = null;
      return showHome({ note: e.reason === 'no such instance' ? `${name} is no longer running.` : `${name} ${e.reason}.` });
    }
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
  meta = msg;
  hideBanner();
  setState('on', nameOf(msg));
  if (!$('#mh-name input')) $('#mh-program').textContent = nameOf(msg);
  $('#mh-viewers').textContent = plural(msg.clients, 'viewer');
  $('#mh-where').textContent = msg.name ? `${msg.program || msg.command} · ${whereOf(msg)}` : whereOf(msg);
  $('.mh-scratch').hidden = !msg.scratch; // an older server has no scratch folders
  markOldServer(!msg.scratch);
  $('#mh-scratch').textContent = msg.scratchName || '';
  $('#mh-scratch').title = msg.scratch || '';
  if ($('#home').hidden) document.title = `${nameOf(msg)} · ${lastTwo(whereOf(msg))}`;
}

// "~/nk/remote-terminal" → "nk/remote-terminal"
const lastTwo = (p = '') => (p === '~' || p === '/' ? p : p.split('/').filter(Boolean).slice(-2).join('/'));
// What to call a terminal: the name the user gave it, or else what runs in it.
const nameOf = (x) => x.name || x.program || x.command;
const whereOf = (x) => x.where || x.cwd || '';
// The line under the name: what runs there (once it has a name of its own) and the folder.
const detailOf = (x) => [x.name ? x.program || x.command : '', lastTwo(whereOf(x))].filter(Boolean).join(' · ');

// Rename a terminal in place: `el` turns into a text field. Enter or leaving it saves, Escape cancels.
// An empty name goes back to showing the program.
let renaming = null;

// A server started before names and folder suggestions existed still serves this page (it reads
// the files from disk). Hide what it can't do, and say so on Home.
function markOldServer(old) {
  document.body.classList.toggle('old-server', old);
  $('#home-upgrade').hidden = !old;
}
function renameInline(el, x, done) {
  const input = document.createElement('input');
  Object.assign(input, { className: 'rename', value: x.name || '', placeholder: x.program || x.command, maxLength: 60, enterKeyHint: 'done', spellcheck: false });
  input.setAttribute('aria-label', `Name for ${nameOf(x)}`);
  input.setAttribute('autocomplete', 'off');
  renaming = x.id;
  el.hidden = true;
  el.after(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (save && name !== (x.name || '')) {
      try { Object.assign(x, await api('PATCH', `/api/instances/${encodeURIComponent(x.id)}`, { name })); }
      catch (err) { toast(err.message === 'not found' ? 'Restart the server to rename terminals' : `Couldn’t rename: ${err.message}`); }
    }
    renaming = null;
    input.remove();
    el.hidden = false;
    done(x);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
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
  if (document.visibilityState !== 'visible') return;
  if (wantConnected && ws?.readyState !== WebSocket.OPEN) connect();
  if (!$('#home').hidden) refreshHome();
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
let menuTimer;
function toggleMenu(open = menu.hidden) {
  menu.hidden = !open;
  $('#status').setAttribute('aria-expanded', open);
  clearInterval(menuTimer);
  if (open) { refreshManager(); refreshUpdate(); refreshMenuTerms(); menuTimer = setInterval(refreshMenuTerms, 2000); }
}

function showTab(tab) {
  for (const b of menu.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', b.dataset.tab === tab);
  for (const p of menu.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  store.set('menuTab', tab);
}
showTab(store.get('menuTab', 'terms'));
menu.querySelector('.tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) showTab(t.dataset.tab); });

const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

// The other terminals, to switch to, copy their scratch path, or open their files.
let terms = [];
async function refreshMenuTerms() {
  try { terms = (await api('GET', '/api/state')).instances; } catch { return; }
  if (meta && !$('#mh-name input')) { const me = terms.find((x) => x.id === instanceId); if (me) onStatus({ ...meta, ...me }); } // renamed elsewhere
  const others = terms.filter((x) => x.id !== instanceId);
  const html = others.length ? others.map((x) => `
    <div class="mt">
      <button class="mt-open" data-switch="${esc(x.id)}">
        <span class="dot" data-state="on"></span>
        <span class="s-main"><b>${esc(nameOf(x))}</b><small>${esc(detailOf(x))} · ${ago(x.created)}</small></span>
      </button>
      ${x.scratch ? `<button class="ghost-icon" data-copy="${esc(x.scratch)}" aria-label="Copy the scratch path of ${esc(nameOf(x))}" title="Copy scratch path">${ICON_COPY}</button>
      <button class="ghost-icon" data-files="${esc(x.scratchName)}" aria-label="Files of ${esc(nameOf(x))}" title="Files">${ICON_FOLDER}</button>` : ''}
    </div>`).join('') : '<div class="empty">No other terminals.</div>';
  const box = $('#menu-terms');
  if (box.dataset.html !== html) box.innerHTML = box.dataset.html = html;
}
$('#menu-terms').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.switch) { toggleMenu(false); attach(b.dataset.switch); }
  if (b.dataset.copy) copyText(b.dataset.copy);
  if (b.dataset.files) { toggleMenu(false); openFiles(b.dataset.files); }
});
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
  if (act === 'copy-scratch') { if (meta) copyText(meta.scratch); return; }
  if (act === 'rename') { if (meta && !$('#mh-name input')) renameInline($('#mh-program'), { ...meta }, (x) => onStatus({ ...meta, ...x })); return; }
  if (act === 'font-') { fontSize--; applyFontSize(); return; }
  toggleMenu(false);
  if (act === 'home') showHome();
  if (act === 'keys') { keysOn = !keysOn; applyKeys(); }
  if (act === 'fullscreen') {
    document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
  }
  if (act === 'redraw') { term.clear(); sendInput('\x0c'); }
  if (act === 'copy') openCopy();
  if (act === 'paste') pasteClipboard();
  if (act === 'files' && meta) openFiles(meta.scratchName);
});

// ================= copy / paste =================

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers / no clipboard permission: copy through a temporary textarea.
    const ta = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
    ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
  navigator.vibrate?.(8);
  toast('Copied');
}

async function pasteClipboard() {
  let text;
  try { text = await navigator.clipboard.readText(); } catch {}
  if (text) { term.paste(text); navigator.vibrate?.(8); return; }
  // Clipboard reads need permission (and HTTPS); fall back to the compose box, where the OS paste works.
  openCompose();
  toast(text === '' ? 'Clipboard is empty' : 'Paste into the box, then send');
}

// The terminal's text: the whole scrollback for a shell, the current screen for full-screen apps.
// Wrapped rows are joined back into their original lines.
function bufferText() {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text; else lines.push(text);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

// Phones can't select inside the terminal (touches scroll it), so show its text in a plain view
// where the OS's own long-press selection and copy menu work.
function openCopy() {
  if (!term) return;
  term.blur();
  const pre = $('#copy-text');
  pre.textContent = bufferText();
  pre.style.fontSize = Math.max(11, fontSize) + 'px';
  $('#copy-all').textContent = 'Copy all';
  $('#copyview').hidden = false;
  // Start where the terminal was looking: the bottom, unless it was scrolled back.
  const buf = term.buffer.active;
  const atBottom = buf.viewportY >= buf.baseY;
  pre.scrollTop = atBottom ? pre.scrollHeight : (buf.viewportY / Math.max(1, buf.length)) * pre.scrollHeight;
}
function closeCopy() {
  getSelection()?.removeAllRanges();
  $('#copyview').hidden = true;
  if (!isTouch) term?.focus();
}
$('#copy-close').addEventListener('click', closeCopy);
$('#copy-all').addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
$('#copy-all').addEventListener('click', () => copyText(selectedCopyText() || $('#copy-text').textContent));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#copyview').hidden) closeCopy(); });
const selectedCopyText = () => {
  const sel = getSelection();
  return sel && !sel.isCollapsed && $('#copy-text').contains(sel.anchorNode) ? sel.toString() : '';
};
document.addEventListener('selectionchange', () => {
  if (!$('#copyview').hidden) $('#copy-all').textContent = selectedCopyText() ? 'Copy selection' : 'Copy all';
});

// Desktop: Ctrl+Shift+C / Cmd+C copy the selection, Ctrl+Shift+V pastes. Plain Ctrl+C stays ^C.
// (Cmd+V goes through the browser's own paste event, which xterm handles.)
function clipboardKeys(e) {
  if (e.type !== 'keydown') return true;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey && e.shiftKey && k === 'c') || (e.metaKey && !e.ctrlKey && k === 'c')) {
    if (term.hasSelection()) copyText(term.getSelection());
    e.preventDefault();
    return false;
  }
  if (e.ctrlKey && e.shiftKey && k === 'v') {
    e.preventDefault();
    pasteClipboard();
    return false;
  }
  return true;
}

// ================= key bar =================

$('#keybar .keys').addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus where it is
$('#keybar .keys').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'copy') return openCopy();
  if (action === 'paste') return pasteClipboard();
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
  $('#termview').hidden = false;
  applyKeys();
  await createTerminal();
  onViewport();
  doFit();
  wakeHud();
  // /#<terminal id> opens that terminal (the manager dashboard links here); otherwise the home screen.
  const id = decodeURIComponent(location.hash.slice(1));
  if (/^[\w-]{1,32}$/.test(id)) { history.replaceState(null, '', location.pathname); attach(id); }
  else showHome();
}

// ================= files: the shared scratch area =================
//
// ~/.remote-terminal-server/scratch, with a folder per terminal (also in $REMOTE_TERM_SCRATCH
// inside it). Upload from this device, download, delete, and copy a folder's path to paste
// into a terminal.

let scratchRoot = '';
let filesPath = '';               // relative to the scratch root
let confirmDelete = null;

const fileUrl = (rel) => `/api/files/download?path=${encodeURIComponent(rel)}`;
const join = (...parts) => parts.filter(Boolean).join('/');
function size(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

async function openFiles(rel = '') {
  filesPath = rel;
  confirmDelete = null;
  $('#files').hidden = false;
  await renderFiles();
}
function closeFiles() { $('#files').hidden = true; }

async function renderFiles() {
  $('#files-error').textContent = '';
  let data;
  try { data = await api('GET', `/api/files?path=${encodeURIComponent(filesPath)}`); }
  catch (err) {
    if (filesPath) { filesPath = filesPath.split('/').slice(0, -1).join('/'); return renderFiles(); } // gone: go up
    $('#files-error').textContent = err.message; return;
  }
  scratchRoot = data.root;
  // At the top, say which terminal each folder belongs to.
  if (!filesPath) try { terms = (await api('GET', '/api/state')).instances; } catch {}
  const owner = (name) => terms.find((x) => x.scratchName === name);
  const t = filesPath && owner(filesPath.split('/')[0]);
  $('#files-name').textContent = filesPath ? (t ? `${nameOf(t)} · ${filesPath}` : filesPath) : 'Shared scratch';
  $('#files-path').textContent = join(scratchRoot, filesPath) + '\u200e'; // LRM: the path is trimmed from the left (rtl) but reads left to right
  $('#files-up').style.visibility = filesPath ? 'visible' : 'hidden';
  $('#files-list').innerHTML = data.entries.length ? data.entries.map((f) => {
    const rel = join(filesPath, f.name), x = !filesPath && f.dir && owner(f.name);
    const info = f.dir ? (filesPath ? 'folder' : x ? `running · ${detailOf(x)}` : 'ended') : `${size(f.size)} · ${ago(f.mtime)}`;
    const open = f.dir
      ? `<button class="f-open dir" data-dir="${esc(rel)}">${ICON_FOLDER}<span class="s-main"><b>${esc(x ? `${nameOf(x)} (${f.name})` : f.name)}</b><small>${esc(info)}</small></span></button>`
      : `<a class="f-open" href="${fileUrl(rel)}" download="${esc(f.name)}">${ICON_FILE}<span class="s-main"><b>${esc(f.name)}</b><small>${esc(info)}</small></span></a>`;
    return `<div class="f-row">${open}
      <button class="ghost-icon" data-copy="${esc(join(scratchRoot, rel))}" aria-label="Copy path" title="Copy path">${ICON_COPY}</button>
      <button class="ghost-icon danger${confirmDelete === rel ? ' confirm' : ''}" data-del="${esc(rel)}" aria-label="Delete ${esc(f.name)}">${confirmDelete === rel ? 'Delete?' : ICON_X}</button>
    </div>`;
  }).join('') : `<div class="empty">${filesPath ? 'Empty. Upload a file, or save one here from the terminal.' : 'No folders yet. Each terminal gets one when it starts.'}</div>`;
}

async function upload(fileList) {
  const list = [...fileList];
  if (!list.length) return;
  for (const [i, file] of list.entries()) {
    toast(list.length > 1 ? `Uploading ${i + 1}/${list.length}…` : `Uploading ${file.name}…`);
    const res = await fetch(`/api/files/upload?path=${encodeURIComponent(filesPath)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
    if (!res.ok) { $('#files-error').textContent = (await res.json().catch(() => ({}))).error || 'Upload failed'; break; }
  }
  toast(list.length > 1 ? `Uploaded ${list.length} files` : 'Uploaded');
  renderFiles();
}

$('#files-list').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.dir) { filesPath = b.dataset.dir; confirmDelete = null; return renderFiles(); }
  if (b.dataset.copy) return copyText(b.dataset.copy);
  if (b.dataset.del) {
    if (confirmDelete !== b.dataset.del) { confirmDelete = b.dataset.del; return renderFiles(); }
    confirmDelete = null;
    try { await api('DELETE', `/api/files?path=${encodeURIComponent(b.dataset.del)}`); } catch (err) { $('#files-error').textContent = err.message; }
    renderFiles();
  }
});
$('#files-up').addEventListener('click', () => { filesPath = filesPath.split('/').slice(0, -1).join('/'); renderFiles(); });
$('#files-close').addEventListener('click', closeFiles);
$('#files').addEventListener('click', (e) => { if (e.target.id === 'files') closeFiles(); });
$('#files-copy').addEventListener('click', () => copyText(join(scratchRoot, filesPath)));
$('#files-input').addEventListener('change', (e) => { upload(e.target.files); e.target.value = ''; });
$('#home-files').addEventListener('click', () => openFiles(''));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#files').hidden) closeFiles(); });
// Desktop: drop files on the panel.
for (const t of ['dragenter', 'dragover']) $('#files').addEventListener(t, (e) => { e.preventDefault(); $('#files').classList.add('dragover'); });
$('#files').addEventListener('dragleave', (e) => { if (e.target.id === 'files') $('#files').classList.remove('dragover'); });
$('#files').addEventListener('drop', (e) => { e.preventDefault(); $('#files').classList.remove('dragover'); upload(e.dataTransfer.files); });

// ================= home: instances + commands =================

let instanceId = null;
let homeTimer = null;
let confirmKill = null, confirmTimer = null; // a kill needs a second tap within 3s
const cwdInput = $('#cwd');
cwdInput.value = store.get('cwd', '');
cwdInput.addEventListener('change', () => store.set('cwd', cwdInput.value.trim()));

// ---- "start in": folder suggestions as you type ----
// Up to 10 folders that match what's typed. Picking one fills it in (ending in "/"), so the
// next level shows right away; keep typing or picking to go deeper.
const cwdList = $('#cwd-list');
let cwdItems = [], cwdActive = -1, cwdSeq = 0, cwdTimer;
const dirs = (q, limit = 10) => api('GET', `/api/dirs?q=${encodeURIComponent(q)}&limit=${limit}`);

async function suggestDirs() {
  const seq = ++cwdSeq;
  let data;
  try { data = await dirs(cwdInput.value); } catch { return closeSuggest(); } // e.g. an older server
  if (seq !== cwdSeq || document.activeElement !== cwdInput) return;
  cwdItems = data.dirs;
  cwdActive = -1;
  if (!cwdItems.length) return closeSuggest();
  cwdList.innerHTML = cwdItems.map((d, i) =>
    `<button type="button" role="option" data-i="${i}" tabindex="-1">${ICON_FOLDER}<span><bdi>${esc(d)}</bdi></span></button>`).join('')
    + (data.total > cwdItems.length ? `<div class="more">${data.total - cwdItems.length} more · keep typing</div>` : '');
  cwdList.hidden = false;
  cwdInput.setAttribute('aria-expanded', 'true');
}
function closeSuggest() {
  clearTimeout(cwdTimer); // typed just before Escape: don't reopen
  cwdSeq++;
  cwdList.hidden = true;
  cwdInput.setAttribute('aria-expanded', 'false');
}
function markActive(i) {
  cwdActive = i;
  cwdList.querySelectorAll('[data-i]').forEach((b) => b.classList.toggle('active', +b.dataset.i === i));
  cwdList.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}
function pickDir(d) {
  cwdInput.value = d;
  store.set('cwd', d);
  cwdInput.focus();
  suggestDirs();
}
cwdInput.addEventListener('input', () => { clearTimeout(cwdTimer); cwdTimer = setTimeout(suggestDirs, 120); });
cwdInput.addEventListener('focus', suggestDirs);
cwdInput.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== cwdInput) closeSuggest(); }, 150));
cwdInput.addEventListener('keydown', (e) => {
  const open = !cwdList.hidden && cwdItems.length;
  if (e.key === 'ArrowDown' && open) { e.preventDefault(); markActive((cwdActive + 1) % cwdItems.length); }
  else if (e.key === 'ArrowUp' && open) { e.preventDefault(); markActive((cwdActive - 1 + cwdItems.length) % cwdItems.length); }
  else if (e.key === 'Tab' && open && !e.shiftKey) { e.preventDefault(); pickDir(cwdItems[Math.max(0, cwdActive)]); }
  else if (e.key === 'Enter' && open && cwdActive >= 0) { e.preventDefault(); pickDir(cwdItems[cwdActive]); }
  else if (e.key === 'Enter') { closeSuggest(); cwdInput.blur(); }
  else if (e.key === 'Escape') { if (open) e.preventDefault(); closeSuggest(); } // also drops a request in flight
});
// pointerdown, not click: keeps the field focused (and the phone keyboard up).
cwdList.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-i]');
  if (!b) return;
  e.preventDefault();
  pickDir(cwdItems[+b.dataset.i]);
});

// ---- "start in": a folder browser ----
let pickerPath = '';
async function openPicker() {
  closeSuggest();
  pickerPath = '~/'; // always start from the home folder
  $('#picker').hidden = false;
  $('#picker-filter').value = '';
  await renderPicker();
}
function closePicker() { $('#picker').hidden = true; }
async function renderPicker() {
  let data;
  try { data = await dirs(pickerPath, 1000); }
  catch (err) { $('#picker-list').innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  if (!data.exists && pickerPath) { pickerPath = ''; return renderPicker(); } // a typo: start from the default folder
  pickerPath = data.path.endsWith('/') ? data.path : data.path + '/';
  $('#picker-name').textContent = lastTwo(data.path) || data.path;
  $('#picker-path').textContent = data.path + '‎';
  $('#picker-up').style.visibility = data.parent ? 'visible' : 'hidden';
  $('#picker-up').dataset.to = data.parent || '';
  const f = $('#picker-filter').value.trim().toLowerCase();
  const names = data.dirs.map((d) => d.slice(0, -1).split('/').pop()).filter((n) => n.toLowerCase().includes(f))
    .sort((a, b) => !a.toLowerCase().startsWith(f) - !b.toLowerCase().startsWith(f)); // "bet": beta before alphabet
  $('#picker-list').innerHTML = names.length ? names.map((n) =>
    `<div class="f-row"><button class="f-open dir" data-enter="${esc(n)}">${ICON_FOLDER}<span class="s-main"><b>${esc(n)}</b></span></button></div>`).join('')
    : `<div class="empty">${f ? 'No folders match.' : 'No folders inside.'}</div>`;
  $('#picker-list').scrollTop = 0;
}
$('#cwd-browse').addEventListener('click', (e) => { e.preventDefault(); openPicker(); });
$('#picker-close').addEventListener('click', closePicker);
$('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker') closePicker(); });
$('#picker-up').addEventListener('click', () => { pickerPath = $('#picker-up').dataset.to + '/'; $('#picker-filter').value = ''; renderPicker(); });
$('#picker-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-enter]');
  if (!b) return;
  pickerPath += b.dataset.enter + '/';
  $('#picker-filter').value = '';
  renderPicker();
});
$('#picker-filter').addEventListener('input', renderPicker);
$('#picker-filter').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = $('#picker-list [data-enter]');
  if (first) first.click();
});
$('#picker-use').addEventListener('click', () => {
  const p = pickerPath.replace(/(.)\/$/, '$1'); // "~/nk/api/" → "~/nk/api"
  cwdInput.value = p;
  store.set('cwd', p);
  closePicker();
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#picker').hidden) closePicker(); });

async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function showHome({ note = '' } = {}) {
  $('#home-note').textContent = note;
  $('#home-error').textContent = '';
  $('#home-close').hidden = !(instanceId && wantConnected);
  $('#home').hidden = false;
  document.title = 'Remote Terminal';
  clearInterval(homeTimer);
  homeTimer = setInterval(() => refreshHome({ poll: true }), 2500);
  await refreshHome();
}
function hideHome() {
  clearInterval(homeTimer);
  $('#home').hidden = true;
}

async function refreshHome({ poll = false } = {}) {
  if ($('#home').hidden || (poll && document.visibilityState !== 'visible')) return;
  let state;
  try { state = await api('GET', '/api/state'); }
  catch { $('#home-error').textContent = 'Can’t reach the server.'; return; }
  if ($('#home').hidden) return;
  if ($('#home-error').textContent === 'Can’t reach the server.') $('#home-error').textContent = '';
  cwdInput.placeholder = state.defaultCwd;
  scratchRoot = state.scratchRoot;
  markOldServer(!state.scratchRoot);
  $('#home-files-path').textContent = state.scratchRoot;
  for (const el of [$('#home-files'), $('.home-files-h')]) el.hidden = !state.scratchRoot; // an older server has no files
  renderInstances(state.instances);
  renderCommands(state.commands, state.manager);
  renderConsoles(state.consoles || [], state.manager);
}

let homeList = [];
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
function renderInstances(list) {
  homeList = list;
  if (renaming) return; // don't wipe the name being typed
  const box = $('#instance-list');
  const confirming = confirmKill;
  const html = list.length ? list.map((x) => `
    <div class="session" aria-current="${x.id === instanceId}">
      <button class="s-open" data-join="${esc(x.id)}">
        <span class="dot" data-state="on"></span>
        <span class="s-main"><b>${esc(nameOf(x))}</b><small>${esc(detailOf(x))}</small></span>
        <span class="s-meta">${ago(x.created)}<br>${plural(x.clients, 'viewer')}</span>
      </button>
      <button class="s-rename" data-rename="${esc(x.id)}" aria-label="Rename ${esc(nameOf(x))}" title="Rename">${ICON_EDIT}</button>
      <button class="s-kill${x.id === confirming ? ' confirm' : ''}" data-kill="${esc(x.id)}" aria-label="Kill ${esc(x.command)}">
        ${x.id === confirming ? 'Kill?' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'}
      </button>
    </div>`).join('') : '<div class="empty">Nothing running. Start something below.</div>';
  if (box.dataset.html !== html) box.innerHTML = box.dataset.html = html; // don't disturb a tap in progress
}

function renderCommands(list, manager) {
  const box = $('#command-list');
  // Claude Manager is a singleton: one button that starts it if needed and opens it, never a second copy.
  const mgrBtn = manager ? `
    <button class="cmd" data-mgr="1"><b>Claude Manager</b><small>${manager.running ? 'running · open dashboard' : 'watches your agents'}</small></button>` : '';
  const html = list.map((c) => `
    <button class="cmd" data-cmd="${esc(c.name)}"><b>${esc(c.name)}</b><small>${esc(c.cmd)}</small></button>`).join('') + mgrBtn;
  if (box.dataset.html !== html) box.innerHTML = box.dataset.html = html; // don't disturb a tap in progress
}

function renderConsoles(list, manager) {
  const box = $('#console-list');
  const row = (href, name, desc, on) => `
    <div class="session"><a class="s-open" href="${esc(href)}" target="_blank" rel="noopener">
      <span class="dot" data-state="${on ? 'on' : 'off'}"></span>
      <span class="s-main"><b>${esc(name)}</b><small>${esc(desc)}</small></span></a></div>`;
  const html = (manager ? row('/manager/', 'Claude Manager', manager.running ? 'running' : 'starts when opened', manager.running) : '')
    + list.map((c) => row(c.url, c.name, c.description || 'web console', true)).join('');
  if (box.dataset.html !== html) box.innerHTML = box.dataset.html = html;
}

function attach(id) {
  hideHome();
  if (id === instanceId && wantConnected) return;
  disconnect();
  instanceId = id;
  meta = null;
  term.reset();
  if (!isTouch) term.focus();
  connect();
}

$('#instance-list').addEventListener('click', async (e) => {
  const ren = e.target.closest('[data-rename]');
  if (ren) {
    const x = homeList.find((y) => y.id === ren.dataset.rename);
    if (x && !renaming) renameInline(ren.closest('.session').querySelector('.s-main b'), x, () => refreshHome());
    return;
  }
  const kill = e.target.closest('[data-kill]');
  if (kill) {
    const id = kill.dataset.kill;
    clearTimeout(confirmTimer);
    if (confirmKill !== id) {
      confirmKill = id;
      kill.classList.add('confirm'); kill.textContent = 'Kill?';
      confirmTimer = setTimeout(() => { confirmKill = null; refreshHome(); }, 3000);
      return refreshHome();
    }
    confirmKill = null;
    kill.disabled = true;
    try { await api('DELETE', `/api/instances/${encodeURIComponent(id)}`); }
    catch (err) { $('#home-error').textContent = err.message; }
    setTimeout(refreshHome, 400);
    return;
  }
  const id = e.target.closest('[data-join]')?.dataset.join;
  if (id) attach(id);
});

$('#command-list').addEventListener('click', async (e) => {
  if (e.target.closest('[data-mgr]')) {
    // Open the tab synchronously (popup rules), then make sure the manager is running.
    const w = window.open('/manager/', '_blank');
    try { await api('POST', '/api/manager', { on: true }); } catch {}
    if (!w) location.href = '/manager/';
    return setTimeout(refreshHome, 600);
  }
  const btn = e.target.closest('[data-cmd]');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  $('#home-error').textContent = '';
  const cwd = cwdInput.value.trim();
  store.set('cwd', cwd);
  try {
    const x = await api('POST', '/api/instances', { command: btn.dataset.cmd, cwd: cwd || undefined });
    attach(x.id);
  } catch (err) {
    $('#home-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#home-close').addEventListener('click', () => { hideHome(); if (!isTouch) term?.focus(); });

store.del('token'); store.del('session'); // left over from the password / rterm days
openTerminal();

// Manager tab: start/stop the manager and open its dashboard (served at /manager/ by this server).
const mgrOpen = $('#mgr-open'), mgrToggle = $('#mgr-toggle'), mgrState = $('#mgr-state');
let mgr = null;
async function refreshManager() {
  try { mgr = await api('GET', '/api/manager'); } catch { return; }
  mgrState.textContent = mgr.running ? 'Running' : 'Off';
  mgrToggle.textContent = mgr.running ? 'Stop manager' : 'Start manager';
  mgrOpen.href = '/manager/'; // proxied by this server; it starts the manager if needed
}
mgrToggle.addEventListener('click', async () => { try { mgr = await api('POST', '/api/manager', { on: !mgr?.running }); } catch {} refreshManager(); });
refreshManager();

// Settings tab: upgrade the server in place. It reinstalls, restarts (terminals end) and we reload.
const updBtn = $('#upd-btn'), updState = $('#upd-state');
let upd = null;
async function refreshUpdate(force) {
  try { upd = await api('GET', '/api/update' + (force ? '?force=1' : '')); } catch { return; }
  updState.textContent = upd.installed || upd.version;
  updBtn.textContent = upd.available ? `Upgrade to ${upd.latest}` : upd.latest ? 'Up to date · check again' : 'Check for updates';
}
updBtn.addEventListener('click', async () => {
  if (!upd?.available) return refreshUpdate(true);
  let n = 0;
  try { n = (await api('GET', '/api/state')).instances.length; } catch {}
  if (!confirm(`Upgrade and restart the server?${n ? ` Your ${n} running terminal${n > 1 ? 's' : ''} will end.` : ''}`)) return;
  updBtn.disabled = true; updBtn.textContent = 'Upgrading… (about a minute)';
  try { await api('POST', '/api/update'); } catch (err) { updBtn.disabled = false; updBtn.textContent = 'Upgrade failed: ' + err.message; return; }
  updBtn.textContent = 'Restarting…';
  const t = setInterval(async () => {
    try { await api('GET', '/api/state'); clearInterval(t); location.reload(); } catch {}
  }, 1500);
});
refreshUpdate();
