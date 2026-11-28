/* Ponto de entrada: abre o banco, liga as fontes de dados (MQTT e cabo USB), o app HTTP e o WebSocket. */
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import config, { ROOT } from './config.js';
import { openDb } from './db.js';
import { Hub } from './hub.js';
import { startMqtt } from './sources/mqtt.js';
import { SerialManager } from './sources/serial.js';
import { startDiscovery } from './discovery.js';
import { createAuth } from './auth.js';
import { createZones } from './zones.js';
import { createApp, localIps } from './app.js';
import { attachHotspots } from './services/hotspots.js';
import { createEmailNotifier, emailConfigFromEnv } from './services/emailNotifier.js';

const db = openDb(config.dbFile);
const hub = new Hub({ db, config });
const usb = new SerialManager(hub, config.serial);
hub.commandSenders.push((deviceId, command) => usb.send(deviceId, command));

const dataDir = path.dirname(config.dbFile);
/* senha do painel para outros aparelhos (no próprio computador abre direto) */
const auth = createAuth({
  dataDir,
  password: config.auth?.password || null,
  user: config.auth?.user || null,
  secret: config.auth?.secret || null,
  enabled: config.auth?.enabled !== false,
  trustLocalhost: config.auth?.trustLocalhost !== false,
});

let wss = null;
const broadcast = (msg) => {
  if (!wss) return;
  const text = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(text);
};

/* zonas seguras (fixas e âncoras rápidas) no SQLite; o data/zones.json antigo é importado uma vez */
const zones = createZones({
  db,
  dataDir,
  initial: config.safeZones ?? [],
  onChange: (list) => { config.safeZones = list; hub.resetZones(); broadcast({ type: 'zones', zones: list }); },
});
config.safeZones = zones.list();
hub.zones = zones;

/* areas de alta colisao: cada NEAR_MISS/IMPACT com GPS atualiza a celula e avisa o painel */
const hotspots = attachHotspots({ hub, db, onUpdate: (h) => broadcast({ type: 'hotspot', hotspot: h }) });

/* alertas criticos por e-mail (queda, SOS, saida de zona): fila assincrona, nunca trava o servidor */
const email = createEmailNotifier({
  db,
  config: emailConfigFromEnv(process.env),
  deviceOf: (id) => {
    const d = hub.devices.get(id);
    return d ? { name: d.name, online: d.online, source: d.source, battery: d.latest?.status?.battery ?? null } : {};
  },
  whereOf: (id, evt) => {
    const d = hub.devices.get(id);
    const indoor = d ? hub.indoorOf(d) : null;
    if (indoor) return { indoorPlace: indoor.placeName, lat: indoor.lat ?? null, lon: indoor.lon ?? null };
    if (evt?.data?.lat != null && (evt.data.lon ?? evt.data.lng) != null) return { lat: evt.data.lat, lon: evt.data.lon ?? evt.data.lng, ageS: 0 };
    const loc = d?.latest?.location;
    return loc?.lat != null ? { lat: loc.lat, lon: loc.lon, ageS: Math.round((Date.now() - loc.ts) / 1000) } : null;
  },
});
hub.on('event', (e) => email.onEvent(e));

const app = createApp({ config, db, hub, usb, auth, zones, hotspots, email, broadcast });

/* ---------------- WebSocket (tempo real) ---------------- */
/* noDelay: atualizacoes pequenas e frequentes saem na hora; sem compressao por mensagem (custa mais do que economiza) */
const server = http.createServer({ noDelay: true }, app);
wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false, verifyClient: ({ req }) => auth.allowed(req) });

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
    const quem = auth.user ? `o usuário "${auth.user}" e ` : '';
    const local = auth.trustLocalhost ? 'Neste computador o painel abre direto. ' : '';
    /* a senha gerada aparece aqui; a definida no .env nunca é impressa */
    console.log(`[SENHA] ${local}Em outro aparelho (celular, outro PC), use ${quem}${auth.fromConfig ? 'a senha do DASHBOARD_PASS' : `a senha: ${auth.password}`}`);
    console.log(`        ${auth.source}`);
  }
  if (ips.length) console.log(`[INFO] IPs desta maquina: ${ips.join(', ')} (so precisa deles se a placa usar IP fixo em vez de "auto")`);
  const em = email.status({ local: true });
  console.log(`[EMAIL] Alertas por e-mail: ${em.mode === 'disabled' ? 'desativados (EMAIL_ENABLED=1 no .env)' : `${em.mode === 'mock' ? 'modo teste (mock)' : `ativos via ${em.provider}`} para ${em.recipients.join(', ') || '(ninguem)'}${em.problems.length ? ` - falta: ${em.problems.join('; ')}` : ''}`}`);
  console.log(config.mqtt.username ? '[MQTT] Broker com usuário e senha (MQTT_USER/MQTT_PASS).' : '[MQTT] Broker aberto na rede local (defina MQTT_USER e MQTT_PASS no .env para exigir senha).');
  if (config.mqtt.embeddedBroker) startDiscovery(config.discovery, { mqttPort: config.mqtt.port, httpPort: config.httpPort });
});

export { ROOT };
