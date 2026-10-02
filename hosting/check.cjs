'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');

async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1');
  await once(server, 'listening'); const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slopcannon-hosting-'));
  const port = await freePort(), runtimePort = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const password = crypto.randomBytes(32).toString('base64url');
  const authorization = 'Basic ' + Buffer.from('harry:' + password).toString('base64');
  const factoryToken = crypto.randomBytes(32).toString('hex');
  let child, output = '';
  async function start() {
    // An allowlist prevents inherited provider credentials touching the test.
    child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], {
      env: { PATH: process.env.PATH, HOME: root, PORT: String(port),
        STARNET_RUNTIME_PORT: String(runtimePort), STARNET_LOGIN_USER: 'harry',
        STARNET_LOGIN_PASSWORD: password, STARNET_PUBLIC_ORIGIN: origin,
        SLOPCANNON_API_TOKEN: factoryToken,
        STARNET_WORKSPACES: path.join(root, 'workspaces') }, stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(output.slice(-2000));
      try { if ((await fetch(origin + '/healthz')).status === 200) return; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Runtime startup timed out: ' + output.slice(-2000));
  }
  async function stop() {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  }
  const request = (url, options = {}) => fetch(origin + url, {
    ...options, headers: { authorization, ...options.headers }
  });
  try {
    await start();
    assert.deepEqual(await (await fetch(origin + '/healthz')).json(), { ok: true });
    for (const url of ['/', '/index.html', '/api/health', '/api/save?agent=audit', '/shared/specialties.js'])
      assert.equal((await fetch(origin + url)).status, 401, url + ' requires login');
    assert.equal((await fetch(origin + '/', { headers: { authorization: 'Basic d3Jvbmc6d3Jvbmc=' } })).status, 401);
    assert.equal((await request('/api/save', { headers: { origin: 'https://foreign.example' } })).status, 403);
    // fetch normalizes Host, so use the actual HTTP transport for rebinding.
    const foreignHostStatus = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/',
        headers: { authorization, host: 'foreign.example' } }, res => {
        res.resume(); resolve(res.statusCode);
      }); req.once('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    const page = await request('/'); assert.equal(page.status, 200);
    const html = await page.text();
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal((await request('/factory')).status, 200);
    assert.equal((await fetch(origin + '/factory')).status, 401);
    assert.equal((await fetch(origin + '/factory/connect/status')).status, 401);
    assert.equal((await (await request('/factory/connect/status')).json()).connected, false);
    assert.equal((await fetch(origin + '/internal/slopcannon/status')).status, 401);
    const internal = { authorization:'Bearer ' + factoryToken };
    const subscription = await fetch(origin + '/internal/slopcannon/status', { headers:internal });
    assert.equal(subscription.status, 200);
    assert.equal((await subscription.json()).connected, false);
    assert.equal((await fetch(origin + '/internal/slopcannon/status', {
      headers:{...internal,origin:'https://foreign.example'} })).status, 401);
    assert.equal((await fetch(origin + '/internal/slopcannon/generate', {
      method:'POST',headers:{...internal,'content-type':'application/json'},body:'{}' })).status, 422);
    assert.equal((await request('/api/slopcannon/generate', {
      method:'POST',headers:{'content-type':'application/json'},body:'{}' })).status, 403);
    const staticFile = await request('/shared/specialties.js');
    assert.equal(staticFile.status, 200);
    assert.equal(staticFile.headers.get('cache-control'), 'private, max-age=0, must-revalidate');
    const etag = staticFile.headers.get('etag'); assert.ok(etag);
    await staticFile.arrayBuffer();
    const revalidated = await request('/shared/specialties.js', { headers: { 'if-none-match': etag } });
    assert.equal(revalidated.status, 304);
    assert.equal((await revalidated.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(origin + '/shared/specialties.js', { headers: { 'if-none-match': etag } })).status, 401);
    const token = /window\.__STARNET_API_TOKEN__="([a-f0-9]+)"/.exec(html)[1];
    assert.equal(html.includes(password), false);
    assert.equal((await request('/api/save?agent=audit')).status, 403, 'native API token still required');
    const headers = { 'x-starnet-token': token, origin, 'content-type': 'application/json' };
    const budget = await (await request('/api/budget/status', { headers })).json();
    const budgetSaved = await request('/api/budget/caps', { method: 'POST', headers,
      body: JSON.stringify({ perRun: budget.caps.perRun }) });
    assert.equal((await budgetSaved.json()).saved.perRun, budget.caps.perRun);
    const doc = { schema: 'starnet.save', version: 5, updatedAt: Date.now(), agent: { id: 'audit', name: 'HOSTING CHECK' } };
    const saved = await request('/api/save', { method: 'POST', headers, body: JSON.stringify(doc) });
    assert.equal((await saved.json()).ok, true);
    assert.equal((await (await request('/api/save?agent=audit', { headers })).json()).save.agent.name, 'HOSTING CHECK');
    const bytes = fs.readFileSync(path.join(root, 'workspaces/audit.save.json'));
    await stop(); await start();
    const newHtml = await (await request('/')).text();
    const newToken = /window\.__STARNET_API_TOKEN__="([a-f0-9]+)"/.exec(newHtml)[1];
    const restored = await request('/api/save?agent=audit', { headers: { 'x-starnet-token': newToken } });
    assert.equal((await restored.json()).save.agent.name, 'HOSTING CHECK');
    assert.deepEqual(fs.readFileSync(path.join(root, 'workspaces/audit.save.json')), bytes);
    const freshHeaders = { 'x-starnet-token': newToken };
    const lineage = await (await request('/api/lineage', { headers: freshHeaders })).json();
    assert.equal(lineage.lineage.onboardingAllowed, true, 'pre-station settings survive restart without a recovery gate');
    const retained = await (await request('/api/budget/status', { headers: freshHeaders })).json();
    assert.equal(retained.saved.perRun, budget.caps.perRun);
    console.log('PASS: login, foreign origin/host, subscription route gates, native token, asset cache, real save/readback, restart persistence and first-run settings');
  } finally { await stop(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
