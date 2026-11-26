/* Testes da Fase 4 (sem rede, sem placa): npm test
   - mapa de calor: posição do evento ou do GPS mais próximo (±5 s), peso pelo TTC, agregação, filtros;
   - assinatura de Wi-Fi: casa local cadastrado só com GPS ruim, posição marcada como wifi_indoor,
     e não gera "saiu da zona segura" estando num local seguro;
   - âncora rápida: 2 cliques cria/remove, sem posição falha, expira e vai para a linha do tempo. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { Hub } from '../server/hub.js';
import { createZones } from '../server/zones.js';
import { computeHeatmap, eventWeight, parseTime } from '../server/heatmap.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echomap-f4-'));
let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log(`ok ${n} - ${name}`); };
const CASA = { lat: -8.109656, lon: -34.906301 };

function setup(name, { zones: zoneList = [] } = {}) {
  const db = openDb(path.join(dir, `${name}.db`));
  const config = { persistEveryMs: 1000, retentionDays: 30, pingEveryMs: 5000, offlineAfterMs: 10000, safeZones: [], anchor: { radiusM: 100, hours: 4 } };
  const hub = new Hub({ db, config });
  const zones = createZones({ db, initial: zoneList, onChange: (l) => { config.safeZones = l; hub.resetZones(); } });
  config.safeZones = zones.list();
  hub.zones = zones;
  const close = () => { clearInterval(hub.watchdog); clearInterval(hub.pinger); clearInterval(hub.purger); db.raw.close(); };
  const send = (channel, obj, source = 'mqtt') => hub.ingest({ deviceId: 'node1', channel, payload: Buffer.from(JSON.stringify(obj)), source });
  return { db, hub, zones, config, close, send };
}

test('mapa de calor: posição do GPS mais próximo (±5 s), peso pelo TTC, pontos a ~5 m somam', () => {
  const { db, close } = setup('heat');
  try {
    const t0 = 1_800_000_000_000;
    db.insertReading('node1', t0, 'location', { lat: -8.1100, lon: -34.9000 });
    db.insertReading('node1', t0 + 60000, 'location', { lat: -8.2000, lon: -34.8000 });
    const ev = (ts, data) => db.raw.prepare('INSERT INTO events(device_id, ts, type, severity, data) VALUES (?, ?, ?, ?, ?)')
      .run('node1', ts, 'NEAR_MISS', 'warning', JSON.stringify(data));
    ev(t0 + 3000, { reason: 'ttc', ttc: 0.3, side: 'L' });        /* GPS 3 s antes: casa */
    ev(t0 - 4000, { reason: 'close', side: 'R' });                /* GPS 4 s depois: mesmo ponto */
    ev(t0 + 30000, { reason: 'ttc', ttc: 1.4 });                  /* 30 s de qualquer GPS: sem posição */
    ev(t0 + 60500, { reason: 'ttc', ttc: 1.0, lat: -8.3, lng: -34.7 }); /* posição no próprio evento */
    db.raw.prepare('INSERT INTO events(device_id, ts, type, severity, data) VALUES (?, ?, ?, ?, ?)')
      .run('node1', t0 + 1000, 'FALL', 'critical', '{}');
    const h = computeHeatmap(db, { from: t0 - 10000, to: t0 + 70000 });
    assert.deepEqual([h.total, h.matched, h.unmatched, h.fromEvent, h.points.length], [4, 3, 1, 1, 2]);
    const home = h.points.find((p) => Math.abs(p[0] + 8.11) < 1e-6);
    assert.ok(Math.abs(home[2] - (eventWeight({ severity: 'warning', data: { reason: 'ttc', ttc: 0.3 } }) + 0.7)) < 0.01);
    assert.equal(h.max, home[2]);
    assert.equal(computeHeatmap(db, { from: t0 - 10000, to: t0 + 70000, minSeverity: 'serious' }).total, 0);
    assert.equal(computeHeatmap(db, { from: t0 - 10000, to: t0 + 70000, types: ['FALL'] }).matched, 1);
  } finally { close(); }
});

test('mapa de calor: TTC menor pesa mais; datas ISO e milissegundos', () => {
  const w = (ttc) => eventWeight({ severity: 'warning', data: { reason: 'ttc', ttc } });
  assert.ok(w(0.2) > w(1.0) && w(1.0) > w(1.5) && w(1.5) >= 0.5);
  assert.equal(parseTime('1800000000000'), 1800000000000);
  assert.equal(parseTime('2026-11-25T00:00:00Z'), Date.UTC(2026, 10, 25));
  assert.equal(parseTime('ontem'), null);
  assert.equal(parseTime(undefined, 7), 7);
});

test('Wi-Fi: com GPS ruim, rede cadastrada vira "Casa (Wi-Fi)" e posição wifi_indoor', () => {
  const { db, hub, close, send } = setup('wifi', { zones: [{ name: 'Casa', ...CASA, radiusM: 100 }] });
  try {
    db.insertPlace({ name: 'Casa', bssid: 'ec:08:6b:12:34:56', minRssi: -75, lat: CASA.lat, lng: CASA.lon, isSafeZone: true });
    send('wifi', { type: 'wifi_fingerprint', aps: [{ bssid: 'AA:00:00:00:00:01', rssi: -50, ssid: 'Vizinho' }, { bssid: 'EC:08:6B:12:34:56', rssi: -62, ssid: 'Casa' }], t: 1 });
    const d = hub.devices.get('node1');
    assert.deepEqual([d.latest.indoor.placeName, d.latest.indoor.source, d.latest.location.source, d.latest.location.placeName], ['Casa', 'wifi_indoor', 'wifi_indoor', 'Casa']);
    /* sinal fraco demais (abaixo do mínimo): não casa */
    send('wifi', { type: 'wifi_fingerprint', aps: [{ bssid: 'EC:08:6B:12:34:56', rssi: -88, ssid: 'Casa' }], t: 2 });
    assert.equal(hub.devices.get('node1').latest.indoor.placeName, null);
  } finally { close(); }
});

