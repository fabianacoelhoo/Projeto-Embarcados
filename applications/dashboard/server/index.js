import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import config, { ROOT } from './config.js';
import { openDb } from './db.js';
import { Hub } from './hub.js';
import { startMqtt } from './sources/mqtt.js';
import { SerialManager } from './sources/serial.js';
import { hostWifi, savedPassword } from './hostwifi.js';
import { startDiscovery } from './discovery.js';
import { createAuth } from './auth.js';
import { createZones } from './zones.js';
import { computeHeatmap, parseTime } from './heatmap.js';

const db = openDb(config.dbFile);
const hub = new Hub({ db, config });
const usb = new SerialManager(hub, config.serial);
hub.commandSenders.push((deviceId, command) => usb.send(deviceId, command));

const dataDir = path.dirname(config.dbFile);
/* senha do painel para outros aparelhos (no próprio computador abre direto) */
const auth = createAuth({ dataDir, password: config.auth?.password || null, enabled: config.auth?.enabled !== false });
/* zonas seguras (fixas e âncoras rápidas) no SQLite; o data/zones.json antigo é importado uma vez */
const zones = createZones({
  db,
  dataDir,
  initial: config.safeZones ?? [],
  onChange: (list) => { config.safeZones = list; hub.resetZones(); broadcast({ type: 'zones', zones: list }); },
});
config.safeZones = zones.list();
hub.zones = zones;

/* pedidos vindos do próprio computador (o navegador do PC); a senha do Wi-Fi nunca sai para a rede */
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

/* ---------------- HTTP / API ---------------- */
const app = express();
app.use(express.json({ limit: '32kb' }));

