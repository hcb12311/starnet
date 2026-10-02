'use strict';

// A single-user HTTPS gateway for Railway. Keep the upstream runtime on loopback
// and retain its API tokens, scoped tickets, capability checks and persistence.
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = Number(process.env.PORT || 8080);
const runtimePort = Number(process.env.STARNET_RUNTIME_PORT || 8787);
const username = process.env.STARNET_LOGIN_USER || '';
const password = process.env.STARNET_LOGIN_PASSWORD || '';
const publicOrigin = process.env.STARNET_PUBLIC_ORIGIN ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
if (!username || password.length < 24 || !publicOrigin || port === runtimePort) {
  console.error('Hosting requires a username, a password of at least 24 characters, a public origin and separate ports.');
  process.exit(1);
}
const origin = new URL(publicOrigin);
if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== publicOrigin) {
  console.error('STARNET_PUBLIC_ORIGIN must be an exact HTTP(S) origin.');
  process.exit(1);
}
const credentialHash = crypto.createHash('sha256').update(username + ':' + password).digest();
const childEnv = { ...process.env, STARNET_PORT: String(runtimePort) };
for (const key of ['STARNET_LOGIN_USER', 'STARNET_LOGIN_PASSWORD']) {
  delete childEnv[key];
  delete process.env[key];
}
const child = spawn(process.execPath, [path.join(__dirname, '../sidecar/index.js')], {
  env: childEnv, stdio: 'inherit', cwd: path.join(__dirname, '..')
});
let stopping = false;
child.once('error', () => { console.error('StarNet runtime could not start.'); process.exit(1); });
child.once('exit', code => {
  if (!stopping) { server.close(); process.exit(code || 1); }
});

function authenticated(req) {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(req.headers.authorization || '');
  if (!match) return false;
  const candidate = crypto.createHash('sha256').update(Buffer.from(match[1], 'base64')).digest();
  return crypto.timingSafeEqual(candidate, credentialHash);
}

function unavailable(res) {
  if (res.headersSent) return res.destroy();
  res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: false, error: 'StarNet runtime unavailable' }));
}

const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Liveness has no station details or tokens, and follows actual runtime health.
  if (req.url === '/healthz' && req.method === 'GET') {
    const probe = http.get({ host: '127.0.0.1', port: runtimePort, path: '/api/health', timeout: 3000 }, upstream => {
      upstream.resume();
      res.writeHead(upstream.statusCode === 200 ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: upstream.statusCode === 200 }));
    });
    probe.once('timeout', () => probe.destroy());
    probe.once('error', () => unavailable(res));
    return;
  }
  if (req.headers.host !== origin.host ||
      (req.headers.origin && req.headers.origin !== origin.origin)) {
    res.writeHead(403); res.end('Forbidden origin'); return;
  }
  if (!authenticated(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SlopCannon", charset="UTF-8"' });
    res.end('Sign in to SlopCannon'); return;
  }
  // Reject foreign origins before translating the authenticated request into the
  // loopback contract. Never forward login credentials into agents or their tools.
  const headers = { ...req.headers, host: '127.0.0.1:' + runtimePort };
  delete headers.authorization;
  delete headers['proxy-authorization'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-for'];
  if (req.headers.origin) headers.origin = 'http://127.0.0.1:' + runtimePort;
  const upstream = http.request({ host: '127.0.0.1', port: runtimePort,
    path: req.url, method: req.method, headers }, reply => {
    const responseHeaders = { ...reply.headers, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
    // Everything stays on the gateway origin; there is no cross-origin API grant.
    delete responseHeaders['access-control-allow-origin'];
    res.writeHead(reply.statusCode, responseHeaders);
    reply.pipe(res);
    reply.once('error', () => res.destroy());
  });
  upstream.once('error', () => unavailable(res));
  req.once('aborted', () => upstream.destroy());
  res.once('close', () => upstream.destroy());
  req.pipe(upstream);
});
server.requestTimeout = 0; // NDJSON agent runs and SSE remain streaming.
server.once('error', () => { child.kill('SIGTERM'); process.exit(1); });
server.listen(port, '0.0.0.0', () => console.log('SlopCannon gateway listening on port ' + port));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  stopping = true;
  server.close();
  child.kill('SIGTERM');
  child.once('exit', () => process.exit(0));
  setTimeout(() => { child.kill('SIGKILL'); process.exit(0); }, 8000).unref();
});
