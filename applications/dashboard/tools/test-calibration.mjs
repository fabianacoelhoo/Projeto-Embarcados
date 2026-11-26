/* Testes da calibração assistida no servidor (sem rede, sem placa): npm test
   - migração idempotente do SQLite: banco antigo ganha a tabela e a coluna sem perder dados;
   - progresso não vai para o banco; resultado vai para o histórico e marca o dispositivo como calibrado. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { Hub } from '../server/hub.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echomap-cal-'));
let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log(`ok ${n} - ${name}`); };

test('migração: banco da versão anterior ganha calibrations e devices.calibrated_at sem perder dados', () => {
  const file = path.join(dir, 'antigo.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL, last_seen INTEGER);
            INSERT INTO devices VALUES ('node1', 'Ana', 1000, 2000);`);
  old.close();
  const db = openDb(file);
  const dev = db.listDevices();
  assert.deepEqual([dev.length, dev[0].name, dev[0].calibratedAt], [1, 'Ana', null]);
  db.raw.close();
  const again = openDb(file); /* segunda abertura: nada a fazer, nada quebra */
  assert.equal(again.listDevices()[0].name, 'Ana');
  assert.deepEqual(again.calibrations('node1'), []);
  again.raw.close();
});

test('hub: progresso fica só em memória; resultado vai ao histórico e marca calibrado', () => {
  const db = openDb(path.join(dir, 'novo.db'));
  const hub = new Hub({ db, config: { persistEveryMs: 1000, retentionDays: 30, pingEveryMs: 5000, offlineAfterMs: 10000, safeZones: [] } });
  try {
    const send = (obj) => hub.ingest({ deviceId: 'node1', channel: 'calib', payload: Buffer.from(JSON.stringify(obj)), source: 'mqtt' });
    send({ calib: 'running', elapsed: 12, duration: 30, steps: 21, t: 1 });
    let d = hub.devices.get('node1');
    assert.deepEqual([d.latest.calibration.state, d.latest.calibration.elapsedS, d.latest.calibration.steps], ['running', 12, 21]);
    assert.equal(db.calibrations('node1').length, 0);
    assert.equal(db.readings('node1', 'calibration', 0).length, 0);

    send({ calib: 'done', type: 'calibration_result', ok: true, reason: 'ok', duration: 30, steps: 57, stepMean: 1.42, stepStd: 0.04,
      stepMax: 1.5, noiseL: 1.2, noiseR: -1, impactBefore: 3, impactAfter: 2.5, hystBefore: 10, hystAfter: 5.4, t: 2 });
    const hist = db.calibrations('node1');
    d = hub.devices.get('node1');
    assert.deepEqual([hist.length, hist[0].ok, hist[0].impactAfter, hist[0].hystAfter, hist[0].noiseR], [1, true, 2.5, 5.4, null]);
    assert.ok(d.calibratedAt > 0 && db.listDevices()[0].calibratedAt > 0);

    /* calibração que falhou: fica no histórico, mas não marca calibrado de novo */
    const before = d.calibratedAt;
    send({ calib: 'failed', type: 'calibration_result', ok: false, reason: 'poucos_passos', steps: 3, impactBefore: 2.5, impactAfter: 2.5, t: 3 });
    assert.equal(db.calibrations('node1')[0].ok, false);
    assert.equal(hub.devices.get('node1').calibratedAt, before);

    /* status do firmware 1.7: limiares em uso */
    hub.ingest({ deviceId: 'node1', channel: 'status', payload: Buffer.from(JSON.stringify({ fw: '1.7.0', impG: 2.5, hyst: 5.4, cal: false, t: 4 })), source: 'mqtt' });
    const st = hub.devices.get('node1').latest.status;
    assert.deepEqual([st.impactG, st.hystCm, st.calibrating], [2.5, 5.4, false]);
  } finally {
    clearInterval(hub.watchdog); clearInterval(hub.pinger); clearInterval(hub.purger);
    db.raw.close();
  }
});

test('pela Serial (sem canal): a linha {"calib":...} é reconhecida como calibração', () => {
  const db = openDb(path.join(dir, 'serial.db'));
  const hub = new Hub({ db, config: { persistEveryMs: 1000, retentionDays: 30, pingEveryMs: 5000, offlineAfterMs: 10000, safeZones: [] } });
  try {
    hub.ingest({ deviceId: 'node1', payload: Buffer.from('{"calib":"reset","type":"calibration_result","ok":true,"impactBefore":2.5,"impactAfter":3.0,"hystBefore":5.4,"hystAfter":10,"t":9}'), source: 'serial' });
    assert.equal(db.calibrations('node1')[0].state, 'reset');
  } finally {
    clearInterval(hub.watchdog); clearInterval(hub.pinger); clearInterval(hub.purger);
    db.raw.close();
  }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} testes de calibração passaram`);
