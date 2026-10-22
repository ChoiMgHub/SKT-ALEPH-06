import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const assets = {
  '/': { type: 'text/html; charset=utf-8', body: read('public/index.html') },
  '/index.html': { type: 'text/html; charset=utf-8', body: read('public/index.html') },
  '/style.css': { type: 'text/css; charset=utf-8', body: read('public/style.css') },
  '/app.js': { type: 'application/javascript; charset=utf-8', body: read('public/app.js') }
};
const staticCode = `const STATIC_ASSETS = ${JSON.stringify(assets)};\n` +
  `function serveAsset(request) { const path = new URL(request.url).pathname; const asset = STATIC_ASSETS[path];` +
  ` if (!asset) return new Response('찾을 수 없습니다.', {status:404});` +
  ` return new Response(asset.body, {headers:{'content-type':asset.type,'x-content-type-options':'nosniff',` +
  `'referrer-policy':'no-referrer','x-frame-options':'DENY',` +
  `'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"}}); }\n`;
const source = read('src/worker.js');
const original = "if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);";
if (!source.includes(original)) throw new Error('Static asset hook was not found.');
const output = staticCode + source.replace(original, "if (!url.pathname.startsWith('/api/')) return serveAsset(request);");
mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/worker.js'), output);
console.log(`Built dist/worker.js (${Buffer.byteLength(output)} bytes)`);

