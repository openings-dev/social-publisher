import { execFile as execFileCallback } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, watch } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '.tmp/social-preview');
const port = Number(process.env.SOCIAL_PREVIEW_PORT ?? 4174);
let building = false;
let pending = false;
async function rebuild() {
  if (building) { pending = true; return; }
  building = true;
  try {
    const { stdout } = await execFile(process.execPath, ['src/modules/preview/render-preview.mjs'], { cwd: root });
    console.log(stdout.trim());
  } finally {
    building = false;
    if (pending) { pending = false; await rebuild(); }
  }
}
await rebuild();
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    if (path !== '/' && path !== '/manifest.json' && !/^\/[a-z]+\/(improved|stash|published|editorial|night|lavender|peach)\/(feed|link|reel|story)\.(jpg|svg)$/u.test(path)) {
      response.writeHead(404).end('Not found'); return;
    }
    const file = path === '/' ? resolve(root, 'assets/social-preview/index.html') : resolve(output, `.${path}`);
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { response.writeHead(404).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Social preview: http://127.0.0.1:${port}`));
for (const directory of ['src/modules/render', 'src/modules/preview']) {
  void (async () => {
    let timer;
    for await (const event of watch(resolve(root, directory))) {
      if (!event.filename?.endsWith('.mjs')) continue;
      clearTimeout(timer);
      timer = setTimeout(() => rebuild().catch((error) => console.error(error.message)), 250);
    }
  })().catch((error) => console.error(error.message));
}
