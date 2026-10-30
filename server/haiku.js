// One-shot headless Claude call: no tools, no session, no settings. Resolves with its stdout.
import { spawn } from 'node:child_process';

export function askHaiku(system, prompt, model = process.env.MANAGER_MODEL || 'haiku') {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', '--model', model, '--system-prompt', system, '--tools', '', '--no-session-persistence',
      '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', ''], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().slice(0, 200) || `exit ${code}`))));
    p.stdin.end(prompt);
  });
}
