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

/* Com a placa no USB e no Wi-Fi ao mesmo tempo, os mesmos dados chegam pelas duas fontes.
   Leituras: vale o MQTT enquanto ele estiver ativo. Eventos: descartados pelo par tipo + "t" da placa. */
const PREFER_MQTT_MS = 3000;
const EVENT_DEDUP_MS = 120000;

/* Normaliza cada tipo de leitura para um formato estavel que o dashboard entende. */
const normalizers = {
  proximity: (p) => ({
    mode: p.mode ?? null,
    distL: dist(p.distL), rawL: dist(p.rawL),
    distR: dist(p.distR), rawR: dist(p.rawR),
    bzL: num(p.bzL), bzR: num(p.bzR),
    thr: num(p.thr), angle: num(p.angle), pot: num(p.pot),
    near: num(p.near), /* NEAR_MISS_CM do firmware: o painel usa esse valor quando vier */
    deviceT: num(p.t),
  }),
  location: (p) => ({
    lat: num(p.lat), lon: num(p.lon ?? p.lng),
    accuracyM: num(p.acc ?? p.accuracy), speed: num(p.speed), sats: num(p.sats),
  }),
  imu: (p) => {
    const ax = num(p.ax), ay = num(p.ay), az = num(p.az);
    const g = ax != null && ay != null && az != null ? Math.sqrt(ax * ax + ay * ay + az * az) : num(p.g);
    /* gMax = maior modulo desde a ultima mensagem (o firmware mede a 100 Hz); tilt = inclinacao em graus */
    return { ax, ay, az, gx: num(p.gx), gy: num(p.gy), gz: num(p.gz), g, gMax: num(p.gMax), tilt: num(p.tilt) };
  },
  /* teste dos ultrassonicos (comando "diag"): resultado por lado */
  diag: (p) => {
    const side = (s) => s && typeof s === 'object' ? {
      trig: num(s.trig), echo: num(s.echo), idleHigh: s.idleHigh === true, echoOk: s.echoOk === true,
      cm: num(s.cm) != null && s.cm >= 0 ? s.cm : null, mv: num(s.mv) != null && s.mv >= 0 ? s.mv : null, cross: s.cross === true,
    } : null;
    return { L: side(p.diag?.L), R: side(p.diag?.R) };
  },
  status: (p) => ({
    battery: num(p.battery ?? p.bat), rssi: num(p.rssi), fw: p.fw ?? null,
    uptimeS: num(p.up), heap: num(p.heap),
    /* rede (firmware >= 1.2): IP, rede Wi-Fi, canal, servidor, descoberta automatica, eventos na fila */
    ip: typeof p.ip === 'string' ? p.ip : null, ssid: typeof p.ssid === 'string' ? p.ssid : null,
    channel: num(p.ch), broker: typeof p.broker === 'string' && p.broker ? p.broker : null,
    autoBroker: typeof p.auto === 'boolean' ? p.auto : null, queued: num(p.q),
    /* firmware >= 1.4: a placa esta conectada ao broker MQTT (pelo cabo da para ver quando nao esta) */
    mqtt: typeof p.mq === 'boolean' ? p.mq : null,
    portal: p.portal === true, lowLatency: p.lowlat == null ? null : Boolean(p.lowlat),
    /* portal e teste de rede nova (firmware >= 1.3) */
    ap: typeof p.ap === 'string' ? p.ap : null,
    wifiErr: typeof p.werr === 'string' ? p.werr : null,
    wifiTest: typeof p.wtest === 'string' ? p.wtest : null,
    wifiTry: typeof p.wtry === 'string' ? p.wtry : null,
    /* firmware >= 1.3: estado do Wi-Fi e rede que esta tentando (chega na hora pelo cabo USB) */
    wstate: typeof p.wstate === 'string' ? p.wstate : null,
    wcfg: typeof p.wcfg === 'string' ? p.wcfg : null,
    deviceIdReported: typeof p.id === 'string' ? p.id : null,
  }),
};