/* quem não está no próprio computador precisa entrar com a senha (cookie de sessão) */
const OPEN_PATHS = new Set(['/login.html', '/tokens.css', '/api/login', '/favicon.ico']);
app.use((req, res, next) => {
  if (auth.allowed(req) || OPEN_PATHS.has(req.path) || req.path.startsWith('/vendor/fonts/')) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Entre com a senha do painel.', login: true });
  res.redirect(302, `/login.html?next=${encodeURIComponent(req.originalUrl)}`);
});
app.post('/api/login', (req, res) => {
  const out = auth.login(req, req.body?.password);
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  res.setHeader('Set-Cookie', out.cookie);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', auth.logoutCookie()); res.json({ ok: true }); });

app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules', 'leaflet', 'dist')));
app.use('/vendor/qrcode', express.static(path.join(ROOT, 'node_modules', 'qrcode-generator', 'dist')));
/* fontes servidas localmente (o painel funciona sem internet): Plus Jakarta Sans na interface e JetBrains Mono nos números */
app.use('/vendor/fonts/sans', express.static(path.join(ROOT, 'node_modules', '@fontsource', 'plus-jakarta-sans', 'files'), { maxAge: '30d' }));
app.use('/vendor/fonts/mono', express.static(path.join(ROOT, 'node_modules', '@fontsource', 'jetbrains-mono', 'files'), { maxAge: '30d' }));

const localIps = () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

const publicConfig = (req) => ({
  thresholds: config.thresholds,
  safeZones: zones.list(),
  wifiPlaces: db.places(),
  anchor: { radiusM: config.anchor?.radiusM ?? 100, hours: config.anchor?.hours ?? 4 },
  /* a senha só aparece para quem abriu o painel no próprio computador */
  auth: { enabled: auth.enabled, remote: !isLocal(req), password: auth.enabled && isLocal(req) ? auth.password : undefined },
  offlineAfterMs: config.offlineAfterMs,
  server: {
    host: os.hostname(),
    ips: localIps(),
    mqttPort: config.mqtt.embeddedBroker ? config.mqtt.port : null,
    discovery: Boolean(config.discovery?.enabled),
    serial: usb.state.path,
  },
  portalPassword: config.portal?.password ?? 'echomap123',
});

app.get('/api/state', (req, res) => {
  res.json({ devices: hub.listDevices(), events: db.events({ limit: 100 }), config: publicConfig(req), serial: usb.publicState() });
});

app.get('/api/devices/:id/readings', (req, res) => {
  const kind = String(req.query.kind ?? 'proximity');
  /* intervalo exato (ex.: leituras em volta de uma ocorrencia): ?from=ms&to=ms, no maximo 1 h */
  if (req.query.from != null && req.query.to != null) {
    const from = Number(req.query.from), to = Math.min(Number(req.query.to), from + 3600000);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return res.status(400).json({ error: 'from/to invalidos' });
    return res.json(db.readingsRange(req.params.id, kind, from, to));
  }
  const minutes = Math.min(Number(req.query.minutes ?? 10), 60 * 24 * 7);
  res.json(db.readings(req.params.id, kind, Date.now() - minutes * 60000));
});

/* historico de calibracoes (feitas, que falharam e restauracoes de fabrica), mais recente primeiro */
app.get('/api/devices/:id/calibrations', (req, res) => {
  res.json(db.calibrations(req.params.id, Math.min(Number(req.query.limit ?? 20), 100)));
});

app.patch('/api/devices/:id', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : null;
  const d = hub.renameDevice(req.params.id, name);
  if (!d) return res.status(404).json({ error: 'dispositivo nao encontrado' });
  res.json(d);
});

/* comandos que o painel pode mandar para a placa (o resto e recusado).
   Vao pelo Wi-Fi (MQTT) e, com a placa no USB e o servidor lendo a Serial, tambem pelo cabo. */
const PANEL_COMMANDS = new Set(['locate', 'portal', 'wifi', 'diag', 'server', 'haptic', 'calibrate_start', 'calibrate_stop', 'calibrate_reset', 'wifi_scan']);
/* padroes da linguagem haptica (firmware >= 1.6, include/haptic_engine.h) */
const HAPTIC_PATTERNS = ['static', 'proximity', 'approach', 'prealert', 'heartbeat', 'confirm', 'locate'];
const isIpv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((n) => Number(n) <= 255);
function buildCommand(body) {
  const cmd = body?.cmd;
  if (!PANEL_COMMANDS.has(cmd)) return { error: `comando invalido (aceitos: ${[...PANEL_COMMANDS].join(', ')})` };
  if (cmd === 'server') {
    /* onde a placa procura o servidor MQTT: "auto" (descoberta na rede) ou um IP fixo */
    const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : 'auto';
    if (host !== 'auto' && !isIpv4(host)) return { error: 'Servidor: use "auto" ou um IP como 192.168.0.10.' };
    return { command: { cmd, host } };
  }
  if (cmd === 'haptic') {
    if (!HAPTIC_PATTERNS.includes(body.pattern)) return { error: `Padrão inválido (aceitos: ${HAPTIC_PATTERNS.join(', ')}).` };
    return { command: { cmd, pattern: body.pattern } };
  }
  if (cmd === 'calibrate_start') {
    /* calibracao assistida: 10 a 120 s andando (padrao 30) */
    const s = body.duration_s == null ? 30 : Number(body.duration_s);
    if (!Number.isInteger(s) || s < 10 || s > 120) return { error: 'Duração da calibração: de 10 a 120 segundos.' };
    return { command: { cmd, duration_s: s } };
  }
  if (cmd !== 'wifi') return { command: { cmd } };
  const ssid = typeof body.ssid === 'string' ? body.ssid.trim() : '';
  const pass = typeof body.pass === 'string' ? body.pass : '';
  const host = typeof body.host === 'string' ? body.host.trim() : '';
  if (!ssid || Buffer.byteLength(ssid) > 32) return { error: 'Digite o nome da rede (até 32 caracteres).' };
  if (pass && (pass.length < 8 || pass.length > 63)) return { error: 'A senha do Wi-Fi tem de 8 a 63 caracteres (deixe vazia para rede aberta).' };
  if (host && host !== 'auto' && !isIpv4(host)) return { error: 'Servidor: use "auto" ou um IP como 192.168.0.10.' };
  return { command: { cmd, ssid, pass, ...(host ? { host } : {}) } };
}

app.post('/api/devices/:id/command', (req, res) => {
  const { command, error } = buildCommand(req.body);
  if (error) return res.status(400).json({ sent: false, error });
  const d = hub.devices.get(req.params.id);
  const onUsb = usb.state.status === 'connected' && (usb.state.deviceId ?? config.serial.deviceId) === req.params.id;
  if (!d?.online && !onUsb) return res.status(409).json({ sent: false, error: 'O EchoMap está desconectado: ligue o cabo USB ou use o celular (3 cliques no botão).' });
  if (command.cmd === 'wifi') hub.expectReconnect(req.params.id, 45000); /* teste da rede nova + volta */
  if (command.cmd === 'server') hub.expectReconnect(req.params.id, 15000); /* a placa refaz a conexao MQTT */
  const ok = hub.sendCommand(req.params.id, command);
  res.status(ok ? 202 : 503).json({ sent: ok });
});

/* ---------------- cabo USB ---------------- */
app.get('/api/serial', (req, res) => res.json(usb.publicState()));
app.post('/api/serial/connect', async (req, res) => {
  const path = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
  if (!path) return res.status(400).json({ error: 'Escolha uma porta.' });
  await usb.connect(path);
  res.json(usb.publicState());
});
app.post('/api/serial/auto', async (req, res) => { await usb.auto(); res.json(usb.publicState()); });
app.post('/api/serial/release', (req, res) => {
  const minutes = Math.min(Math.max(Number(req.body?.minutes ?? 3), 1), 15);
  usb.release(minutes);
  res.json(usb.publicState());
});

/* ---------------- Wi-Fi deste computador ---------------- */
app.get('/api/host-wifi', async (req, res) => {
  const info = await hostWifi();
  res.json({ ...info, canReadPassword: info.canReadPassword && isLocal(req) });
});
app.post('/api/host-wifi/password', async (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Por segurança, a senha salva só pode ser lida abrindo o painel no próprio computador (localhost).' });
  const out = await savedPassword(req.body?.ssid);
  res.status(out.error ? 422 : 200).json(out);
});

/* ---------------- zonas seguras ---------------- */
app.get('/api/zones', (req, res) => res.json(zones.list()));
app.post('/api/zones', (req, res) => {
  const out = zones.add(req.body);
  res.status(out.error ? 400 : 201).json(out.error ? { error: out.error } : out.zone);
});
app.patch('/api/zones/:id', (req, res) => {
  const out = zones.update(req.params.id, req.body);
  res.status(out.error ? out.status ?? 400 : 200).json(out.error ? { error: out.error } : out.zone);
});
app.delete('/api/zones/:id', (req, res) => {
  const out = zones.remove(req.params.id);
  res.status(out.error ? out.status ?? 400 : 200).json(out.error ? { error: out.error } : { ok: true });
});

/* ---------------- âncora rápida (zona segura dinâmica) ---------------- */
/* POST {deviceId?, radiusM?, hours?, lat?, lng?}: sem lat/lng usa a posição atual do dispositivo */
app.post('/api/safe-zones/anchor', (req, res) => {
  const b = req.body ?? {};
  const deviceId = typeof b.deviceId === 'string' && b.deviceId ? b.deviceId : config.defaultDeviceId;
  const radiusM = b.radiusM == null ? undefined : Number(b.radiusM);
  const hours = b.hours == null ? undefined : Number(b.hours);
  if (radiusM !== undefined && !(radiusM >= 20 && radiusM <= 5000)) return res.status(400).json({ error: 'O raio vai de 20 m a 5.000 m.' });
  if (hours !== undefined && !(hours > 0 && hours <= 24)) return res.status(400).json({ error: 'A âncora dura de alguns minutos a 24 h.' });
  const lat = b.lat == null ? undefined : Number(b.lat), lon = b.lng ?? b.lon;
  const out = hub.createAnchor(deviceId, { lat, lon: lon == null ? undefined : Number(lon), radiusM, durationMs: hours ? hours * 3600000 : undefined });
  res.status(out.error ? out.status ?? 400 : 201).json(out.error ? { error: out.error } : out.zone);
});
app.delete('/api/safe-zones/anchor', (req, res) => {
  const deviceId = String(req.query.deviceId ?? req.body?.deviceId ?? config.defaultDeviceId);
  const z = hub.removeAnchor(deviceId);
  res.status(z ? 200 : 404).json(z ? { ok: true, zone: z } : { error: 'Nenhuma âncora ativa para esse dispositivo.' });
});

/* ---------------- mapa de calor de barreiras urbanas ---------------- */
/* GET /api/heatmap?from=<iso|ms>&to=<iso|ms>&min_severity=info|warning|serious|critical&types=NEAR_MISS&deviceId= */
app.get('/api/heatmap', (req, res) => {
  const to = parseTime(req.query.to, Date.now());
  const from = parseTime(req.query.from, to - 7 * 86400000);
  if (from == null || to == null || from > to) return res.status(400).json({ error: 'Período inválido: use datas ISO (2026-11-25) ou milissegundos, com from antes de to.' });
  const minSeverity = String(req.query.min_severity ?? 'info');
  if (!['info', 'warning', 'serious', 'critical'].includes(minSeverity)) return res.status(400).json({ error: 'min_severity: info, warning, serious ou critical.' });
  const types = String(req.query.types ?? 'NEAR_MISS').split(',').map((s) => s.trim()).filter((s) => /^[A-Z_]{2,30}$/.test(s));
  res.json(computeHeatmap(db, { from, to, minSeverity, types: types.length ? types : ['NEAR_MISS'], deviceId: req.query.deviceId || null }));
});

/* ---------------- locais conhecidos por Wi-Fi (fallback do GPS em ambiente interno) ---------------- */
app.get('/api/wifi-places', (req, res) => res.json(db.places()));
app.post('/api/wifi-places', (req, res) => {
  const b = req.body ?? {};
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 40) : '';
  const bssid = typeof b.bssid === 'string' ? b.bssid.trim().toUpperCase() : '';
  const minRssi = b.minRssi == null ? -80 : Math.round(Number(b.minRssi));
  const lat = b.lat == null || b.lat === '' ? null : Number(b.lat), lng = b.lng == null || b.lng === '' ? null : Number(b.lng);
  if (!name) return res.status(400).json({ error: 'Dê um nome para o local (ex.: Casa, CESAR School).' });
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(bssid)) return res.status(400).json({ error: 'BSSID inválido (formato AA:BB:CC:DD:EE:FF).' });
  if (!(minRssi >= -100 && minRssi <= -20)) return res.status(400).json({ error: 'Sinal mínimo entre -100 e -20 dBm.' });
  if ((lat == null) !== (lng == null) || (lat != null && !(Math.abs(lat) <= 90 && Math.abs(lng) <= 180))) return res.status(400).json({ error: 'Posição inválida.' });
  if (db.placesByBssid(bssid).some((p) => p.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'Essa rede já está cadastrada com esse nome.' });
  const place = db.insertPlace({ name, bssid, minRssi, lat, lng, isSafeZone: b.isSafeZone !== false });
  broadcast({ type: 'wifiPlaces', places: db.places() });
  res.status(201).json(place);
});
app.delete('/api/wifi-places/:id', (req, res) => {
  if (!db.deletePlace(Number(req.params.id))) return res.status(404).json({ error: 'Local não encontrado.' });
  broadcast({ type: 'wifiPlaces', places: db.places() });
  res.json({ ok: true });
});

