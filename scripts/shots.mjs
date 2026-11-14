// shots.mjs — render the dashboard in headless Chromium (CLI only, no CDP, no pkill)
// and capture its three judge states. Usage: node scripts/shots.mjs [--port 8931]
// Serves the repo root over loopback (so ../data.js resolves), screenshots
// board / detail / filtered, then shuts the server down cleanly.
import { createServer } from 'node:http';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
import vm from 'node:vm';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dashDir = join(root, 'dashboard');
const shotDir = join(root, 'screenshots');
const CHROME = process.env.CHROME || join(process.env.HOME || '', 'workspace/polyester/chrome-linux/chrome');
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] || 8931);

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

async function firstSlug() {
  const src = await readFile(join(root, 'data.js'), 'utf8');
  const box = { window: {} };
  vm.createContext(box);
  vm.runInContext(src, box);
  const rows = box.window.RADAR?.rows || [];
  if (!rows.length) throw new Error('data.js has no rows');
  return rows[0].slug;
}

function serve() {
  return new Promise((resolveSrv, reject) => {
    const srv = createServer(async (req, res) => {
      try {
        const url = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        const p = join(root, url === '/' ? 'dashboard/index.html' : url);
        if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
        const data = await readFile(p);
        res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    });
    srv.on('error', reject);
    srv.listen(PORT, '127.0.0.1', () => resolveSrv(srv));
  });
}

async function shot(url, file) {
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--window-size=1440,900', '--virtual-time-budget=8000',
    '--screenshot=' + file, url,
  ];
  await run(CHROME, args, { timeout: 120000 });
  const s = await stat(file);
  if (s.size > 512 * 1024) throw new Error(file + ' is ' + s.size + ' bytes, over the 512 KiB cap');
  return s.size;
}

async function main() {
  if (!existsSync(CHROME)) throw new Error('Chromium not found at ' + CHROME + ' (set CHROME=...)');
  await mkdir(shotDir, { recursive: true });
  const slug = await firstSlug();
  const srv = await serve();
  try {
    const base = 'http://127.0.0.1:' + PORT + '/dashboard/index.html';
    const jobs = [
      [base, 'board.png'],
      [base + '#p=' + encodeURIComponent(slug), 'detail.png'],
      [base + '#cat=Dexs&wl=1', 'filtered.png'],
    ];
    for (const [url, name] of jobs) {
      const file = join(shotDir, name);
      const bytes = await shot(url, file);
      console.log(name, bytes + ' bytes');
    }
  } finally {
    await new Promise((r) => srv.close(r));
  }
  console.log('done: ' + shotDir);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
