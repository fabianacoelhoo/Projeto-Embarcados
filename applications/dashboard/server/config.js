import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const defaults = {
  httpPort: 3000,
  defaultDeviceId: 'node1',
  mqtt: { embeddedBroker: true, port: 1883, externalUrl: null, topicPrefix: 'echomap' },
  serial: { enabled: false, path: 'COM3', baudRate: 115200, deviceId: 'node1' },
  thresholds: { nearMissCm: 30, impactG: 3.0, lowBatteryPct: 20 },
  offlineAfterMs: 10000,
  persistEveryMs: 1000,
  retentionDays: 30,
  safeZones: [],
  dbFile: path.join(ROOT, 'data', 'echomap.db'),
};

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v)
      : v;
  }
  return out;
}

function load() {
  const file = process.env.ECHOMAP_CONFIG ?? path.join(ROOT, 'config.json');
  let fromFile = {};
  if (fs.existsSync(file)) fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = merge(defaults, fromFile);

  /* variaveis de ambiente tem prioridade (uteis para testar sem editar o arquivo) */
  if (process.env.PORT) cfg.httpPort = Number(process.env.PORT);
  if (process.env.MQTT_PORT) cfg.mqtt.port = Number(process.env.MQTT_PORT);
  if (process.env.MQTT_URL) { cfg.mqtt.externalUrl = process.env.MQTT_URL; cfg.mqtt.embeddedBroker = false; }
  if (process.env.SERIAL_PORT) { cfg.serial.enabled = true; cfg.serial.path = process.env.SERIAL_PORT; }
  return cfg;
}

export default load();
