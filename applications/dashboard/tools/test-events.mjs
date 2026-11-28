/* Testes dos eventos da Fase 1 (sem rede, sem placa): npm test
   - o detector de TTC do simulador (tools/ttc.mjs) bate com o do firmware nos cenários principais;
   - o servidor guarda NEAR_MISS com reason/ttc/v e DISMISSED como "info" (sem alarme). */
import assert from 'node:assert/strict';
import { TtcDetector, nearMissEvent } from './ttc.mjs';
import { Hub, SEVERITY } from '../server/hub.js';

let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log(`ok ${n} - ${name}`); };
const PERIOD = 100;
const run = (det, sig, samples, t0 = 10000) => {
  const out = { reports: [], staticN: 0, maxV: 0 };
  for (let i = 0; i < samples; i += 1) {
    const t = t0 + i * PERIOD;
    const r = det.update(sig(i, t - t0), t);
    out.maxV = Math.max(out.maxV, r.velocityCmS);
    if (r.level === 'static') out.staticN += 1;
    if (r.report) out.reports.push({ ...r, at: t - t0 });
  }
  return out;
};
const noise = (i, a) => a * Math.sin(i * 2.399) * Math.cos(i * 0.731);

test('parede paralela a 40 cm: só aviso local, nenhum crítico', () => {
  const r = run(new TtcDetector(), (i) => (i % 17 === 5 ? -1 : 40 + noise(i, 4)), 600);
  assert.equal(r.reports.length, 0);
  assert.ok(r.staticN > 500);
});

test('120 -> 60 cm em 0,5 s: crítico por TTC com ttc e v no evento', () => {
  const det = new TtcDetector();
  run(det, (i) => 120 + noise(i, 1), 20);
  const r = run(det, (_, t) => (t >= 500 ? 60 : 120 - 120 * (t / 1000)), 8, 12000);
  assert.equal(r.reports.length, 1);
  const evt = nearMissEvent(r.reports[0], 'L', 123);
  assert.equal(evt.reason, 'ttc');
  assert.ok(evt.ttc > 0 && evt.ttc <= 1.5 && evt.v > 15);
});

test('falha de leitura e volta a 50 cm: sem pico falso de velocidade', () => {
  const det = new TtcDetector();
  run(det, () => 50, 10);
  const r = run(det, (i) => ({ 3: 0, 4: -1, 9: 400.5, 12: 260 })[i] ?? 50, 30, 11000);
  assert.equal(r.reports.length, 0);
  assert.ok(r.maxV < 15);
});

test('cooldown de 3 s por lado', () => {
  const det = new TtcDetector();
  const r = run(det, () => 20, 60);
  assert.equal(r.reports.length, 2);
  assert.equal(nearMissEvent(r.reports[0], 'R', 1).reason, 'close');
});

test('servidor: DISMISSED é "info"; NEAR_MISS guarda reason/ttc/v; status traz energia', () => {
  assert.equal(SEVERITY.DISMISSED, 'info');
  const saved = [];
  const db = {
    listDevices: () => [], upsertDevice: () => {}, insertReading: () => {}, purgeOlderThan: () => {},
    insertEvent: (deviceId, ts, type, severity, data) => { const e = { id: saved.length + 1, deviceId, ts, type, severity, data }; saved.push(e); return e; },
  };
  const hub = new Hub({ db, config: { persistEveryMs: 1000, retentionDays: 30, pingEveryMs: 5000, offlineAfterMs: 10000, safeZones: [] } });
  try {
    hub.ingest({ deviceId: 'node1', channel: 'events', payload: Buffer.from(JSON.stringify({ event: 'DISMISSED', cause: 'FALL', value: 3.4, unit: 'g', t: 5000 })), source: 'mqtt' });
    hub.ingest({ deviceId: 'node1', channel: 'events', payload: Buffer.from(JSON.stringify({ event: 'NEAR_MISS', side: 'L', value: 62, reason: 'ttc', ttc: 0.8, v: 78, t: 6000 })), source: 'mqtt' });
    const dismissed = saved.find((e) => e.type === 'DISMISSED');
    const near = saved.find((e) => e.type === 'NEAR_MISS');
    assert.equal(dismissed.severity, 'info');
    assert.equal(dismissed.data.cause, 'FALL');
    assert.deepEqual([near.data.reason, near.data.ttc, near.data.v, near.data.side], ['ttc', 0.8, 78, 'L']);

    /* firmware 1.6: estado de energia no status */
    hub.ingest({ deviceId: 'node1', channel: 'status', payload: Buffer.from(JSON.stringify({ fw: '1.6.0', up: 300, pwr: 'idle', lowlat: 0, t: 7000 })), source: 'mqtt' });
    const st = hub.devices.get('node1').latest.status;
    assert.deepEqual([st.powerState, st.lowLatency], ['idle', false]);
    hub.ingest({ deviceId: 'node1', channel: 'status', payload: Buffer.from(JSON.stringify({ fw: '1.5.0', pwr: 'xyz', t: 8000 })), source: 'mqtt' });
    assert.equal(hub.devices.get('node1').latest.status.powerState, null);
  } finally {
    clearInterval(hub.watchdog); clearInterval(hub.pinger); clearInterval(hub.purger);
  }
});

console.log(`\n${n} testes de eventos passaram`);