test('Wi-Fi: com GPS bom a assinatura não troca a posição', () => {
  const { db, hub, close, send } = setup('wifi-gps');
  try {
    db.insertPlace({ name: 'CESAR School', bssid: '11:22:33:44:55:66', minRssi: -80, lat: -8.06, lng: -34.87, isSafeZone: false });
    send('location', { lat: -8.10, lon: -34.90, sats: 8 });
    send('wifi', { aps: [{ bssid: '11:22:33:44:55:66', rssi: -55, ssid: 'CESAR' }] });
    const d = hub.devices.get('node1');
    assert.equal(d.latest.indoor.placeName, null);
    assert.equal(d.latest.location.source, undefined);
  } finally { close(); }
});

test('Wi-Fi: num local seguro, um GPS ruim de dentro de casa não vira "saiu da zona segura"', () => {
  const { db, hub, close, send } = setup('wifi-geo', { zones: [{ name: 'Casa', ...CASA, radiusM: 100 }] });
  try {
    db.insertPlace({ name: 'Casa', bssid: 'EC:08:6B:12:34:56', minRssi: -75, lat: CASA.lat, lng: CASA.lon, isSafeZone: true });
    send('wifi', { aps: [{ bssid: 'EC:08:6B:12:34:56', rssi: -60, ssid: 'Casa' }] });
    send('location', { lat: -8.1150, lon: -34.9150, sats: 3 }); /* ~1,1 km: fix ruim, de dentro */
    assert.equal(db.events({ limit: 50 }).filter((e) => e.type === 'GEOFENCE_EXIT').length, 0);
    /* sem o local por Wi-Fi a mesma posição sai da zona */
    hub.devices.get('node1').latest.indoor = null;
    send('location', { lat: -8.1150, lon: -34.9150, sats: 3 });
    send('location', { lat: -8.1150, lon: -34.9151, sats: 3 });
    assert.ok(db.events({ limit: 50 }).some((e) => e.type === 'GEOFENCE_EXIT'));
  } finally { close(); }
});

test('âncora: 2 cliques criam no ponto do GPS, 2 cliques de novo removem', () => {
  const { db, hub, zones, close, send } = setup('anchor');
  try {
    send('events', { event: 'ANCHOR_TOGGLE', type: 'quick_anchor_toggle', lat: -8.05, lng: -34.88, t: 100 });
    const a = zones.anchorFor('node1');
    assert.deepEqual([a.type, a.lat, a.lon, a.radiusM], ['dynamic', -8.05, -34.88, 100]);
    assert.ok(Math.abs(a.expiresAt - Date.now() - 4 * 3600000) < 5000);
    assert.ok(hub.config.safeZones.some((z) => z.type === 'dynamic'));
    send('events', { event: 'ANCHOR_TOGGLE', type: 'quick_anchor_toggle', lat: -8.05, lng: -34.88, t: 200 });
    assert.equal(zones.anchorFor('node1'), null);
    const types = db.events({ limit: 10 }).map((e) => e.type);
    assert.deepEqual(types.slice(0, 2), ['ANCHOR_REMOVED', 'ANCHOR_CREATED']);
    assert.ok(!types.includes('ANCHOR_TOGGLE'));
  } finally { close(); }
});

test('âncora: sem GPS no evento usa a última posição; sem nenhuma, falha e avisa', () => {
  const { db, zones, close, send } = setup('anchor-pos');
  try {
    send('events', { event: 'ANCHOR_TOGGLE', t: 1 });
    assert.equal(zones.anchorFor('node1'), null);
    assert.equal(db.events({ limit: 5 })[0].type, 'ANCHOR_FAILED');
    send('location', { lat: -8.07, lon: -34.89, sats: 7 });
    send('events', { event: 'ANCHOR_TOGGLE', t: 2 });
    assert.equal(zones.anchorFor('node1').lat, -8.07);
  } finally { close(); }
});

test('âncora: expira, sai das zonas e vira evento; zona fixa continua', () => {
  const { db, hub, zones, close } = setup('anchor-exp', { zones: [{ name: 'Casa', ...CASA, radiusM: 100 }] });
  try {
    const now = Date.now();
    hub.createAnchor('node1', { lat: -8.05, lon: -34.88, durationMs: 1000 });
    assert.equal(zones.list().length, 2);
    const gone = zones.expire(now + 5000);
    assert.deepEqual([gone.length, gone[0].deviceId, zones.list().length, zones.list()[0].name], [1, 'node1', 1, 'Casa']);
    assert.equal(zones.expire(now + 10000).length, 0);
    assert.ok(db.events({ limit: 5 }).some((e) => e.type === 'ANCHOR_CREATED' && e.data.by === 'painel'));
  } finally { close(); }
});

test('migração da Fase 4 é idempotente (banco aberto duas vezes)', () => {
  const file = path.join(dir, 'twice.db');
  openDb(file).raw.close();
  const db = openDb(file);
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(['safe_zones', 'known_wifi_places', 'calibrations'].every((t) => tables.includes(t)));
  db.raw.close();
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} testes da Fase 4 passaram`);
