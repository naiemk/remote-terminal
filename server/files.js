// The shared scratch area: ~/.remote-terminal-server/scratch, with one folder per terminal.
// Programs find theirs in $REMOTE_TERM_SCRATCH; the browser lists, uploads, downloads and
// deletes files here. Nothing outside the scratch folder is ever reachable.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAX_UPLOAD = 512 * 1024 * 1024;

export function createFiles(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(root);

  // A path inside the scratch folder, or an error. Symlinks can't lead out of it either.
  function resolve(rel = '', { mustExist = true } = {}) {
    const full = path.resolve(realRoot, '.' + path.posix.normalize('/' + String(rel)));
    if (full !== realRoot && !full.startsWith(realRoot + path.sep)) throw httpError(400, 'bad path');
    let real = full;
    try { real = fs.realpathSync(full); }
    catch (err) { if (mustExist || err.code !== 'ENOENT') throw httpError(404, 'not found'); }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw httpError(400, 'bad path');
    return full;
  }

  return {
    root: realRoot,

    // Each terminal's folder, e.g. "claude-3f9a"; created when the terminal starts.
    dirFor(command, id) {
      const name = `${String(command).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'term'}-${id.slice(0, 4)}`;
      const dir = path.join(realRoot, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },

    list(rel) {
      const dir = resolve(rel);
      if (!fs.statSync(dir).isDirectory()) throw httpError(400, 'not a folder');
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.'))
        .map((d) => {
          const st = fs.statSync(path.join(dir, d.name), { throwIfNoEntry: false });
          return st && { name: d.name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
        })
        .filter(Boolean)
        .sort((a, b) => b.dir - a.dir || b.mtime - a.mtime);
    },

    async download(rel, res) {
      const file = resolve(rel);
      const st = fs.statSync(file);
      if (!st.isFile()) throw httpError(400, 'not a file');
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': st.size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
        'cache-control': 'no-store',
      });
      await pipeline(fs.createReadStream(file), res);
    },

    // The request body is the file. An existing name gets " (2)", " (3)"… instead of being replaced.
    async upload(rel, name, req) {
      const dir = resolve(rel);
      if (!fs.statSync(dir).isDirectory()) throw httpError(400, 'not a folder');
      const clean = path.basename(String(name || '')).replace(/[\0/\\]/g, '').trim();
      if (!clean || clean.startsWith('.')) throw httpError(400, 'bad file name');
      if (Number(req.headers['content-length']) > MAX_UPLOAD) throw httpError(413, 'file too large');
      const ext = path.extname(clean), stem = clean.slice(0, clean.length - ext.length);
      let target = path.join(dir, clean);
      for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) req.destroy(httpError(413, 'file too large')); });
      try {
        await pipeline(req, fs.createWriteStream(target, { flags: 'wx' }));
      } catch (err) {
        fs.rmSync(target, { force: true });
        throw err.status ? err : httpError(400, 'upload failed');
      }
      return { name: path.basename(target), size };
    },

    remove(rel) {
      const p = resolve(rel);
      if (p === realRoot) throw httpError(400, 'bad path');
      fs.rmSync(p, { recursive: true, force: true });
    },
  };
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
