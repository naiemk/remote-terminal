// One-shot headless Claude call: no tools, no session, no settings. Resolves with its stdout.
import { spawn } from 'node:child_process';

export function askHaiku(system, prompt, model = process.env.MANAGER_MODEL || 'haiku', timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', '--model', model, '--system-prompt', system, '--tools', '', '--no-session-persistence',
      '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', ''], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    // A hung claude must not wedge the manager forever.
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`claude timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error('the claude command was not found') : e); });
    p.on('close', (code) => { clearTimeout(timer); if (code === 0 && out.trim()) resolve(out); else reject(new Error(err.trim().slice(0, 200) || (code === 0 ? 'empty reply' : `exit ${code}`))); });
    p.stdin.on('error', () => {});
    p.stdin.end(prompt);
  });
}
