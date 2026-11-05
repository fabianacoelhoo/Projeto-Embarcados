import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import config, { ROOT } from './config.js';
import { openDb } from './db.js';
import { Hub } from './hub.js';
import { startMqtt } from './sources/mqtt.js';
import { startSerial } from './sources/serial.js';

const db = openDb(config.dbFile);
const hub = new Hub({ db, config });

/* ---------------- HTTP / API ---------------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules', 'leaflet', 'dist')));

const publicConfig = () => ({
  thresholds: config.thresholds,
  safeZones: config.safeZones,
  offlineAfterMs: config.offlineAfterMs,
});

app.get('/api/state', (req, res) => {
  res.json({ devices: hub.listDevices(), events: db.events({ limit: 100 }), config: publicConfig() });
});

app.get('/api/devices/:id/readings', (req, res) => {
  const kind = String(req.query.kind ?? 'proximity');
  const minutes = Math.min(Number(req.query.minutes ?? 10), 60 * 24 * 7);
  res.json(db.readings(req.params.id, kind, Date.now() - minutes * 60000));
});

app.patch('/api/devices/:id', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : null;
  const d = hub.renameDevice(req.params.id, name);
  if (!d) return res.status(404).json({ error: 'dispositivo nao encontrado' });
  res.json(d);
});

app.post('/api/devices/:id/command', (req, res) => {
  const ok = hub.sendCommand(req.params.id, req.body ?? {});
  res.status(ok ? 202 : 503).json({ sent: ok });
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
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const broadcast = (msg) => {
  const text = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(text);
};

hub.on('reading', (r) => broadcast({ type: 'reading', ...r }));
hub.on('event', (e) => broadcast({ type: 'event', event: e }));
hub.on('eventUpdated', (e) => broadcast({ type: 'eventUpdated', event: e }));
hub.on('device', (d) => broadcast({ type: 'device', device: d }));
hub.on('event', (e) => console.log(`[EVENTO] ${e.deviceId} ${e.type} (${e.severity}) ${JSON.stringify(e.data)}`));

/* ---------------- Fontes de dados ---------------- */
startMqtt(hub, config.mqtt);
if (config.serial.enabled) startSerial(hub, config.serial);

server.listen(config.httpPort, () => {
  console.log(`[HTTP] Dashboard em http://localhost:${config.httpPort}`);
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  if (ips.length) console.log(`[INFO] IPs desta maquina (use um deles em MQTT_BROKER_IP no config.h): ${ips.join(', ')}`);
});
