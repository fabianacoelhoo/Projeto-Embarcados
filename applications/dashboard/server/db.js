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
  migrate(db);

  const q = {
    insertCalibration: db.prepare('INSERT INTO calibrations(device_id, ts, ok, data) VALUES (?, ?, ?, ?)'),
    /* Fase 4: zonas seguras (fixas e ancoras dinamicas), locais por Wi-Fi e mapa de calor */
    zonesAll: db.prepare('SELECT * FROM safe_zones ORDER BY created_at, id'),
    zoneCount: db.prepare('SELECT COUNT(*) AS n FROM safe_zones'),
    zoneGet: db.prepare('SELECT * FROM safe_zones WHERE id = ?'),
    zoneInsert: db.prepare(`INSERT INTO safe_zones(id, name, lat, lng, radius_m, type, expires_at, device_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    zoneUpdate: db.prepare('UPDATE safe_zones SET name = ?, lat = ?, lng = ?, radius_m = ? WHERE id = ?'),
    zoneDelete: db.prepare('DELETE FROM safe_zones WHERE id = ?'),
    zonesExpired: db.prepare("SELECT * FROM safe_zones WHERE type = 'dynamic' AND expires_at IS NOT NULL AND expires_at <= ?"),
    anchorOf: db.prepare("SELECT * FROM safe_zones WHERE type = 'dynamic' AND device_id = ? ORDER BY created_at DESC LIMIT 1"),
    placesAll: db.prepare('SELECT * FROM known_wifi_places ORDER BY name, id'),
    placesByBssid: db.prepare('SELECT * FROM known_wifi_places WHERE bssid = ?'),
    placeInsert: db.prepare('INSERT INTO known_wifi_places(name, bssid, min_rssi, lat, lng, is_safe_zone) VALUES (?, ?, ?, ?, ?, ?)'),
    placeGet: db.prepare('SELECT * FROM known_wifi_places WHERE id = ?'),
    placeDelete: db.prepare('DELETE FROM known_wifi_places WHERE id = ?'),
    nearestLocation: db.prepare(`SELECT ts, data FROM readings WHERE device_id = ? AND kind = 'location' AND ts BETWEEN ? AND ?
      ORDER BY ABS(ts - ?) LIMIT 1`),
    calibrations: db.prepare('SELECT * FROM calibrations WHERE device_id = ? ORDER BY ts DESC LIMIT ?'),
    setCalibratedAt: db.prepare('UPDATE devices SET calibrated_at = ? WHERE id = ?'),
    upsertDevice: db.prepare(`INSERT INTO devices(id, name, created_at, last_seen) VALUES (?, ?, ?, ?)
                              ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`),
    renameDevice: db.prepare('UPDATE devices SET name = ? WHERE id = ?'),
    listDevices: db.prepare('SELECT * FROM devices ORDER BY id'),
    insertReading: db.prepare('INSERT INTO readings(device_id, ts, kind, data) VALUES (?, ?, ?, ?)'),
    readings: db.prepare(`SELECT ts, data FROM readings WHERE device_id = ? AND kind = ? AND ts >= ?
                          ORDER BY ts DESC LIMIT ?`),
    readingsRange: db.prepare(`SELECT ts, data FROM readings WHERE device_id = ? AND kind = ? AND ts BETWEEN ? AND ?
                               ORDER BY ts LIMIT 2000`),
    insertEvent: db.prepare('INSERT INTO events(device_id, ts, type, severity, data) VALUES (?, ?, ?, ?, ?)'),
    eventsAll: db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?'),
    eventsByDevice: db.prepare('SELECT * FROM events WHERE device_id = ? ORDER BY ts DESC LIMIT ?'),
    getEvent: db.prepare('SELECT * FROM events WHERE id = ?'),
    ackEvent: db.prepare('UPDATE events SET acked_at = ? WHERE id = ? AND acked_at IS NULL'),
    purgeReadings: db.prepare('DELETE FROM readings WHERE ts < ?'),
  };

  const rowToZone = (r) => r && ({
    id: r.id, name: r.name, lat: r.lat, lon: r.lng, radiusM: Number(r.radius_m), type: r.type,
    expiresAt: r.expires_at == null ? null : Number(r.expires_at), deviceId: r.device_id ?? null, createdAt: Number(r.created_at),
  });
  const rowToPlace = (r) => r && ({
    id: Number(r.id), name: r.name, bssid: r.bssid, minRssi: Number(r.min_rssi),
    lat: r.lat ?? null, lng: r.lng ?? null, isSafeZone: Boolean(r.is_safe_zone),
  });

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
        calibratedAt: r.calibrated_at == null ? null : Number(r.calibrated_at),
      }));
    },
    insertReading(deviceId, ts, kind, data) { q.insertReading.run(deviceId, ts, kind, JSON.stringify(data)); },
    readings(deviceId, kind, sinceTs, limit = 5000) {
      return q.readings.all(deviceId, kind, sinceTs, limit)
        .map((r) => ({ ts: Number(r.ts), ...JSON.parse(r.data) }))
        .reverse();
    },
    readingsRange(deviceId, kind, fromTs, toTs) {
      return q.readingsRange.all(deviceId, kind, fromTs, toTs).map((r) => ({ ts: Number(r.ts), ...JSON.parse(r.data) }));
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

    /* zonas seguras: type "fixed" (cadastradas) ou "dynamic" (ancora rapida, com expires_at) */
    zones() { return q.zonesAll.all().map(rowToZone); },
    zoneCount() { return Number(q.zoneCount.get().n); },
    zone(id) { return rowToZone(q.zoneGet.get(id)); },
    insertZone(z) {
      q.zoneInsert.run(z.id, z.name, z.lat, z.lon, z.radiusM, z.type ?? 'fixed', z.expiresAt ?? null, z.deviceId ?? null, z.createdAt ?? Date.now());
      return this.zone(z.id);
    },
    updateZone(z) { q.zoneUpdate.run(z.name, z.lat, z.lon, z.radiusM, z.id); return this.zone(z.id); },
    deleteZone(id) { return Number(q.zoneDelete.run(id).changes) > 0; },
    expiredZones(ts) { return q.zonesExpired.all(ts).map(rowToZone); },
    anchorOf(deviceId) { return rowToZone(q.anchorOf.get(deviceId)); },

    /* locais conhecidos por Wi-Fi (BSSID em maiusculas, "AA:BB:CC:DD:EE:FF") */
    places() { return q.placesAll.all().map(rowToPlace); },
    placesByBssid(bssid) { return q.placesByBssid.all(String(bssid).toUpperCase()).map(rowToPlace); },
    insertPlace(p) {
      const res = q.placeInsert.run(p.name, p.bssid.toUpperCase(), p.minRssi, p.lat ?? null, p.lng ?? null, p.isSafeZone ? 1 : 0);
      return rowToPlace(q.placeGet.get(Number(res.lastInsertRowid)));
    },
    deletePlace(id) { return Number(q.placeDelete.run(id).changes) > 0; },

    /* mapa de calor: ocorrencias de um periodo e a posicao mais proxima no tempo */
    eventsInRange({ types, from, to, deviceId }) {
      const where = ['ts BETWEEN ? AND ?'];
      const args = [from, to];
      if (types?.length) { where.push(`type IN (${types.map(() => '?').join(',')})`); args.push(...types); }
      if (deviceId) { where.push('device_id = ?'); args.push(deviceId); }
      return db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY ts LIMIT 20000`).all(...args).map(rowToEvent);
    },
    nearestLocation(deviceId, ts, tolMs) {
      const r = q.nearestLocation.get(deviceId, ts - tolMs, ts + tolMs, ts);
      return r ? { ts: Number(r.ts), ...JSON.parse(r.data) } : null;
    },
    /* calibracao assistida: historico de resultados (feitos, que falharam, e "padroes de fabrica") */
    insertCalibration(deviceId, ts, ok, data) {
      q.insertCalibration.run(deviceId, ts, ok ? 1 : 0, JSON.stringify(data));
      if (ok) q.setCalibratedAt.run(ts, deviceId);
    },
    calibrations(deviceId, limit = 20) {
      return q.calibrations.all(deviceId, limit).map((r) => ({ id: Number(r.id), ts: Number(r.ts), ok: Boolean(r.ok), ...JSON.parse(r.data) }));
    },
  };
}

