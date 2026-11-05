/* Simula a ESP32 publicando no broker, no mesmo formato JSON do firmware.
   Uso:
     node tools/simulator.js               -> so os 2 ultrassonicos (igual ao firmware atual)
     node tools/simulator.js --all         -> + GPS, IMU (queda/impacto) e bateria (sensores futuros)
     node tools/simulator.js --gps --imu --status --device node2 --url mqtt://192.168.0.10:1883 */
import mqtt from 'mqtt';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`) || args.includes('--all');
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const url = opt('url', 'mqtt://localhost:1883');
const deviceId = opt('device', 'node1');
const prefix = opt('prefix', 'echomap');
const home = { lat: Number(opt('lat', -23.5505)), lon: Number(opt('lon', -46.6333)) };
const NEAR_MISS_CM = 30;

const client = mqtt.connect(url, { clientId: `sim-${deviceId}-${Date.now() % 10000}` });
const topic = (ch) => `${prefix}/${deviceId}/${ch}`;
const pub = (ch, obj) => client.publish(topic(ch), JSON.stringify(obj));

const start = Date.now();
const millis = () => Date.now() - start;
const noise = (a) => (Math.random() - 0.5) * 2 * a;

let filtL = -1, filtR = -1;
let nearL = false, nearR = false;
let mode = 'RADAR';

function sideDistance(tSec, phase) {
  /* obstaculo que se aproxima e se afasta, com leituras perdidas ocasionais */
  if (Math.random() < 0.04) return -1;
  const d = 110 + 95 * Math.sin(tSec / 3.2 + phase) + noise(4);
  return d > 230 ? -1 : Math.max(4, d);
}

function filter(prev, raw) {
  if (raw < 0) return -1;
  return prev < 0 ? raw : prev * 0.7 + raw * 0.3;
}

function volume(d) {
  if (d < 0 || d > 100) return 0;
  const t = Math.min(1, Math.max(0, (100 - d) / (100 - 15)));
  return 0.15 + t * 0.85;
}

function tickTelemetry() {
  const t = millis() / 1000;
  const rawL = sideDistance(t, 0);
  const rawR = sideDistance(t * 0.8, 2.1);
  filtL = filter(filtL, rawL);
  filtR = filter(filtR, rawR);
  const pot = 0.5 + 0.35 * Math.sin(t / 40);
  const thr = 20 + pot * (200 - 20);

  pub('telemetry', {
    t: millis(), mode,
    distL: +filtL.toFixed(1), rawL: +rawL.toFixed(1),
    distR: +filtR.toFixed(1), rawR: +rawR.toFixed(1),
    bzL: +volume(filtL).toFixed(2), bzR: +volume(filtR).toFixed(2),
    thr: Math.round(thr), angle: mode === 'SIM360' ? Math.round(pot * 360) : 0, pot: +pot.toFixed(2),
  });

  const isNearL = filtL >= 0 && filtL < NEAR_MISS_CM;
  const isNearR = filtR >= 0 && filtR < NEAR_MISS_CM;
  if (isNearL && !nearL) pub('events', { event: 'NEAR_MISS', side: 'L', value: +filtL.toFixed(1), t: millis() });
  if (isNearR && !nearR) pub('events', { event: 'NEAR_MISS', side: 'R', value: +filtR.toFixed(1), t: millis() });
  nearL = isNearL;
  nearR = isNearR;
}

/* caminhada em volta de casa, saindo da zona segura de vez em quando */
let heading = Math.random() * Math.PI * 2;
let pos = { ...home };
function tickGps() {
  heading += noise(0.5);
  const distFromHome = Math.hypot((pos.lat - home.lat) * 111000, (pos.lon - home.lon) * 102000);
  if (distFromHome > 260) heading = Math.atan2(home.lat - pos.lat, home.lon - pos.lon) + noise(0.3);
  const stepM = 6;
  pos.lat += (Math.sin(heading) * stepM) / 111000;
  pos.lon += (Math.cos(heading) * stepM) / 102000;
  pub('location', { lat: +pos.lat.toFixed(6), lon: +pos.lon.toFixed(6), acc: Math.round(5 + Math.random() * 8), sats: 7 + Math.floor(Math.random() * 4) });
}

function tickImu() {
  let ax = noise(0.05), ay = noise(0.05), az = 1 + noise(0.05);
  if (Math.random() < 0.01) { ax = 2.6 + Math.random(); az = 2.2; } /* pancada */
  pub('imu', { ax: +ax.toFixed(3), ay: +ay.toFixed(3), az: +az.toFixed(3) });
}

let battery = 64;
function tickStatus() {
  battery = Math.max(5, battery - 0.4);
  pub('status', { battery: Math.round(battery), rssi: -55 - Math.round(Math.random() * 15), fw: 'sim-0.1' });
}

client.on('connect', () => {
  console.log(`[SIM] Conectado em ${url} como ${deviceId}. Publicando em ${prefix}/${deviceId}/...`);
  setInterval(tickTelemetry, 200); /* TELEMETRY_PERIOD_MS */
  setInterval(() => {
    if (Math.random() < 0.35) {
      pub('events', { event: 'CRASH', t: millis() });
      console.log('[SIM] CRASH (clique longo no botao)');
    }
  }, 45000);
  setInterval(() => { mode = Math.random() < 0.8 ? 'RADAR' : 'SIM360'; }, 20000);

  if (flag('gps')) setInterval(tickGps, 2000);
  if (flag('imu')) {
    setInterval(tickImu, 500);
    setInterval(() => {
      if (Math.random() < 0.3) {
        pub('events', { event: 'FALL', value: 3.4, t: millis() });
        console.log('[SIM] FALL');
      }
    }, 60000);
  }
  if (flag('status')) { tickStatus(); setInterval(tickStatus, 10000); }
});
client.on('error', (err) => console.error(`[SIM] ${err.message}`));
