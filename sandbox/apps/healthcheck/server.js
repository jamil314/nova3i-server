'use strict';

const http = require('http');

const PORT = 3100;

const server = http.createServer((req, res) => {
  const body = JSON.stringify({
    status: 'ok',
    service: 'healthcheck',
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
  });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`healthcheck listening on ${PORT}`);
});