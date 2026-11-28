/* Áreas de alta colisão: geohash, risk_score, agrupamento, migração idempotente, PRAGMAs,
   retenção e exportação GeoJSON/CSV. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { Hub } from '../server/hub.js';
import { encodeGeohash, decodeGeohash } from '../server/services/geohash.js';
import { attachHotspots, createHotspots, riskScore, toCSV, toGeoJSON } from '../server/services/hotspots.js';
import { createAuth } from '../server/auth.js';
import { createZones } from '../server/zones.js';
import { createApp } from '../server/app.js';

const results = [];
const test = async (name, fn) => { await fn(); results.push(name); console.log(`ok ${results.length} - ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echomap-hot-'));
const DAY = 86400000;

/* 1 m em latitude ~ 0,000009°; Recife (CESAR School, Bairro do Recife) */
const BASE = { lat: -8.06335, lon: -34.87112 };
const near = (dLatM, dLonM) => ({ lat: BASE.lat + dLatM * 0.000009, lon: BASE.lon + dLonM * 0.0000091 });

await test('geohash: valor de referência, ida e volta e precisão 8', () => {
  assert.equal(encodeGeohash(57.64911, 10.40744, 11), 'u4pruydqqvj'); /* exemplo clássico do geohash.org */
  const h = encodeGeohash(BASE.lat, BASE.lon, 8);
  assert.equal(h.length, 8);
  const c = decodeGeohash(h);
  assert.ok(Math.abs(c.lat - BASE.lat) <= c.latErr && Math.abs(c.lon - BASE.lon) <= c.lonErr);
  assert.ok(c.latErr * 2 * 111000 < 25 && c.lonErr * 2 * 111000 < 45, 'célula de ~19 x 38 m');
  assert.throws(() => encodeGeohash(91, 0));
});

await test('agrupamento: pontos a poucos metros caem na mesma célula; a 100 m, em outra', () => {
  const cellOf = (p) => encodeGeohash(p.lat, p.lon, 8);
  const c = decodeGeohash(cellOf(BASE));
  const inside = { lat: c.lat + c.latErr / 3, lon: c.lon - c.lonErr / 3 };
  assert.equal(cellOf(inside), cellOf({ lat: c.lat, lon: c.lon }));
  assert.notEqual(cellOf(near(100, 0)), cellOf(BASE));
});

await test('risk_score: sobe com frequência, TTC crítico e proximidade; cai com o tempo; fica em 0..100', () => {
  const now = Date.now();
  const base = { eventCount: 3, criticalTtcCount: 0, avgMinDistanceCm: 100, lastSeen: now };
  const s = riskScore(base, now);
  assert.ok(s > 0 && s < 100);
  assert.ok(riskScore({ ...base, eventCount: 10 }, now) > s);
  assert.ok(riskScore({ ...base, criticalTtcCount: 2 }, now) > s);
  assert.ok(riskScore({ ...base, avgMinDistanceCm: 30 }, now) > s);
  assert.ok(riskScore({ ...base, lastSeen: now - 60 * DAY }, now) < s);
  assert.equal(riskScore({ ...base, eventCount: 0 }, now), 0);
  assert.ok(riskScore({ ...base, eventCount: 1000, criticalTtcCount: 1000 }, now) <= 100);
});

