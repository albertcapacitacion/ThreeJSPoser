import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
let port = Number(process.env.PORT || 5173);
let retries = 0;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // Only serve the app and this dependency. Never expose project or user files.
    let relative;
    if (pathname === '/') relative = 'index.html';
    else if (/^\/src\/[a-z-]+\.(js|css)$/.test(pathname)) relative = pathname.slice(1);
    else if (/^\/vendor\/(?:build\/three\.(?:module|core)\.js|examples\/jsm\/controls\/(?:OrbitControls|TransformControls)\.js)$/.test(pathname)) relative = 'node_modules/three/' + pathname.slice(8);
    else { res.writeHead(404); res.end('Not found'); return; }
    const data = await readFile(path.join(root, relative));
    res.writeHead(200, { 'Content-Type': types[path.extname(relative)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 400);
    res.end('Unable to serve this file.');
  }
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && retries < 100 && port < 65535) {
    port++;
    retries++;
    server.listen(port, '127.0.0.1', () => console.log(`ThreeJSPoser ready: http://127.0.0.1:${port}`));
    return;
  }
  console.error(`Cannot start local server: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`ThreeJSPoser ready: http://127.0.0.1:${port}`));
