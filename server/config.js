// Where remote-terminal-server keeps its settings: ~/.remote-terminal-server (or $REMOTE_TERMINAL_HOME).
//   commands.json  what the home page can start
//   .env           PORT, DEFAULT_CWD, ALLOWED_HOSTS
// Both are created on first run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_DIR = path.resolve(process.env.REMOTE_TERMINAL_HOME || path.join(os.homedir(), '.remote-terminal-server'));
export const COMMANDS_FILE = path.join(CONFIG_DIR, 'commands.json');
export const ENV_FILE = path.join(CONFIG_DIR, '.env');

// Offered on first run when they're installed.
const KNOWN_TOOLS = { claude: 'claude', codex: 'codex', cursor: 'cursor-agent', gemini: 'gemini', opencode: 'opencode', btop: 'btop', htop: 'htop' };

const ENV_TEMPLATE = `# remote-terminal-server settings. Command-line flags win over these.
# PORT=12700                # always bound to 127.0.0.1; expose with \`tailscale serve --bg 12700\`
# DEFAULT_CWD=~/code        # where new instances start when no directory is given (default: ~)
# ALLOWED_HOSTS=myhost      # extra host names to accept besides localhost and *.ts.net
`;

function defaultCommands() {
  // An older checkout kept commands.json next to the code; carry it over.
  const legacy = path.join(ROOT, 'commands.json');
  if (fs.existsSync(legacy)) return fs.readFileSync(legacy, 'utf8');

  const shell = process.env.SHELL || '/bin/bash';
  const commands = { [path.basename(shell)]: shell };
  // Look the tools up through a login shell, which is how commands will be run.
  const names = Object.values(KNOWN_TOOLS);
  const found = spawnSync(shell, ['-lc', names.map((n) => `command -v ${n} >/dev/null && echo ${n}`).join('; ')], {
    encoding: 'utf8', timeout: 5000,
  }).stdout?.split('\n') || [];
  for (const [label, bin] of Object.entries(KNOWN_TOOLS)) if (found.includes(bin)) commands[label] = bin;
  return JSON.stringify(commands, null, 2) + '\n';
}

export function ensureConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(COMMANDS_FILE)) {
    fs.writeFileSync(COMMANDS_FILE, defaultCommands());
    console.log(`Created ${COMMANDS_FILE}`);
  }
  if (!fs.existsSync(ENV_FILE)) fs.writeFileSync(ENV_FILE, ENV_TEMPLATE, { mode: 0o600 });
  return { CONFIG_DIR, COMMANDS_FILE, ENV_FILE };
}
