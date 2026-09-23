'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = 3100;
const BASE = 'https://nova3i.taila5f58b.ts.net';
const PROGRESS_FILE = path.join(__dirname, 'progress.json');
const START_TS = Date.now();

function readProp(name) {
  try {
    const out = execFileSync('getprop', [name], { encoding: 'utf8' }).trim();
    return out || 'n/a';
  } catch (err) {
    return 'n/a';
  }
}

function readMemAvailableKB() {
  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8');
    const hit = mem.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return hit ? parseInt(hit[1], 10) : null;
  } catch (err) {
    return null;
  }
}

function readDf() {
  try {
    const out = execFileSync('df', ['-k', '/'], { encoding: 'utf8' });
    const line = out.trim().split('\n')[1].split(/\s+/);
    return { totalKB: parseInt(line[1], 10), freeKB: parseInt(line[3], 10) };
  } catch (err) {
    return { totalKB: null, freeKB: null };
  }
}

const STATIC_SPEC = {
  model: readProp('ro.product.model'),
  os: readProp('ro.build.version.release'),
  cores: os.cpus().length,
  totalMemoryKB: Math.round(os.totalmem() / 1024),
  totalDiskKB: readDf().totalKB,
};

const STARTUP_SPEC = {
  memoryAvailableKB: readMemAvailableKB(),
  diskFreeKB: readDf().freeKB,
  at: new Date().toISOString(),
};

function readLiveSpec() {
  return {
    memoryAvailableKB: readMemAvailableKB(),
    diskFreeKB: readDf().freeKB,
    at: new Date().toISOString(),
  };
}

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
    spec: {
      model: STATIC_SPEC.model,
      os: STATIC_SPEC.os,
      cores: STATIC_SPEC.cores,
      totalMemoryKB: STATIC_SPEC.totalMemoryKB,
      totalDiskKB: STATIC_SPEC.totalDiskKB,
      startup: STARTUP_SPEC,
      live: readLiveSpec(),
    },
  };
}

function absUrl(rel, base) {
  return /^https?:\/\//.test(rel) ? rel : base + (rel.startsWith('/') ? '' : '/') + rel;
}

function fmtKB(kb, total) {
  if (kb == null || isNaN(kb)) return 'n/a';
  if (total) return `${(kb / 1048576).toFixed(1)} GiB`;
  return kb >= 1048576 ? `${(kb / 1048576).toFixed(2)} GiB` : `${(kb / 1024).toFixed(0)} MiB`;
}

function renderHtml(idx) {
  const pr = idx.progress || {};
  const spec = idx.spec || {};
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
  table.spec { border-collapse: collapse; margin: 6px 0; }
  table.spec td { padding: 3px 14px 3px 0; border: 0; }
  button { background: #238636; color: #fff; border: 0; border-radius: 6px;
           padding: 3px 10px; cursor: pointer; font: inherit; }
  button:hover { background: #2ea043; }
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
<h2>Specs</h2>
<div class="box">
<table class="spec">
  <tr><td class="t">Model</td><td>${escapeHtml(spec.model || 'n/a')}</td></tr>
  <tr><td class="t">OS</td><td>Android ${escapeHtml(spec.os || 'n/a')}</td></tr>
  <tr><td class="t">Cores</td><td>${spec.cores != null ? spec.cores : 'n/a'}</td></tr>
  <tr><td class="t">Total RAM</td><td>${fmtKB(spec.totalMemoryKB, true)}</td></tr>
  <tr><td class="t">Total storage</td><td>${fmtKB(spec.totalDiskKB, true)}</td></tr>
</table>
<p class="muted">Available resources</p>
<table class="spec">
  <tr><td class="t">At startup</td>
      <td>mem ${fmtKB(spec.startup && spec.startup.memoryAvailableKB)} · disk ${fmtKB(spec.startup && spec.startup.diskFreeKB)}</td></tr>
  <tr><td class="t">Now</td>
      <td>mem <span id="live-mem">${fmtKB(spec.live && spec.live.memoryAvailableKB)}</span> · disk <span id="live-disk">${fmtKB(spec.live && spec.live.diskFreeKB)}</span>
          <button id="spec-refresh" type="button">refresh</button></td></tr>
</table>
<p class="muted" id="spec-msg"></p>
</div>
<h2>Recent progress</h2>
<ul>${rows || '<li class="muted">no history yet</li>'}</ul>
<h2>Endpoints</h2>
<ul>${links || '<li class="muted">none</li>'}</ul>
<hr style="border:0;border-top:1px solid #30363d;margin-top:28px">
<p class="muted">JSON: /health · <a href="${escapeHtml(base)}/health/progress?format=json">progress JSON</a></p>
<script>
document.getElementById('spec-refresh').addEventListener('click', async () => {
  const msg = document.getElementById('spec-msg');
  msg.textContent = 'refreshing…';
  try {
    const r = await fetch('/health/resources');
    const d = await r.json();
    const fmt = (kb) => kb == null ? 'n/a' : (kb >= 1048576 ? (kb / 1048576).toFixed(2) + ' GiB' : Math.round(kb / 1024) + ' MiB');
    document.getElementById('live-mem').textContent = fmt(d.memoryAvailableKB);
    document.getElementById('live-disk').textContent = fmt(d.diskFreeKB);
    msg.textContent = 'updated ' + new Date(d.at).toISOString();
  } catch (err) {
    msg.textContent = 'refresh failed';
  }
});
</script>
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
  if (pathname === '/health/resources') {
    json(res, 200, readLiveSpec());
    return;
  }
  json(res, 404, { status: 'error', error: 'not found', path: url.pathname });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`healthcheck listening on ${PORT}`);
});