/* Migracoes idempotentes: rodam a cada abertura e so mudam o que falta, sem apagar dados.
   Cada passo: CREATE ... IF NOT EXISTS, ou ALTER TABLE so se a coluna ainda nao existe. */
function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
export function migrate(db) {
  /* Fase 3: calibracao assistida */
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calibrations ON calibrations(device_id, ts);
  `);
  if (!hasColumn(db, 'devices', 'calibrated_at')) db.exec('ALTER TABLE devices ADD COLUMN calibrated_at INTEGER');

  /* Fase 4: zonas seguras no banco (antes em data/zones.json; importadas uma vez por zones.js),
     com ancoras rapidas (type 'dynamic' + expires_at), locais conhecidos por Wi-Fi e indice do mapa de calor */
  db.exec(`
    CREATE TABLE IF NOT EXISTS safe_zones (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      radius_m INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'fixed',
      expires_at INTEGER,
      device_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS known_wifi_places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      bssid TEXT NOT NULL,
      min_rssi INTEGER NOT NULL DEFAULT -80,
      lat REAL,
      lng REAL,
      is_safe_zone INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_wifi_places_bssid ON known_wifi_places(bssid);
    CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
  `);
  /* bancos criados durante o desenvolvimento da Fase 4 sem a coluna de dono da ancora */
  if (!hasColumn(db, 'safe_zones', 'device_id')) db.exec('ALTER TABLE safe_zones ADD COLUMN device_id TEXT');
}
