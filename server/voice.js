// A spoken briefing of everything on the machine, written to be listened to (phone, driving), not read.
// "full" covers every session and the ones that closed; "since" covers only what changed after a time.
import { askHaiku } from './haiku.js';
import { digest } from './fleet.js';

const SYSTEM = `You write a spoken briefing for someone who is listening on a phone, perhaps while driving. It will be read aloud by a text-to-speech voice.
Rules: plain spoken English only, as a short story told in the order of importance. No lists, bullets, headings, markdown, code, file paths, URLs, emoji or symbols; say numbers and names the way a person would. Short sentences. Open with one sentence of the overall picture (how many agents are working, waiting or idle). Then one or two sentences per project: what it is, what it is doing, and anything blocked or needing the listener's decision, said plainly. Mention agents that closed. Close with the one or two things most worth doing next. Never invent facts that are not in the notes.
If asked for changes only, speak only what changed since the given time, starting with "Since you last checked,"; if nothing changed, say so in one sentence. Full briefings stay under about 300 words, changes under about 150.`;

export function createVoice({ manager, agents }) {
  const known = new Map(); // id -> last-seen details of a live session
  const closed = [];       // sessions that have ended while we were watching
  const poll = () => {
    let live; try { live = manager.fleet().sessions; } catch { return; }
    const view = agents.view(), ids = new Set(live.map((s) => s.id));
    for (const s of live) { const b = view[s.id]?.brief || {}; known.set(s.id, { name: b.title || s.name, project: b.project || s.cwd, state: view[s.id]?.summary || s.lastText || '' }); }
    for (const [id, k] of known) if (!ids.has(id)) { closed.push({ ...k, at: Date.now() }); known.delete(id); }
    if (closed.length > 40) closed.splice(0, closed.length - 40);
  };
  poll();
  const timer = setInterval(poll, 20_000); timer.unref?.();

  async function speak(since = 0) {
    poll();
    since = Number(since) > 0 ? Number(since) : 0;
    const view = agents.view(), sessions = manager.fleet().sessions;
    const part = (s) => {
      const b = view[s.id]?.brief || {}, v = view[s.id] || {};
      const lines = [`- ${b.title || s.name} (${s.status}), project: ${b.project || s.cwd}`];
      if (b.task) lines.push(`  task: ${b.task}`);
      if (v.summary) lines.push(`  state: ${String(v.summary).slice(0, 500)}`);
      if (b.blocker) lines.push(`  blocked: ${b.blocker}`);
      if (since) { const d = digest(s.sid, since, 8).text; if (d) lines.push(`  recent activity:\n${d.slice(-700)}`); }
      return lines.join('\n');
    };
    const live = since ? sessions.filter((s) => (s.mtime || 0) * 1000 > since) : sessions;
    const gone = closed.filter((c) => !since || c.at > since).slice(-10);
    if (since && !live.length && !gone.length) return { ok: true, text: 'Nothing has changed since you last checked.' };
    const counts = ['busy', 'waiting', 'idle'].map((k) => `${sessions.filter((s) => s.status === k).length} ${k}`).join(', ');
    const prompt = `${since ? `CHANGES ONLY since ${new Date(since).toLocaleTimeString()}` : 'FULL BRIEFING'}. Now ${new Date().toLocaleTimeString()}. All sessions: ${sessions.length} (${counts}).\n\n${since ? 'SESSIONS THAT CHANGED' : 'SESSIONS'}\n${live.map(part).join('\n') || '(none)'}\n\nCLOSED SESSIONS${since ? ' SINCE THEN' : ' (seen closing while the manager was watching)'}\n${gone.map((c) => `- ${c.name}: ${String(c.state).slice(0, 200)}`).join('\n') || '(none)'}`;
    let lastErr;
    for (let i = 0; i < 2; i++) {
      try {
        const text = (await askHaiku(SYSTEM, prompt, 'haiku', 90_000)).replace(/[*_`#>]/g, '').trim();
        if (text) return { ok: true, text };
      } catch (e) { lastErr = e; }
    }
    return { ok: false, error: lastErr?.message || 'could not write the summary' };
  }
  return { speak, stop: () => clearInterval(timer) };
}
