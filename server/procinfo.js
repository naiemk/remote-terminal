// What a terminal is running right now: the program in the foreground (not the shell that
// started it: open bash, run cursor-agent, and this says cursor-agent) and its working folder.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 2000, encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : stdout));
});

// A readable name from a command line. Scripts run by an interpreter are named after the script
// (or its package, for entry points like cli.js).
export function programName(argv) {
  const base = (s) => path.basename(s || '').replace(/^-/, ''); // "-bash" is a login shell
  const name = base(argv[0]);
  if (!/^(node|nodejs|bun|deno|python[\d.]*|ruby|perl)$/.test(name)) return name;
  const args = argv.slice(1);
  if (args.some((a) => ['-e', '--eval', '-p', '--print', '-c'].includes(a))) return name; // inline code
  const m = args.indexOf('-m');
  if (m >= 0 && args[m + 1]) return args[m + 1]; // python -m http.server
  const script = args.find((a) => !a.startsWith('-'));
  if (!script) return name;
  const file = base(script).replace(/\.(m?js|cjs|ts|py|rb|pl)$/, '');
  return /^(cli|index|main|bin|__main__)$/.test(file) ? base(path.dirname(script)) || name : file;
}

async function linux(pid) {
  // Field 8 of /proc/<pid>/stat is the terminal's foreground process group (after "(comm)").
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const tpgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[5]);
  const fg = tpgid > 0 ? tpgid : pid;
  const [argv, cwd] = await Promise.all([
    fs.readFile(`/proc/${fg}/cmdline`, 'utf8').then((s) => s.split('\0').filter(Boolean)),
    fs.readlink(`/proc/${fg}/cwd`),
  ]);
  return { name: programName(argv), cwd };
}

async function mac(pid) {
  const tpgid = Number((await run('ps', ['-o', 'tpgid=', '-p', String(pid)])).trim());
  const fg = tpgid > 0 ? tpgid : pid;
  const [args, lsof] = await Promise.all([
    run('ps', ['-o', 'command=', '-p', String(fg)]),
    run('lsof', ['-a', '-p', String(fg), '-d', 'cwd', '-Fn']),
  ]);
  const cwd = lsof.split('\n').find((l) => l.startsWith('n'))?.slice(1);
  return { name: programName(args.trim().split(/\s+/)), cwd };
}

// { name, cwd }, or null if the process is gone.
export async function foreground(pid) {
  try {
    if (process.platform === 'linux') return await linux(pid);
    if (process.platform === 'darwin') return await mac(pid);
  } catch {}
  return null;
}
