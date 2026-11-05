import { EventEmitter } from 'node:events';

/* Gravidade de cada tipo de evento. Tipos novos vindos do firmware (ex.: FALL, SOS)
   entram aqui; um tipo desconhecido vira 'info' e continua aparecendo no painel. */
export const SEVERITY = {
  NEAR_MISS: 'warning',
  CRASH: 'critical',
  SOS: 'critical',
  FALL: 'critical',
  IMPACT: 'serious',
  GEOFENCE_EXIT: 'serious',
  GEOFENCE_ENTER: 'info',
  LOW_BATTERY: 'warning',
  DEVICE_OFFLINE: 'serious',
  DEVICE_ONLINE: 'info',
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/* o firmware manda -1 quando o sensor nao detectou nada */
const dist = (v) => (num(v) != null && v >= 0 ? v : null);

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* Normaliza cada tipo de leitura para um formato estavel que o dashboard entende. */
const normalizers = {
  proximity: (p) => ({
    mode: p.mode ?? null,
    distL: dist(p.distL), rawL: dist(p.rawL),
    distR: dist(p.distR), rawR: dist(p.rawR),
    bzL: num(p.bzL), bzR: num(p.bzR),
    thr: num(p.thr), angle: num(p.angle), pot: num(p.pot),
    deviceT: num(p.t),
  }),
  location: (p) => ({
    lat: num(p.lat), lon: num(p.lon ?? p.lng),
    accuracyM: num(p.acc ?? p.accuracy), speed: num(p.speed), sats: num(p.sats),
  }),
  imu: (p) => {
    const ax = num(p.ax), ay = num(p.ay), az = num(p.az);
    const g = ax != null && ay != null && az != null ? Math.sqrt(ax * ax + ay * ay + az * az) : num(p.g);
    return { ax, ay, az, gx: num(p.gx), gy: num(p.gy), gz: num(p.gz), g };
  },
  status: (p) => ({ battery: num(p.battery ?? p.bat), rssi: num(p.rssi), fw: p.fw ?? null }),
};

function classify(channel, payload) {
  if (payload.event) return 'event';
  const c = channel.toLowerCase();
  if (c === 'events' || c === 'event') return 'event';
  if (c === 'location' || c === 'gps') return 'location';
  if (c === 'imu' || c === 'motion') return 'imu';
  if (c === 'status') return 'status';
  if ('distL' in payload || 'distR' in payload) return 'proximity';
  if ('lat' in payload) return 'location';
  if ('ax' in payload) return 'imu';
  return 'other';
}

export class Hub extends EventEmitter {
  constructor({ db, config }) {
    super();
    this.db = db;
    this.config = config;
    this.devices = new Map();
    this.lastPersist = new Map(); /* `${device}:${kind}` -> ts */
    this.rule = new Map(); /* estado das regras por dispositivo */
    this.commandSenders = [];

    for (const d of db.listDevices()) {
      this.devices.set(d.id, { ...d, online: false, source: null, latest: {} });
    }

    this.watchdog = setInterval(() => this.checkOffline(), 2000);
    this.purger = setInterval(() => {
      db.purgeOlderThan(Date.now() - config.retentionDays * 86400000);
    }, 3600000);
  }

  publicDevice(d) {
    return { id: d.id, name: d.name, online: d.online, lastSeen: d.lastSeen, source: d.source, latest: d.latest };
  }

  listDevices() { return [...this.devices.values()].map((d) => this.publicDevice(d)); }

  /* Ponto unico de entrada: MQTT, Serial ou qualquer fonte futura (HTTP, LoRa, app do celular...). */
  ingest({ deviceId, channel = 'telemetry', payload, source }) {
    const id = deviceId || this.config.defaultDeviceId;
    let data = payload;
    if (typeof data === 'string' || Buffer.isBuffer(data)) {
      try { data = JSON.parse(data.toString()); } catch {
        this.emit('log', { deviceId: id, source, line: data.toString() });
        return;
      }
    }
    if (!data || typeof data !== 'object') return;

    const now = Date.now();
    const device = this.touch(id, now, source);
    const kind = classify(channel, data);

    if (kind === 'event') {
      const { event, type, t, ...rest } = data;
      this.addEvent(id, event ?? type ?? 'UNKNOWN', { ...rest, deviceT: num(t) });
      return;
    }

    const normalize = normalizers[kind] ?? ((p) => p);
    const reading = normalize(data);
    device.latest[kind] = { ts: now, ...reading };
    this.persist(id, kind, now, reading);
    this.emit('reading', { deviceId: id, kind, ts: now, data: reading });

    if (kind === 'location') this.ruleGeofence(id, reading);
    if (kind === 'imu') this.ruleImpact(id, reading, now);
    if (kind === 'status') this.ruleBattery(id, reading);
  }

  touch(id, now, source) {
    let d = this.devices.get(id);
    const isNew = !d;
    if (isNew) {
      d = { id, name: null, createdAt: now, lastSeen: now, online: true, source, latest: {} };
      this.devices.set(id, d);
    }
    const wasOffline = !d.online;
    d.lastSeen = now;
    d.online = true;
    d.source = source;
    /* grava last_seen no banco no maximo 1x por intervalo de persistencia */
    if (isNew || now - (d.lastSeenSaved ?? 0) > this.config.persistEveryMs) {
      this.db.upsertDevice(id, d.name, now);
      d.lastSeenSaved = now;
    }
    if (isNew || wasOffline) {
      if (this.rule.get(id)?.wentOffline) this.addEvent(id, 'DEVICE_ONLINE', {});
      this.rule.set(id, { ...this.rule.get(id), wentOffline: false });
      this.emit('device', this.publicDevice(d));
    }
    return d;
  }

  persist(id, kind, now, reading) {
    const key = `${id}:${kind}`;
    if (kind !== 'location' && now - (this.lastPersist.get(key) ?? 0) < this.config.persistEveryMs) return;
    this.lastPersist.set(key, now);
    this.db.insertReading(id, now, kind, reading);
  }

  addEvent(deviceId, type, data) {
    const evt = this.db.insertEvent(deviceId, Date.now(), type, SEVERITY[type] ?? 'info', data);
    this.emit('event', evt);
    return evt;
  }

  ackEvent(id) {
    const evt = this.db.ackEvent(id, Date.now());
    if (evt) this.emit('eventUpdated', evt);
    return evt;
  }

  renameDevice(id, name) {
    const d = this.devices.get(id);
    if (!d) return null;
    d.name = name || null;
    this.db.renameDevice(d.name, id);
    this.emit('device', this.publicDevice(d));
    return this.publicDevice(d);
  }

  /* Comando para o dispositivo (ex.: tocar buzzer para localizar). O firmware ainda nao
     assina esse topico; fica pronto para as funcoes de controle parental. */
  sendCommand(deviceId, command) {
    if (this.commandSenders.length === 0) return false;
    for (const send of this.commandSenders) send(deviceId, command);
    return true;
  }

  checkOffline() {
    const now = Date.now();
    for (const d of this.devices.values()) {
      if (d.online && now - d.lastSeen > this.config.offlineAfterMs) {
        d.online = false;
        this.rule.set(d.id, { ...this.rule.get(d.id), wentOffline: true });
        this.addEvent(d.id, 'DEVICE_OFFLINE', { lastSeen: d.lastSeen });
        this.emit('device', this.publicDevice(d));
      }
    }
  }

  /* ---------- regras (base para o controle parental) ---------- */

  ruleGeofence(id, loc) {
    const zones = this.config.safeZones ?? [];
    if (!zones.length || loc.lat == null || loc.lon == null) return;
    const inside = zones.find((z) => haversineM(loc.lat, loc.lon, z.lat, z.lon) <= z.radiusM) ?? null;
    const st = this.rule.get(id) ?? {};
    const prev = st.zone; /* undefined = primeira leitura */
    if (prev !== undefined && prev?.name !== inside?.name) {
      if (prev && !inside) this.addEvent(id, 'GEOFENCE_EXIT', { zone: prev.name, lat: loc.lat, lon: loc.lon });
      if (inside) this.addEvent(id, 'GEOFENCE_ENTER', { zone: inside.name, lat: loc.lat, lon: loc.lon });
    }
    this.rule.set(id, { ...st, zone: inside });
  }

  ruleImpact(id, imu, now) {
    if (imu.g == null || imu.g < this.config.thresholds.impactG) return;
    const st = this.rule.get(id) ?? {};
    if (now - (st.lastImpact ?? 0) < 5000) return; /* evita rajada de eventos do mesmo impacto */
    this.rule.set(id, { ...st, lastImpact: now });
    this.addEvent(id, 'IMPACT', { value: Number(imu.g.toFixed(2)), unit: 'g', detectedBy: 'server' });
  }

  ruleBattery(id, status) {
    if (status.battery == null) return;
    const st = this.rule.get(id) ?? {};
    const low = status.battery <= this.config.thresholds.lowBatteryPct;
    if (low && !st.lowBattery) this.addEvent(id, 'LOW_BATTERY', { value: status.battery, unit: '%' });
    this.rule.set(id, { ...st, lowBattery: low });
  }
}
