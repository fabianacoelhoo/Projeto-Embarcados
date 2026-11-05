import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/* SQLite nativo do Node (>= 22.13), sem dependencia compilada.
   readings = series temporais (proximidade, localizacao, imu, status)
   events   = ocorrencias que os responsaveis precisam ver/reconhecer */
export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT,
      created_at INTEGER NOT NULL,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_readings ON readings(device_id, kind, ts);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      data TEXT NOT NULL,
      acked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_events ON events(device_id, ts);
  `);

  const q = {
    upsertDevice: db.prepare(`INSERT INTO devices(id, name, created_at, last_seen) VALUES (?, ?, ?, ?)
                              ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`),
    renameDevice: db.prepare('UPDATE devices SET name = ? WHERE id = ?'),
    listDevices: db.prepare('SELECT * FROM devices ORDER BY id'),
    insertReading: db.prepare('INSERT INTO readings(device_id, ts, kind, data) VALUES (?, ?, ?, ?)'),
    readings: db.prepare(`SELECT ts, data FROM readings WHERE device_id = ? AND kind = ? AND ts >= ?
                          ORDER BY ts DESC LIMIT ?`),
    insertEvent: db.prepare('INSERT INTO events(device_id, ts, type, severity, data) VALUES (?, ?, ?, ?, ?)'),
    eventsAll: db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?'),
    eventsByDevice: db.prepare('SELECT * FROM events WHERE device_id = ? ORDER BY ts DESC LIMIT ?'),
    getEvent: db.prepare('SELECT * FROM events WHERE id = ?'),
    ackEvent: db.prepare('UPDATE events SET acked_at = ? WHERE id = ? AND acked_at IS NULL'),
    purgeReadings: db.prepare('DELETE FROM readings WHERE ts < ?'),
  };

  const rowToEvent = (r) => r && ({
    id: Number(r.id),
    deviceId: r.device_id,
    ts: Number(r.ts),
    type: r.type,
    severity: r.severity,
    ackedAt: r.acked_at == null ? null : Number(r.acked_at),
    data: JSON.parse(r.data),
  });

  return {
    /* manter a referencia: se o DatabaseSync for coletado pelo GC, os statements sao finalizados */
    raw: db,
    upsertDevice(id, name, ts) { q.upsertDevice.run(id, name, ts, ts); },
    renameDevice(id, name) { q.renameDevice.run(name, id); },
    listDevices() {
      return q.listDevices.all().map((r) => ({
        id: r.id, name: r.name, createdAt: Number(r.created_at), lastSeen: r.last_seen == null ? null : Number(r.last_seen),
      }));
    },
    insertReading(deviceId, ts, kind, data) { q.insertReading.run(deviceId, ts, kind, JSON.stringify(data)); },
    readings(deviceId, kind, sinceTs, limit = 5000) {
      return q.readings.all(deviceId, kind, sinceTs, limit)
        .map((r) => ({ ts: Number(r.ts), ...JSON.parse(r.data) }))
        .reverse();
    },
    insertEvent(deviceId, ts, type, severity, data) {
      const res = q.insertEvent.run(deviceId, ts, type, severity, JSON.stringify(data));
      return rowToEvent(q.getEvent.get(Number(res.lastInsertRowid)));
    },
    events({ deviceId, limit = 100 } = {}) {
      const rows = deviceId ? q.eventsByDevice.all(deviceId, limit) : q.eventsAll.all(limit);
      return rows.map(rowToEvent);
    },
    ackEvent(id, ts) {
      q.ackEvent.run(ts, id);
      return rowToEvent(q.getEvent.get(id));
    },
    purgeOlderThan(ts) { q.purgeReadings.run(ts); },
  };
}
