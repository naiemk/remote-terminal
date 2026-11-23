// Claude sessions that were terminated (terminal killed, server restarted, crash, reboot) rather than
// quit with /exit, so they can be resumed. Every live interactive session in ~/.claude/sessions is
// remembered in <config>/sessions.json; when one disappears without a quit mark in its transcript it
// moves to the "ended" list, which survives server restarts. Cheap: small JSON reads and kill(pid, 0).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activity, quitByUser } from './fleet.js';

const SESSIONS = path.join(os.homedir(), '.claude', 'sessions');
const KEEP = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tildify = (p) => (p || '').replace(os.homedir(), '~');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// `names()` maps a session id to the best name known for it (its terminal's name, or a /rename).
export function createEnded(file, { names = () => new Map(), onChange = () => {} } = {}) {
  // done: dead sessions already handled (listed, dismissed or quit), so a leftover session file is not picked up again.
  let db = { live: {}, ended: {}, done: [] };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); db = { live: d.live || {}, ended: d.ended || {}, done: d.done || [] }; } catch {}
  const handled = (sid) => { if (!db.done.includes(sid)) db.done = [...db.done, sid].slice(-200); };
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(db, null, 1)); } catch {} };

  function end(rec) {
    delete db.live[rec.sid];
    handled(rec.sid);
    if (quitByUser(rec.sid)) return false;
    const a = activity(rec.sid);
    db.ended[rec.sid] = { ...rec, ended: Date.now() / 1000, lastPrompt: a.lastPrompt || '', lastText: (a.lastText || '').slice(0, 200), mtime: a.mtime || 0 };
    const all = Object.values(db.ended).sort((x, y) => y.ended - x.ended);
    for (const x of all.slice(KEEP)) delete db.ended[x.sid];
    return true;
  }

  function scan() {
    let changed = false;
    const named = names(), recs = [];
    let files = [];
    try { files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json')); } catch {}
    for (const f of files) {
      let s; try { s = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8')); } catch { continue; }
      const sid = String(s.sessionId || '');
      if (s.kind !== 'interactive' || !s.pid || !UUID.test(sid)) continue;
      recs.push({ sid, pid: s.pid, cwd: s.cwd || '', up: alive(s.pid), name: named.get(sid) || db.live[sid]?.name || String(s.name || '').trim() || path.basename(s.cwd || ''), started: (s.startedAt || 0) / 1000 });
    }
    const seen = new Set(recs.filter((r) => r.up).map((r) => r.sid));
    for (const { up, ...rec } of recs) {
      const sid = rec.sid;
      if (up) {
        if (db.ended[sid]) { delete db.ended[sid]; changed = true; } // resumed somewhere
        if (db.done.includes(sid)) { db.done = db.done.filter((x) => x !== sid); changed = true; }
        const o = db.live[sid];
        if (!o || o.name !== rec.name || o.pid !== rec.pid) { db.live[sid] = rec; changed = true; }
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
    list: () => Object.values(db.ended).sort((a, b) => b.ended - a.ended)
      .map((x) => ({ sid: x.sid, id: x.sid.slice(0, 8), name: x.name, cwd: tildify(x.cwd), ended: x.ended, started: x.started, lastPrompt: x.lastPrompt, lastText: x.lastText })),
    get: (sid) => db.ended[sid] || null,
    dismiss(sid) { if (!db.ended[sid]) return false; delete db.ended[sid]; save(); onChange(); return true; },
    isId: (sid) => UUID.test(String(sid)),
  };
}