app.get('/api/events', (req, res) => {
  res.json(db.events({ deviceId: req.query.deviceId || undefined, limit: Math.min(Number(req.query.limit ?? 100), 1000) }));
});

app.post('/api/events/:id/ack', (req, res) => {
  const evt = hub.ackEvent(Number(req.params.id));
  if (!evt) return res.status(404).json({ error: 'evento nao encontrado' });
  res.json(evt);
});

/* ---------------- WebSocket (tempo real) ---------------- */
/* noDelay: atualizacoes pequenas e frequentes saem na hora; sem compressao por mensagem (custa mais do que economiza) */
const server = http.createServer({ noDelay: true }, app);
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false, verifyClient: ({ req }) => auth.allowed(req) });

const broadcast = (msg) => {
  const text = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(text);
};

hub.on('reading', (r) => broadcast({ type: 'reading', ...r }));
hub.on('event', (e) => broadcast({ type: 'event', event: e }));
hub.on('eventUpdated', (e) => broadcast({ type: 'eventUpdated', event: e }));
hub.on('device', (d) => broadcast({ type: 'device', device: d }));
hub.on('log', (l) => broadcast({ type: 'log', ...l }));
usb.on('state', (s) => broadcast({ type: 'serial', serial: s }));
hub.on('event', (e) => console.log(`[EVENTO] ${e.deviceId} ${e.type} (${e.severity}) ${JSON.stringify(e.data)}`));

