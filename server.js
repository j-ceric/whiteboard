#!/usr/bin/env node
// Whiteboard server — no dependencies, just Node 18+.
//   GET  /            drawing page (laptop, phone, tablet)
//   GET  /display     view-only page for the TV
//   GET  /events      live updates (Server-Sent Events)
//   POST /op          send changes
//   POST /upload      upload an image
//   GET  /export      download the whole board as JSON
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WB = require('./public/common.js');

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const BOARD = path.join(DATA, 'board.json');
const PUBLIC = path.join(__dirname, 'public');
const MAX_UPLOAD = 25 * 1024 * 1024;

fs.mkdirSync(UPLOADS, { recursive: true });

// ---------- state + persistence ----------
let S;
try {
  S = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
  if (!Array.isArray(S.pages) || !S.pages.length) throw new Error('empty');
  S.cur = Math.min(S.cur | 0, S.pages.length - 1);
} catch {
  S = WB.emptyState();
}

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = BOARD + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(S));
  fs.renameSync(tmp, BOARD);
}
function save() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 1000);
}

// ---------- connected clients ----------
const clients = new Map(); // cid -> {res, name, color, role}
const clean = (s, n = 24) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const cleanColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#4dabf7');
const users = () => [...clients].map(([cid, c]) => ({ cid, name: c.name, color: c.color, role: c.role }));

function send(res, msgs) {
  res.write('data: ' + JSON.stringify(msgs) + '\n\n');
}
function broadcast(msgs, except) {
  const data = 'data: ' + JSON.stringify(msgs) + '\n\n';
  for (const [cid, c] of clients) if (cid !== except) c.res.write(data);
}
setInterval(() => {
  for (const c of clients.values()) c.res.write(': ping\n\n');
}, 20000);

// ---------- helpers ----------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        reject(Object.assign(new Error('Too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif', 'image/bmp': '.bmp' };
const PAGES = { '/': 'draw.html', '/draw': 'draw.html', '/display': 'display.html', '/tv': 'display.html' };
const CSP = "default-src 'self'; img-src 'self' data: blob: http: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'";

function serveFile(res, file, extra = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ...extra });
    res.end(buf);
  });
}

function lanUrls() {
  const port = PORT === 80 ? '' : ':' + PORT;
  const urls = [`http://${os.hostname()}.local${port}`];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}${port}`);
  return urls;
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && PAGES[p]) {
      return serveFile(res, path.join(PUBLIC, PAGES[p]), { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-cache' });
    }
    if (req.method === 'GET' && /^\/[\w-]+\.(js|css|svg|ico)$/.test(p)) {
      return serveFile(res, path.join(PUBLIC, p), { 'Cache-Control': 'no-cache' });
    }
    if (req.method === 'GET' && /^\/uploads\/[a-f0-9]{40}\.\w{3,4}$/.test(p)) {
      return serveFile(res, path.join(UPLOADS, path.basename(p)), { 'Cache-Control': 'public, max-age=31536000, immutable' });
    }

    if (req.method === 'GET' && p === '/events') {
      const q = url.searchParams;
      const cid = clean(q.get('cid'), 32) || crypto.randomUUID();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1500\n\n');
      const old = clients.get(cid);
      clients.set(cid, {
        res, name: clean(q.get('name')) || 'Guest', color: cleanColor(q.get('color')),
        role: q.get('role') === 'display' ? 'display' : 'draw',
      });
      if (old) old.res.end();
      send(res, [{ t: 'init', state: S, users: users(), urls: lanUrls() }]);
      broadcast([{ t: 'presence', users: users() }], cid);
      req.on('close', () => {
        if (clients.get(cid)?.res === res) {
          clients.delete(cid);
          broadcast([{ t: 'presence', users: users(), left: cid }]);
        }
      });
      return;
    }

    if (req.method === 'POST' && p === '/op') {
      const { cid, ops } = JSON.parse(await readBody(req, 8e6));
      if (!Array.isArray(ops)) throw Object.assign(new Error('Bad request'), { status: 400 });
      const out = [];
      let changed = false, presence = false;
      for (const op of ops) {
        if (!op || typeof op.t !== 'string') continue;
        if (op.t === 'hello') {
          const c = clients.get(cid);
          if (c) { c.name = clean(op.name) || c.name; c.color = cleanColor(op.color); presence = true; }
        } else if (op.t === 'cur' || op.t === 'laser') {
          out.push({ ...op, cid });
        } else if (WB.apply(S, op)) {
          out.push(op);
          changed = true;
        }
      }
      if (out.length) broadcast(out, cid);
      if (presence) broadcast([{ t: 'presence', users: users() }]);
      if (changed) save();
      return res.writeHead(204).end();
    }

    if (req.method === 'POST' && p === '/upload') {
      const type = (req.headers['content-type'] || '').split(';')[0].trim();
      const ext = IMAGE_EXT[type];
      if (!ext) throw Object.assign(new Error('Unsupported image type'), { status: 415 });
      const buf = await readBody(req, MAX_UPLOAD);
      const name = crypto.createHash('sha1').update(buf).digest('hex') + ext;
      const file = path.join(UPLOADS, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ src: '/uploads/' + name }));
    }

    if (req.method === 'GET' && p === '/export') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="whiteboard-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      return res.end(JSON.stringify(S));
    }

    res.writeHead(404).end('Not found');
  } catch (err) {
    if (!res.headersSent) res.writeHead(err.status || 400, { 'Content-Type': 'text/plain' });
    res.end(err.message || 'Error');
  }
});

server.listen(PORT, HOST, () => {
  console.log('Whiteboard running:');
  for (const u of lanUrls()) console.log('  draw:    ' + u + '/');
  console.log(`  display: http://localhost${PORT === 80 ? '' : ':' + PORT}/display`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveNow(); process.exit(0); });