function classify(channel, payload) {
  if (payload.event) return 'event';
  const c = channel.toLowerCase();
  if (c === 'pong' || 'pong' in payload) return 'pong';
  if (c === 'diag' || 'diag' in payload) return 'diag';
  if (c === 'events' || c === 'event') return 'event';
  if (c === 'location' || c === 'gps') return 'location';
  if (c === 'imu' || c === 'motion') return 'imu';
  if (c === 'status') return 'status';
  if ('distL' in payload || 'distR' in payload) return 'proximity';
  if ('lat' in payload) return 'location';
  if ('ax' in payload) return 'imu';
  if ('fw' in payload || 'rssi' in payload || 'battery' in payload) return 'status';
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
    this.recentEvents = new Map(); /* chave do evento -> ts, para descartar duplicatas */
    this.pings = new Map(); /* id do ping -> { deviceId, sentAt } */
    this.pingSeq = 0;

    for (const d of db.listDevices()) {
      this.devices.set(d.id, { ...d, online: false, source: null, latest: {} });
    }

    this.watchdog = setInterval(() => this.checkOffline(), 2000);
    /* latencia real: ida e volta servidor -> placa -> servidor pelo MQTT */
    this.pinger = setInterval(() => this.pingDevices(), config.pingEveryMs ?? 5000);
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
    const kind = classify(channel, data);
    const known = this.devices.get(id);
    const mqttActive = source !== 'mqtt' && known?.lastMqttAt != null && now - known.lastMqttAt < PREFER_MQTT_MS;

    if (kind === 'pong') {
      this.onPong(id, data, now);
      return;
    }

    if (kind === 'event') {
      const { event, type, t, ...rest } = data;
      const evtType = event ?? type ?? 'UNKNOWN';
      if (this.isDuplicateEvent(id, evtType, num(t), rest.side, now)) return;
      if (!mqttActive) this.touch(id, now, source);
      this.addEvent(id, evtType, { ...rest, deviceT: num(t) });
      return;
    }
    if (mqttActive) return; /* mesma leitura ja chegou (ou vai chegar) pelo MQTT */

    const device = this.touch(id, now, source);
    if (source === 'mqtt') device.lastMqttAt = now;

    const normalize = normalizers[kind] ?? ((p) => p);
    const reading = normalize(data);
    device.latest[kind] = { ts: now, ...reading };
    this.persist(id, kind, now, reading);
    this.emit('reading', { deviceId: id, kind, ts: now, data: reading });

    if (kind === 'location') this.ruleGeofence(id, reading);
    if (kind === 'imu') this.ruleImpact(id, reading, now);
    if (kind === 'status') this.ruleBattery(id, reading);
  }

  isDuplicateEvent(id, type, deviceT, side, now) {
    if (deviceT == null) return false;
    for (const [k, ts] of this.recentEvents) { /* Map mantem a ordem de insercao: os mais velhos vem primeiro */
      if (now - ts <= EVENT_DEDUP_MS) break;
      this.recentEvents.delete(k);
    }
    const key = `${id}|${type}|${deviceT}|${side ?? ''}`;
    if (this.recentEvents.has(key)) return true;
    this.recentEvents.set(key, now);
    return false;
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
    this.db.renameDevice(id, d.name);
    this.emit('device', this.publicDevice(d));
    return this.publicDevice(d);
  }

  /* Comando para o dispositivo (ex.: tocar buzzer para localizar). O firmware ainda nao
     assina esse topico; fica pronto para as funcoes de controle parental.
     Retorna false se nao ha broker; true nao garante que a placa recebeu. */
  sendCommand(deviceId, command) {
    /* cada canal (MQTT, cabo USB) diz se a placa estava nele; true se pelo menos um entregou */
    let delivered = false;
    for (const send of this.commandSenders) if (send(deviceId, command) !== false) delivered = true;
    return delivered;
  }

  pingDevices() {
    const now = Date.now();
    for (const [n, p] of this.pings) if (now - p.sentAt > 15000) this.pings.delete(n); /* sem resposta */
    for (const d of this.devices.values()) {
      if (!d.online || d.lastMqttAt == null || now - d.lastMqttAt > PREFER_MQTT_MS) continue;
      const n = ++this.pingSeq;
      this.pings.set(n, { deviceId: d.id, sentAt: now });
      this.sendCommand(d.id, { cmd: 'ping', id: n });
    }
  }

  onPong(id, data, now) {
    const p = this.pings.get(Number(data.pong));
    if (!p || p.deviceId !== id) return;
    this.pings.delete(Number(data.pong));
    const d = this.devices.get(id);
    if (!d) return;
    const rtt = now - p.sentAt;
    const prev = d.latest.net;
    /* media movel para o numero nao pular a cada medida; guarda tambem a ultima e a pior recente */
    const avg = prev?.rttAvgMs != null ? Math.round(prev.rttAvgMs * 0.7 + rtt * 0.3) : rtt;
    const samples = [...(prev?.samples ?? []), rtt].slice(-12);
    const net = { rttMs: rtt, rttAvgMs: avg, rttMaxMs: Math.max(...samples), samples };
    d.latest.net = { ts: now, ...net };
    this.persist(id, 'net', now, { rttMs: rtt, rttAvgMs: avg });
    this.emit('reading', { deviceId: id, kind: 'net', ts: now, data: net });
  }

  /* a placa vai sair do ar de proposito (ex.: testando outra rede): sem alerta de "sem sinal" nesse periodo */
  expectReconnect(id, ms) {
    const d = this.devices.get(id);
    if (d) d.quietUntil = Date.now() + ms;
  }

  /* o broker avisou que a conexao da placa caiu: offline na hora, sem esperar offlineAfterMs */
  linkDown(id) {
    const d = this.devices.get(id);
    if (!d || !d.online || d.source !== 'mqtt') return;
    d.lastSeen = Math.min(d.lastSeen, Date.now() - this.config.offlineAfterMs - 1);
    this.checkOffline();
  }

  checkOffline() {
    const now = Date.now();
    for (const d of this.devices.values()) {
      if (d.online && now - d.lastSeen > this.config.offlineAfterMs) {
        d.online = false;
        /* trocando de Wi-Fi a pedido do painel: a queda e esperada, entao sem alerta */
        if (!(d.quietUntil > now)) {
          this.rule.set(d.id, { ...this.rule.get(d.id), wentOffline: true });
          this.addEvent(d.id, 'DEVICE_OFFLINE', { lastSeen: d.lastSeen });
        }
        this.emit('device', this.publicDevice(d));
      }
    }
  }

  /* ---------- regras (base para o controle parental) ---------- */

  /* zonas mudaram pelo painel: a proxima posicao vale como "primeira leitura" (sem alerta falso de saida) */
  resetZones() {
    for (const [id, st] of this.rule) this.rule.set(id, { ...st, zone: undefined });
  }

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
    /* quem manda gMax e o firmware com MPU-6050: ele mesmo detecta queda/impacto
       a 100 Hz e publica FALL/IMPACT em events; aqui so para outras fontes */
    if (imu.gMax != null) return;
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