/* ---------------- Fontes de dados ---------------- */
startMqtt(hub, config.mqtt).catch((err) => {
  console.error(`[MQTT] Nao foi possivel iniciar o broker: ${err.message}`);
  process.exit(1);
});
usb.start().catch((err) => console.warn(`[USB] ${err.message}`));

/* âncoras rápidas vencidas: a cada 60 s saem das zonas e entram na linha do tempo */
setInterval(() => {
  for (const z of zones.expire(Date.now())) hub.addEvent(z.deviceId ?? config.defaultDeviceId, 'ANCHOR_EXPIRED', { zone: z.name, lat: z.lat, lon: z.lon });
}, 60000).unref();

server.listen(config.httpPort, () => {
  console.log(`[HTTP] Dashboard em http://localhost:${config.httpPort}`);
  const ips = localIps();
  if (auth.enabled) {
    console.log(`[SENHA] Neste computador o painel abre direto. Em outro aparelho (celular, outro PC), use a senha: ${auth.password}`);
    console.log(`        ${auth.fromConfig ? '(definida em config.json, "auth.password")' : `(gerada e guardada em ${path.relative(ROOT, auth.file)}; troque em config.json, "auth.password")`}`);
  }
  if (ips.length) console.log(`[INFO] IPs desta maquina: ${ips.join(', ')} (so precisa deles se a placa usar IP fixo em vez de "auto")`);
  if (config.mqtt.embeddedBroker) startDiscovery(config.discovery, { mqttPort: config.mqtt.port, httpPort: config.httpPort });
});
