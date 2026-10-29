// Web consoles that other agents advertise: a JSON file per console in
// ~/.remote-terminal-server/consoles/<name>.json  { "name", "port", "description"?, "pid"? }.
// While its pid is alive (or always, with no pid) it is listed on the home screen and proxied at /c/<name>/.
import fs from 'node:fs';
import path from 'node:path';

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function createConsoles(dir, reservedPorts) {
  fs.mkdirSync(dir, { recursive: true });
  function list() {
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let c; try { c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const port = Number(c?.port);
      if (!NAME.test(c?.name || '') || !Number.isInteger(port) || port < 1024 || port > 65535 || reservedPorts.includes(port)) continue;
      if (c.pid && !fs.existsSync(`/proc/${Number(c.pid)}`)) continue; // its agent is gone
      out.push({ name: c.name, port, description: String(c.description || '').slice(0, 120), url: `/c/${c.name}/` });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  return { dir, list, port: (name) => list().find((c) => c.name === name)?.port };
}
