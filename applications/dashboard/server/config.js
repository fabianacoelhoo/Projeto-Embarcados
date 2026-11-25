import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const defaults = {
  httpPort: 3000,
  defaultDeviceId: 'node1',
  mqtt: { embeddedBroker: true, port: 1883, externalUrl: null, topicPrefix: 'echomap' },
  /* auto: acha a placa no USB sozinho; path: porta fixa (o mesmo que --serial COM5) */
  serial: { auto: true, path: null, baudRate: 115200, deviceId: 'node1', pollMs: 2000 },
  thresholds: { nearMissCm: 50, impactG: 3.0, lowBatteryPct: 20 },
  offlineAfterMs: 10000,
  pingEveryMs: 5000,
  discovery: { enabled: true, port: 47801, intervalMs: 2000 },
  portal: { password: 'echomap123' },
  /* senha do painel para outros aparelhos; null = gerada na primeira vez (data/auth.json) */
  auth: { enabled: true, password: null },
  persistEveryMs: 1000,
  retentionDays: 30,
  /* zonas iniciais: depois de criado, data/zones.json (editado pela aba Mapa) passa a valer */
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
  if (process.env.SERIAL_PORT) cfg.serial.path = process.env.SERIAL_PORT;
  /* config.json antigo ("enabled": false com uma porta de exemplo): a porta só vale se estava habilitada */
  if (cfg.serial.enabled === false && !process.env.SERIAL_PORT) cfg.serial.path = null;

  /* argumentos de linha de comando funcionam igual no Windows, Linux e macOS:
     npm start -- --serial COM3    npm start -- --port 8080    npm start -- --mqtt-url mqtt://host:1883
     npm start -- --sem-usb        (desliga a detecção automática do cabo USB) */
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  if (arg('serial')) cfg.serial.path = arg('serial');
  if (process.argv.includes('--sem-usb') || process.argv.includes('--no-usb')) { cfg.serial.auto = false; cfg.serial.path = null; }
  if (arg('port')) cfg.httpPort = Number(arg('port'));
  if (arg('mqtt-url')) { cfg.mqtt.externalUrl = arg('mqtt-url'); cfg.mqtt.embeddedBroker = false; }
  return cfg;
}

export default load();
