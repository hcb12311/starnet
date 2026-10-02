'use strict';

// A single-user HTTPS gateway for Railway. Keep the upstream runtime on loopback
// and retain its API tokens, scoped tickets, capability checks and persistence.
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
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
for (const key of ['STARNET_LOGIN_USER', 'STARNET_LOGIN_PASSWORD', 'SLOPCANNON_API_TOKEN']) {
  delete childEnv[key];
  if (key !== 'SLOPCANNON_API_TOKEN') delete process.env[key];
}
const assetVersion = process.env.RAILWAY_GIT_COMMIT_SHA || crypto.randomBytes(16).toString('hex');
const assetTags = new Map();
const factoryPage = fs.readFileSync(path.join(__dirname, 'factory.html'));
let nativeToken = null;
async function sidecarToken() {
  if (nativeToken) return nativeToken;
  const reply = await fetch('http://127.0.0.1:' + runtimePort + '/');
  const html = await reply.text();
  const match = /window\.__STARNET_API_TOKEN__="([a-f0-9]+)"/.exec(html);
  if (!match) throw new Error('Native token unavailable');
  nativeToken = match[1]; return nativeToken;
}
function proxyNative(req, res, target) {
  sidecarToken().then(apiToken => {
    const request = http.request({ host: '127.0.0.1', port: runtimePort,
      path: target, method: req.method,
      headers: { 'Content-Type': 'application/json', 'X-STARNET-TOKEN': apiToken } }, reply => {
      res.writeHead(reply.statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      reply.once('error', () => res.destroy()); reply.pipe(res);
    });
    request.once('error', () => unavailable(res)); req.once('aborted', () => request.destroy());
    req.pipe(request);
  }).catch(() => unavailable(res));
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
  if (['/internal/slopcannon/generate', '/internal/slopcannon/status'].includes(req.url)) {
    const given = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const token = process.env.SLOPCANNON_API_TOKEN || '';
    if (req.headers.origin || !given || !token || !crypto.timingSafeEqual(
      crypto.createHash('sha256').update(given[1]).digest(),
      crypto.createHash('sha256').update(token).digest())) {
      res.writeHead(401); res.end('Factory authentication required'); return;
    }
    const isStatus = req.url.endsWith('/status');
    if (req.method !== (isStatus ? 'GET' : 'POST')) { res.writeHead(405); res.end(); return; }
    proxyNative(req, res, isStatus ? '/api/auth/codex/status' : '/api/slopcannon/generate');
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
  const pathname = new URL(req.url, origin).pathname;
  const connection = /^\/factory\/connect\/(start|poll|status|models)$/.exec(pathname);
  if (connection) {
    const method = ['start', 'poll'].includes(connection[1]) ? 'POST' : 'GET';
    if (req.method !== method) { res.writeHead(405); res.end(); return; }
    proxyNative(req, res, '/api/auth/codex/' + connection[1]); return;
  }
  if (pathname === '/factory' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(factoryPage); return;
  }
  if (pathname.startsWith('/v1/slopcannon/')) {
    if (!process.env.SLOPCANNON_FACTORY_URL || !process.env.SLOPCANNON_API_TOKEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Factory runtime is not connected' })); return;
    }
    const target = new URL(process.env.SLOPCANNON_FACTORY_URL);
    if (target.protocol !== 'http:' || !target.hostname.endsWith('.railway.internal')) {
      return unavailable(res);
    }
    const request = http.request({ hostname: target.hostname, port: target.port || 80,
      path: req.url, method: req.method, headers: { 'Content-Type': 'application/json',
        authorization: 'Bearer ' + process.env.SLOPCANNON_API_TOKEN } }, reply => {
      res.writeHead(reply.statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      reply.once('error', () => res.destroy()); reply.pipe(res);
    });
    request.once('error', () => unavailable(res));
    req.once('aborted', () => request.destroy());
    req.pipe(request); return;
  }
  // Only shipped static assets are reusable. Authentication and origin checks
  // precede every 304; HTML/API/workspace contents always remain no-store.
  const staticAsset = ['GET', 'HEAD'].includes(req.method) &&
    /^\/(assets|app|js|css|shared)\//.test(pathname) &&
    /\.(?:js|css|png|webp|jpg|jpeg|gif|svg|woff2?|ttf|ogg|mp3|wav)$/i.test(pathname);
  if (staticAsset && assetTags.has(pathname) && req.headers['if-none-match'] === assetTags.get(pathname)) {
    res.writeHead(304, { 'Cache-Control': 'private, max-age=0, must-revalidate',
      ETag: assetTags.get(pathname) }); res.end(); return;
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
    reply.once('error', () => res.destroy());
    if (staticAsset && reply.statusCode === 200) {
      const tag = '"' + crypto.createHash('sha256').update(assetVersion + '|' + pathname).digest('hex') + '"';
      assetTags.set(pathname, tag);
      responseHeaders['cache-control'] = 'private, max-age=0, must-revalidate';
      responseHeaders.etag = tag;
    }
    if (['/', '/index.html'].includes(pathname) &&
        String(reply.headers['content-type'] || '').startsWith('text/html')) {
      const chunks = [];
      reply.on('data', chunk => chunks.push(chunk));
      reply.once('end', () => {
        const html = Buffer.concat(chunks).toString('utf8')
          .replace('<title>STARNET</title>', '<title>SlopCannon — StarNet</title>')
          .replace('SIGNAL LOCKED · LOCAL STATION 127.0.0.1', 'SIGNAL LOCKED · SLOPCANNON STATION')
          .replaceAll('uses the whole local computer without approval prompts', 'uses the Railway host without approval prompts')
          .replaceAll('Full power allows actions across your computer without approval prompts.', 'Full power allows actions on the Railway host without approval prompts.')
          .replace(/(<p id="byok-note"[^>]*>)[\s\S]*?<\/p>/,
            '$1Connect a provider to the Railway station. Your key is sent over HTTPS to its backend, which calls your chosen model. Files and run history live in the station’s persistent workspace.</p>')
          .replace('</body>', '<a href="/factory" target="_blank" rel="noopener" style="position:fixed;right:24px;top:76px;z-index:1000;padding:10px 16px;background:#191e22;color:#eeb04d;border:1px solid #eeb04d;border-radius:6px;text-decoration:none;font:14px monospace">Factory jobs</a></body>');
        const body = Buffer.from(html);
        delete responseHeaders['transfer-encoding'];
        responseHeaders['content-length'] = String(body.length);
        res.writeHead(reply.statusCode, responseHeaders);
        res.end(body);
      });
    } else {
      res.writeHead(reply.statusCode, responseHeaders);
      reply.pipe(res);
    }
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