await test('banco: PRAGMAs (WAL, synchronous NORMAL, foreign_keys) e migração idempotente sem perder dados', () => {
  const file = path.join(dir, 'mig.db');
  const db1 = openDb(file);
  assert.equal(db1.raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(Number(db1.raw.prepare('PRAGMA synchronous').get().synchronous), 1);
  assert.equal(Number(db1.raw.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
  createHotspots(db1).record({ ...BASE, ts: Date.now(), type: 'NEAR_MISS', data: { side: 'L', value: 40, ttc: 0.8 } });
  db1.raw.close();
  const db2 = openDb(file); /* segunda abertura: migra de novo sem erro e sem apagar nada */
  assert.equal(createHotspots(db2).count(), 1);
  const idx = db2.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  for (const i of ['idx_events_type_ts', 'idx_events_ts', 'idx_hotspots_score', 'idx_hotspots_last_seen', 'idx_readings_ts']) assert.ok(idx.includes(i), `índice ${i}`);
  db2.raw.close();
});

await test('célula: contagens, lados, TTC crítico e distância média atualizados juntos', () => {
  const db = openDb(path.join(dir, 'cell.db'));
  const store = createHotspots(db);
  const now = Date.now();
  store.record({ ...BASE, ts: now - 5000, type: 'NEAR_MISS', data: { side: 'L', value: 60, ttc: 1.4, reason: 'ttc' } });
  store.record({ ...BASE, ts: now - 3000, type: 'NEAR_MISS', data: { side: 'R', value: 20, reason: 'close' } });
  const last = store.record({ ...BASE, ts: now, type: 'IMPACT', data: { value: 4.1, unit: 'g' } });
  assert.equal(last.eventCount, 3);
  assert.equal(last.criticalTtcCount, 1); /* só a batida: TTC 1,4 s não é crítico (<= 1 s) */
  assert.equal(last.avgMinDistanceCm, 40); /* média das quase colisões; a batida não tem distância */
  assert.deepEqual([last.leftHits, last.rightHits], [1, 1]);
  assert.equal(last.firstSeen, now - 5000);
  assert.equal(last.lastSeen, now);
  assert.equal(store.record({ ...BASE, ts: now, type: 'FALL', data: {} }), null, 'queda não é barreira urbana');
  store.record({ ...near(200, 0), ts: now, type: 'NEAR_MISS', data: { side: 'L', value: 100 } });
  const list = store.list();
  assert.equal(list.length, 2);
  assert.ok(list[0].riskScore >= list[1].riskScore, 'ordenado pelo risco');
  assert.equal(store.list({ minScore: list[0].riskScore }).length, 1);
  db.raw.close();
});

await test('hub: ocorrência usa o GPS de até ±5 s, mesmo quando a posição chega depois', async () => {
  const db = openDb(path.join(dir, 'hub.db'));
  const config = { offlineAfterMs: 10000, thresholds: { nearMissCm: 50, impactG: 3 }, retentionDays: 30, safeZones: [], anchor: {} };
  const hub = new Hub({ db, config });
  const updates = [];
  attachHotspots({ hub, db, onUpdate: (h) => updates.push(h), retryMs: 150 });
  const now = Date.now();
  db.insertReading('node1', now - 2000, 'location', BASE);
  hub.emit('event', { id: 1, deviceId: 'node1', ts: now, type: 'NEAR_MISS', data: { side: 'L', value: 50, ttc: 0.9 } });
  assert.equal(updates.length, 1);
  /* sem GPS ainda: a posição chega 1 s depois e a nova tentativa acha */
  hub.emit('event', { id: 2, deviceId: 'node2', ts: now, type: 'NEAR_MISS', data: { side: 'R', value: 30 } });
  db.insertReading('node2', now + 1000, 'location', near(300, 0));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(updates.length, 2);
  hub.emit('event', { id: 3, deviceId: 'node3', ts: now, type: 'NEAR_MISS', data: { value: 30 } }); /* sem GPS nenhum: ignorado */
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(updates.length, 2);
  clearInterval(hub.watchdog); clearInterval(hub.pinger); clearInterval(hub.purger);
  db.raw.close();
});

await test('primeira abertura monta a tabela a partir das ocorrências antigas com GPS', () => {
  const db = openDb(path.join(dir, 'old.db'));
  const t = Date.now() - 3 * DAY;
  db.insertReading('node1', t + 1000, 'location', BASE);
  db.insertEvent('node1', t, 'NEAR_MISS', 'warning', { side: 'L', value: 45 });
  db.insertEvent('node1', t + 1000000, 'NEAR_MISS', 'warning', { side: 'L', value: 45 }); /* sem GPS perto: fica de fora */
  const hub = { on: () => {} };
  const store = attachHotspots({ hub, db });
  assert.equal(store.count(), 1);
  db.raw.close();
});

await test('retenção: telemetria antiga sai; ocorrências e áreas de risco ficam', () => {
  const db = openDb(path.join(dir, 'ret.db'));
  const old = Date.now() - 40 * DAY;
  db.insertReading('node1', old, 'proximity', { distL: 50 });
  db.insertReading('node1', Date.now(), 'proximity', { distL: 60 });
  db.insertEvent('node1', old, 'NEAR_MISS', 'warning', { side: 'L', value: 45 });
  createHotspots(db).record({ ...BASE, ts: old, type: 'NEAR_MISS', data: { side: 'L', value: 45 } });
  db.purgeOlderThan(Date.now() - 30 * DAY);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM readings').get().n, 1);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
  assert.equal(createHotspots(db).count(), 1);
  db.raw.close();
});

await test('exportação: GeoJSON FeatureCollection válido ([lng, lat]) e CSV com cabeçalho', () => {
  const h = { cellId: '7nx2q5jw', centerLat: -8.0633, centerLng: -34.8711, eventCount: 4, criticalTtcCount: 1, avgMinDistanceCm: 41.5,
    leftHits: 3, rightHits: 1, firstSeen: Date.UTC(2026, 10, 1), lastSeen: Date.UTC(2026, 10, 27), label: 'Travessia, "Rua X"', riskScore: 63.2 };
  const gj = toGeoJSON([h]);
  assert.equal(gj.type, 'FeatureCollection');
  const f = gj.features[0];
  assert.equal(f.type, 'Feature');
  assert.equal(f.geometry.type, 'Point');
  assert.deepEqual(f.geometry.coordinates, [-34.8711, -8.0633]);
  assert.equal(f.properties.risk_score, 63.2);
  assert.equal(f.properties.first_seen, '2026-11-01T00:00:00.000Z');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(gj)));
  const csv = toCSV([h]).trim().split('\n');
  assert.equal(csv[0], 'cell_id,lat,lng,risk_score,event_count,critical_ttc_count,avg_min_distance_cm,left_hits,right_hits,first_seen,last_seen,label');
  assert.match(csv[1], /^7nx2q5jw,-8\.0633000,-34\.8711000,63\.2,4,1,41\.5,3,1,/);
  assert.ok(csv[1].endsWith('"Travessia, ""Rua X"""'), 'texto com vírgula e aspas escapado');
});

await test('API: /api/hotspots filtra por risco e /api/hotspots/export entrega GeoJSON e CSV', async () => {
  const db = openDb(path.join(dir, 'api.db'));
  const hotspots = createHotspots(db);
  const now = Date.now();
  for (let i = 0; i < 6; i += 1) hotspots.record({ ...BASE, ts: now - i * 1000, type: 'NEAR_MISS', data: { side: 'L', value: 25, ttc: 0.7 } });
  hotspots.record({ ...near(500, 0), ts: now, type: 'NEAR_MISS', data: { side: 'R', value: 140 } });
  const config = { defaultDeviceId: 'node1', thresholds: {}, mqtt: { embeddedBroker: false }, serial: {}, anchor: {}, discovery: {}, safeZones: [] };
  const app = createApp({
    config, db, hub: { listDevices: () => [] }, hotspots,
    usb: { state: {}, publicState: () => ({}) },
    auth: createAuth({ dataDir: dir, password: 'x-12345678' }),
    zones: createZones({ db, dataDir: dir, initial: [], onChange: () => {} }),
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = (p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], disp: res.headers['content-disposition'], body: t }));
  }).on('error', reject));
  const all = JSON.parse((await get('/api/hotspots')).body);
  assert.equal(all.count, 2);
  assert.ok(all.hotspots[0].riskScore > all.hotspots[1].riskScore);
  const top = JSON.parse((await get(`/api/hotspots?min_score=${all.hotspots[0].riskScore}`)).body);
  assert.equal(top.count, 1);
  assert.equal((await get('/api/hotspots?min_score=500')).status, 400);
  const gj = await get('/api/hotspots/export?format=geojson');
  assert.match(gj.type, /application\/geo\+json/);
  assert.match(gj.disp, /attachment; filename="echomap-barreiras-.*\.geojson"/);
  assert.equal(JSON.parse(gj.body).features.length, 2);
  const csv = await get('/api/hotspots/export?format=csv');
  assert.match(csv.type, /text\/csv/);
  assert.equal(csv.body.trim().split('\n').length, 3);
  assert.equal((await get('/api/hotspots/export?format=kml')).status, 400);
  server.close();
  db.raw.close();
});

console.log(`${results.length} testes de áreas de risco passaram`);
