/* Segurança: login do painel (rotas protegidas, comandos sensíveis, sessão, logout) e senha do broker MQTT. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import mqtt from 'mqtt';
import { openDb } from '../server/db.js';
import { Hub } from '../server/hub.js';
import { createAuth } from '../server/auth.js';
import { createZones } from '../server/zones.js';
import { createApp } from '../server/app.js';
import { startMqtt } from '../server/sources/mqtt.js';

const results = [];
const test = async (name, fn) => { await fn(); results.push(name); console.log(`ok ${results.length} - ${name}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echomap-auth-'));
const config = {
  defaultDeviceId: 'node1', offlineAfterMs: 10000, thresholds: { nearMissCm: 50, impactG: 3 },
  mqtt: { embeddedBroker: false, port: 0 }, serial: { deviceId: 'node1' }, anchor: { radiusM: 100, hours: 4 },
  discovery: { enabled: false }, safeZones: [],
};
const db = openDb(path.join(dir, 'test.db'));
const hub = new Hub({ db, config });
const zones = createZones({ db, dataDir: dir, initial: [], onChange: () => {} });
hub.zones = zones;
const usb = { state: { status: 'idle' }, publicState: () => ({ status: 'idle' }) };

async function serve(authOpts) {
  const auth = createAuth({ dataDir: dir, ...authOpts });
  const app = createApp({ config, db, hub, usb, auth, zones });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  /* 127.0.0.2 = outro aparelho da rede (no Linux e no Windows todo 127.x é loopback) */
  const req = (method, p, { body, from = '127.0.0.2', cookie } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p, localAddress: from,
      headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
  return { server, req, auth };
}

await test('sem login: API, comandos sensíveis e zonas recusados para outro aparelho', async () => {
  const { server, req } = await serve({ password: 'Senha-Forte-123', user: 'familia' });
  assert.equal((await req('GET', '/api/state')).status, 401);
  assert.equal((await req('POST', '/api/devices/node1/command', { body: { cmd: 'wifi', ssid: 'x', pass: '12345678' } })).status, 401);
  assert.equal((await req('POST', '/api/devices/node1/command', { body: { cmd: 'calibrate_start' } })).status, 401);
  assert.equal((await req('POST', '/api/zones', { body: { name: 'X', lat: 1, lon: 1, radiusM: 50 } })).status, 401);
  const page = await req('GET', '/');
  assert.equal(page.status, 302);
  assert.match(page.headers.location, /^\/login\.html/);
  assert.equal((await req('GET', '/login.html')).status, 200);
  server.close();
});

await test('login com usuário e senha: cookie HttpOnly abre a API; senha errada e usuário errado falham', async () => {
  const { server, req } = await serve({ password: 'Senha-Forte-123', user: 'familia' });
  assert.equal((await req('POST', '/api/login', { body: { user: 'familia', password: 'errada' } })).status, 401);
  assert.equal((await req('POST', '/api/login', { body: { user: 'outro', password: 'Senha-Forte-123' } })).status, 401);
  const ok = await req('POST', '/api/login', { from: '127.0.0.3', body: { user: 'familia', password: 'Senha-Forte-123' } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  const c = cookie.split(';')[0];
  const st = await req('GET', '/api/state', { from: '127.0.0.3', cookie: c });
  assert.equal(st.status, 200);
  assert.equal(st.json.config.auth.password, undefined, 'a senha nunca vai para outro aparelho');
  assert.equal((await req('GET', '/api/state', { cookie: 'echomap_sess=9999999999999.forjado' })).status, 401);
  const out = await req('POST', '/api/logout', { from: '127.0.0.3', cookie: c });
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
  server.close();
});

await test('5 tentativas erradas bloqueiam o aparelho por 30 s', async () => {
  const { server, req } = await serve({ password: 'abc-12345' });
  for (let i = 0; i < 5; i += 1) assert.equal((await req('POST', '/api/login', { from: '127.0.0.4', body: { password: 'x' } })).status, 401);
  assert.equal((await req('POST', '/api/login', { from: '127.0.0.4', body: { password: 'abc-12345' } })).status, 429);
  server.close();
});

await test('localhost abre direto; com DASHBOARD_TRUST_LOCALHOST=0 também pede login', async () => {
  let s = await serve({ password: 'abc-12345' });
  assert.equal((await s.req('GET', '/api/state', { from: '127.0.0.1' })).status, 200);
  s.server.close();
  s = await serve({ password: 'abc-12345', trustLocalhost: false });
  assert.equal((await s.req('GET', '/api/state', { from: '127.0.0.1' })).status, 401);
  s.server.close();
});

await test('a senha é guardada só como hash scrypt e trocar a senha derruba as sessões', async () => {
  const a = createAuth({ dataDir: dir, password: 'primeira-senha', secret: 'segredo-fixo' });
  const fake = { socket: { remoteAddress: '127.0.0.5' }, headers: {} };
  const cookie = a.login(fake, 'primeira-senha').cookie.split(';')[0];
  const b = createAuth({ dataDir: dir, password: 'segunda-senha', secret: 'segredo-fixo' });
  assert.equal(b.allowed({ socket: { remoteAddress: '127.0.0.5' }, headers: { cookie } }), false);
  assert.equal(a.allowed({ socket: { remoteAddress: '127.0.0.5' }, headers: { cookie } }), true);
  assert.ok(!fs.readFileSync(path.join(dir, 'auth.json'), 'utf8').includes('primeira-senha'), 'senha do .env não vai para data/auth.json');
});

await test('broker MQTT com MQTT_USER/MQTT_PASS: recusa sem senha e aceita a placa com as credenciais', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  await startMqtt(hub, { embeddedBroker: true, port, topicPrefix: 'echomap', username: 'echomap', password: 'mqtt-segredo' });
  await new Promise((r) => setTimeout(r, 200));
  const tryConnect = (opts) => new Promise((resolve) => {
    const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0, connectTimeout: 3000, ...opts });
    c.on('connect', () => { c.end(true); resolve(true); });
    c.on('error', () => { c.end(true); resolve(false); });
  });
  assert.equal(await tryConnect({ clientId: 'intruso' }), false);
  assert.equal(await tryConnect({ clientId: 'intruso2', username: 'echomap', password: 'errada' }), false);
  assert.equal(await tryConnect({ clientId: 'echomap-node1-ABCDEF', username: 'echomap', password: 'mqtt-segredo' }), true);
});

console.log(`${results.length} testes de segurança passaram`);
process.exit(0);
