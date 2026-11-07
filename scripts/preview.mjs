import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const name = decodeURIComponent(url.pathname === '/' ? '/tests/browser.html' : url.pathname);
    if (name.split('/').some(part => part.startsWith('.'))) throw new Error('Invalid path');
    const file = path.join(root, name);
    if (!file.startsWith(root)) throw new Error('Invalid path');
    const content = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});
server.listen(8766, '127.0.0.1', () => console.log('Browser regression: http://127.0.0.1:8766/'));
