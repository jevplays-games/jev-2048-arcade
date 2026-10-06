import http from 'node:http';
import {readFile, mkdir, writeFile, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, extname, sep} from 'node:path';
import {createSqlite} from './sqlite.js';
import {handleApi, HEADERS} from './app.js';
import {documentHeaders} from './activity.js';
import {randomHex} from '../public/core/crypto.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.DATA_DIR || resolve(root, '.data'));
await mkdir(dataDir, {recursive: true});
let secrets;
try { secrets = JSON.parse(await readFile(resolve(dataDir, 'local-secrets.json'), 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secrets = {APP_SIGNING_KEY: randomHex(), SEED_ENCRYPTION_KEY: randomHex()};
  await writeFile(resolve(dataDir, 'local-secrets.json'), JSON.stringify(secrets), {mode: 0o600, flag: 'wx'});
}
const port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1';
const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(new URL(origin).hostname);
if (!loopback && (!origin.startsWith('https://') || !process.env.APP_SIGNING_KEY || !process.env.SEED_ENCRYPTION_KEY))
  throw new Error('Public hosting requires HTTPS PUBLIC_ORIGIN and explicitly configured signing/encryption keys.');
const DB = createSqlite(resolve(dataDir, 'arcade.sqlite'));
DB.exec(await readFile(resolve(root, 'migrations/001_initial.sql'), 'utf8'));
const env = {...secrets, ...process.env, DB, PUBLIC_ORIGIN: origin, DEV_LOCAL: loopback ? 'true' : 'false'};
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) { res.writeHead(413); res.end('Request too large'); return; } chunks.push(chunk); }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : v);
      // Do not trust client-provided forwarding headers for local quota attribution.
      headers.delete('CF-Connecting-IP');
      // Behind one trusted reverse proxy (TRUST_PROXY=1), attribute quota to the proxy-appended client address.
      const forwarded = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() : '';
      const request = new Request(url, {method: req.method, headers,
        ...(['GET', 'HEAD'].includes(req.method) ? {} : {body: Buffer.concat(chunks)})});
      const response = await handleApi(request, {...env, LOCAL_CLIENT_IP: forwarded || req.socket.remoteAddress || 'local'});
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) for await (const chunk of response.body) {
        if (!res.write(Buffer.from(chunk))) await new Promise(r => res.once('drain', r));
      }
      res.end(); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const decoded = decodeURIComponent(url.pathname), relative = decoded === '/' ? 'index.html' : decoded.slice(1);
    const publicRoot = resolve(root, 'public'), path = resolve(publicRoot, relative);
    if (!path.startsWith(publicRoot + sep) || !(await stat(path)).isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {...documentHeaders(url, HEADERS), 'Content-Type': types[extname(path)] || 'application/octet-stream'});
    res.end(req.method === 'HEAD' ? undefined : await readFile(path));
  } catch { if (!res.headersSent) res.writeHead(500); res.end('Request failed'); }
});
server.listen(port, host, () => console.log(`JEV Arcade: ${origin}\nOpponent: ${env.TYPESAFE_API_KEY ? 'JEV available' : 'local heuristic practice (no API key)'}\nData: ${dataDir}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { DB.close(); process.exit(0); }));
