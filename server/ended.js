// Claude sessions that were terminated (terminal killed, server restarted, crash, reboot) rather than
// quit with /exit, so they can be resumed. Every live interactive session in ~/.claude/sessions is
// remembered in <config>/sessions.json; when one disappears without a quit mark in its transcript it
// moves to the "ended" list, which survives server restarts. Cheap: small JSON reads and kill(pid, 0).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activity, quitByUser, parents, descendsFrom, givenName, findTranscript, lastParagraph } from './fleet.js';

const SESSIONS = path.join(os.homedir(), '.claude', 'sessions');
const KEEP = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tildify = (p) => (p || '').replace(os.homedir(), '~');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// `terminals()` lists this server's terminals as { pid, name } (name: what the user called it, or empty).
// A session keeps the name it was given: its terminal's name, else a /rename, else the last one remembered,
// else its folder. Read here directly, so names are kept whether or not the manager is on.
export function createEnded(file, { terminals = () => [], onChange = () => {} } = {}) {
  // done: dead sessions already handled (listed, dismissed or quit), so a leftover session file is not picked up again.
  let db = { live: {}, ended: {}, done: [] };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); db = { live: d.live || {}, ended: d.ended || {}, done: d.done || [] }; } catch {}
  for (const sid of Object.keys(db.ended)) if (!findTranscript(sid)) delete db.ended[sid]; // listed by an older version
  // Entries listed before the last paragraph was kept get it now.
  for (const x of Object.values(db.ended)) if (x.lastPara === undefined) x.lastPara = lastParagraph(x.sid);
  const handled = (sid) => { if (!db.done.includes(sid)) db.done = [...db.done, sid].slice(-200); };
  // pid -> true when a terminal's own process (claude run as the command) exited by itself with code 0.
  const exits = new Map();
  // A clean quit (/exit, /quit, Ctrl+C twice): claude ended but whatever started it is still running.
  // The transcript seldom records /exit, so the process tree decides; quitByUser covers the rest.
  const quit = (rec) => exits.has(rec.pid) ? exits.get(rec.pid)
    : rec.ppid > 1 && rec.ppid !== process.pid && alive(rec.ppid);
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(db, null, 1)); } catch {} };

  function end(rec) {
    delete db.live[rec.sid];
    handled(rec.sid);
    // No transcript: nothing to resume (e.g. a `claude -p --no-session-persistence` helper the manager runs).
    if (!findTranscript(rec.sid) || quitByUser(rec.sid) || quit(rec)) return false;
    const a = activity(rec.sid);
    db.ended[rec.sid] = { ...rec, ended: Date.now() / 1000, lastPrompt: a.lastPrompt || '', lastText: (a.lastText || '').slice(0, 200), lastPara: lastParagraph(rec.sid), mtime: a.mtime || 0 };
    const all = Object.values(db.ended).sort((x, y) => y.ended - x.ended);
    for (const x of all.slice(KEEP)) delete db.ended[x.sid];
    return true;
  }

  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    try { await scanOnce(); } finally { scanning = false; }
  }

  async function scanOnce() {
    let changed = false;
    const recs = [], terms = terminals().filter((t) => t.pid && String(t.name || '').trim());
    const procs = await parents().catch(() => new Map());
    const termName = (pid) => String(terms.find((t) => descendsFrom(pid, t.pid, procs))?.name || '').trim();
    let files = [];
    try { files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json')); } catch {}
    for (const f of files) {
      let s; try { s = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8')); } catch { continue; }
      const sid = String(s.sessionId || '');
      if (s.kind !== 'interactive' || !s.pid || !UUID.test(sid)) continue;
      const up = alive(s.pid);
      const name = (up && termName(s.pid)) || givenName(s) || db.live[sid]?.name || path.basename(s.cwd || '');
      recs.push({ sid, pid: s.pid, ppid: (up && procs.get(s.pid)) || db.live[sid]?.ppid || 0, cwd: s.cwd || '', up, name, started: (s.startedAt || 0) / 1000 });
    }
    const seen = new Set(recs.filter((r) => r.up).map((r) => r.sid));
    for (const { up, ...rec } of recs) {
      const sid = rec.sid;
      if (up) {
        if (db.ended[sid]) { delete db.ended[sid]; changed = true; } // resumed somewhere
        if (db.done.includes(sid)) { db.done = db.done.filter((x) => x !== sid); changed = true; }
        const o = db.live[sid];
        if (!o || o.name !== rec.name || o.pid !== rec.pid || o.ppid !== rec.ppid) { db.live[sid] = rec; changed = true; }
      } else if (!seen.has(sid) && !db.done.includes(sid)) {
        // A session file left behind by a process that died without cleaning up (killed, crashed, reboot).
        end({ ...db.live[sid], ...rec }); changed = true;
      }
    }
    for (const rec of Object.values(db.live)) if (!seen.has(rec.sid)) { end(rec); changed = true; }
    if (changed) { save(); onChange(); }
  }

  return {
    scan,
    // A terminal process exited; clean means by itself with code 0 (not killed by a signal).
    exited(pid, clean) { exits.set(pid, clean); if (exits.size > 200) exits.delete(exits.keys().next().value); },
    list: () => Object.values(db.ended).sort((a, b) => b.ended - a.ended)
      .map((x) => ({ sid: x.sid, id: x.sid.slice(0, 8), name: x.name, cwd: tildify(x.cwd), ended: x.ended, started: x.started, lastPrompt: x.lastPrompt, lastText: x.lastText, lastPara: x.lastPara || '' })),
    get: (sid) => db.ended[sid] || null,
    dismiss(sid) { if (!db.ended[sid]) return false; delete db.ended[sid]; save(); onChange(); return true; },
    isId: (sid) => UUID.test(String(sid)),
  };
}
