/* Testes da senha do painel e das zonas seguras (sem rede, sem placa): npm test */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../server/auth.js';
import { createZones, validateZone } from '../server/zones.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echomap-test-'));
let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log(`ok ${n} - ${name}`); };
const reqFrom = (addr, cookie) => ({ socket: { remoteAddress: addr }, headers: cookie ? { cookie } : {} });

test('gera senha na primeira vez e reaproveita depois', () => {
  const a = createAuth({ dataDir: dir });
  assert.match(a.password, /^[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(createAuth({ dataDir: dir }).password, a.password);
});

test('localhost entra direto; outro aparelho precisa de cookie', () => {
  const a = createAuth({ dataDir: dir });
  assert.equal(a.allowed(reqFrom('127.0.0.1')), true);
  assert.equal(a.allowed(reqFrom('::ffff:127.0.0.1')), true);
  assert.equal(a.allowed(reqFrom('192.168.1.20')), false);
});

test('login certo gera cookie valido; cookie forjado nao entra', () => {
  const a = createAuth({ dataDir: dir, password: 'Senha-Teste' });
  const out = a.login(reqFrom('192.168.1.21'), 'senha-teste');
  assert.equal(out.ok, true);
  const cookie = out.cookie.split(';')[0];
  assert.equal(a.allowed(reqFrom('192.168.1.21', cookie)), true);
  assert.equal(a.allowed(reqFrom('192.168.1.21', 'echomap_sess=99999999999999.xyz')), false);
  /* trocar a senha derruba as sessoes antigas */
  assert.equal(createAuth({ dataDir: dir, password: 'outra-senha' }).allowed(reqFrom('192.168.1.21', cookie)), false);
});

test('5 senhas erradas bloqueiam o aparelho por 30 s', () => {
  const a = createAuth({ dataDir: dir, password: 'abcd-efgh' });
  const r = reqFrom('192.168.1.30');
  for (let i = 0; i < 5; i += 1) assert.equal(a.login(r, 'x').status, 401);
  assert.equal(a.login(r, 'abcd-efgh').status, 429);
  assert.equal(a.login(reqFrom('192.168.1.31'), 'abcd-efgh').ok, true);
});

test('auth desligada libera todo mundo', () => {
  assert.equal(createAuth({ dataDir: dir, enabled: false }).allowed(reqFrom('10.0.0.5')), true);
});

test('validacao das zonas', () => {
  assert.ok(validateZone({ name: 'Casa', lat: -8.109656, lon: -34.906301, radiusM: 100 }).zone);
  assert.ok(validateZone({ name: '', lat: 0, lon: 0, radiusM: 100 }).error);
  assert.ok(validateZone({ name: 'X', lat: 95, lon: 0, radiusM: 100 }).error);
  assert.ok(validateZone({ name: 'X', lat: 0, lon: 0, radiusM: 10 }).error);
});

test('zonas: nascem do config, persistem e avisam a cada mudanca', () => {
  const zdir = path.join(dir, 'z');
  const changes = [];
  const z = createZones({ dataDir: zdir, initial: [{ name: 'Casa', lat: -8.109656, lon: -34.906301, radiusM: 100 }], onChange: (l) => changes.push(l.length) });
  assert.equal(z.list().length, 1);
  assert.equal(changes.length, 0);
  const { zone } = z.add({ name: 'Escola', lat: -8.11, lon: -34.9, radiusM: 200 });
  assert.equal(z.update(zone.id, { radiusM: 300 }).zone.radiusM, 300);
  assert.equal(createZones({ dataDir: zdir, initial: [] }).list().length, 2); /* lido do arquivo, nao do config */
  assert.equal(z.remove(zone.id).ok, true);
  assert.equal(z.remove('nao-existe').status, 404);
  assert.deepEqual(changes, [2, 2, 1]);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} testes do painel passaram`);
