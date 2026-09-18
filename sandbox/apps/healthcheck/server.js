'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3100;
const BASE = 'https://nova3i.taila5f58b.ts.net';
const PROGRESS_FILE = path.join(__dirname, 'progress.json');
const START_TS = Date.now();

function readProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (err) {
    return null;
  }
}

function json(res, statusCode, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function buildIndex(p) {
  const history = (p && Array.isArray(p.history) ? p.history : []).slice(-6).reverse();
  return {
    status: 'ok',
    service: 'healthcheck',
    time: new Date().toISOString(),
    uptimeSec: Math.round((Date.now() - START_TS) / 1000),
    urls: p && p.urls ? p.urls : null,
    progress: {
      mission: p ? p.mission : null,
      base: p && p.base ? p.base : BASE,
      current: p && p.status ? p.status.current : null,
      next: p && p.status ? p.status.next : null,
      updated: p ? p.updated : null,
      history,
    },
  };
}

function absUrl(rel, base) {
  return /^https?:\/\//.test(rel) ? rel : base + (rel.startsWith('/') ? '' : '/') + rel;
}

function renderHtml(idx) {
  const pr = idx.progress || {};
  const base = pr.base || BASE;
  const rows = (pr.history || [])
    .map((h) => `<li><span class="t">${escapeHtml(h.when)}</span>${escapeHtml(h.what)}</li>`)
    .join('\n');
  const links = Object.keys(idx.urls || {})
    .map((k) => {
      const rel = String(idx.urls[k]);
      const href = absUrl(rel, base);
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(rel)}</a> <span class="k">${escapeHtml(k)}</span></li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova 3i — mission control</title>
<style>
  body { margin: 0; font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         background: #0d1117; color: #c9d1d9; padding: 24px 16px; }
  h1 { font-size: 20px; color: #e6edf3; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: #8b949e; margin-top: 28px; }
  .ok { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #238636; color: #fff; font-size: 13px; }
  .t { color: #8b949e; display: inline-block; min-width: 140px; }
  .k { color: #58a6ff; }
  li { margin: 6px 0; }
  a { color: #58a6ff; text-decoration: none; }
  ul { padding-left: 18px; }
  .box { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 14px; margin: 8px 0; }
  .muted { color: #8b949e; font-size: 13px; }
</style>
</head>
<body>
<h1>Nova 3i — mission control</h1>
<span class="ok">${idx.status}</span> <span class="muted">uptime ${Math.floor(idx.uptimeSec / 3600)}h ${Math.floor((idx.uptimeSec % 3600) / 60)}m · updated ${escapeHtml(pr.updated || 'n/a')}</span>
<h2>Mission</h2>
<div class="box">${escapeHtml(pr.mission || 'n/a')}</div>
<h2>Current</h2>
<div class="box">${escapeHtml(pr.current || 'n/a')}</div>
<h2>Next</h2>
<div class="box">${escapeHtml(pr.next || 'n/a')}</div>
<h2>Recent progress</h2>
<ul>${rows || '<li class="muted">no history yet</li>'}</ul>
<h2>Endpoints</h2>
<ul>${links || '<li class="muted">none</li>'}</ul>
<hr style="border:0;border-top:1px solid #30363d;margin-top:28px">
<p class="muted">JSON: /health · <a href="${escapeHtml(base)}/health/progress?format=json">progress JSON</a></p>
</body>
</html>
`;
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch (err) {
    json(res, 400, { status: 'error', error: 'bad request' });
    return;
  }
  const p = readProgress();
  const idx = buildIndex(p);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/health' || pathname === '/') {
    json(res, 200, idx);
    return;
  }
  if (pathname === '/health/progress' || pathname === '/health/progress.html') {
    if (url.searchParams.get('format') === 'json') {
      json(res, 200, idx);
      return;
    }
    const html = renderHtml(idx);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }
  if (pathname === '/health/urls') {
    json(res, 200, { base: p && p.base ? p.base : BASE, urls: idx.urls });
    return;
  }
  json(res, 404, { status: 'error', error: 'not found', path: url.pathname });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`healthcheck listening on ${PORT}`);
});