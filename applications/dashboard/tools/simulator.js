/* Simula a ESP32 publicando no broker, no mesmo formato JSON do firmware.
   Uso:
     node tools/simulator.js               -> so os 2 ultrassonicos
     node tools/simulator.js --all         -> + GPS e MPU-6050 (igual ao firmware atual) e bateria (futuro)
     node tools/simulator.js --gps --imu --status --device node2 --url mqtt://192.168.0.10:1883
     node tools/simulator.js --all --discover   -> acha o servidor pelo anuncio UDP, como o firmware com "auto"
   Responde a ping (latencia) e a "locate"/"portal" vindos do painel, como o firmware 1.2. */
import dgram from 'node:dgram';
import mqtt from 'mqtt';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`) || args.includes('--all');
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

let url = opt('url', 'mqtt://localhost:1883');
const deviceId = opt('device', 'node1');
const prefix = opt('prefix', 'echomap');
const home = { lat: Number(opt('lat', -23.5505)), lon: Number(opt('lon', -46.6333)) };
const NEAR_MISS_CM = 50; /* igual ao config.h */

const topic = (ch) => `${prefix}/${deviceId}/${ch}`;
let client = null;
const pub = (ch, obj) => client?.publish(topic(ch), JSON.stringify(obj));

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
    near: NEAR_MISS_CM,
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

/* mesmo formato da TaskImu/publishImu do firmware: o firmware detecta queda e
   impacto sozinho e publica FALL/IMPACT em events */
let tilt = 4;
function tickImu() {
  const ax = noise(0.05), ay = noise(0.05), az = 1 + noise(0.05);
  let gMax = Math.hypot(ax, ay, az);
  tilt = Math.max(0, Math.min(90, tilt + noise(2)));
  if (Math.random() < 0.002) { /* batida */
    gMax = 3 + Math.random() * 1.5;
    pub('events', { event: 'IMPACT', value: +gMax.toFixed(2), unit: 'g', t: millis() });
    console.log('[SIM] IMPACT');
  }
  pub('imu', {
    ax: +ax.toFixed(2), ay: +ay.toFixed(2), az: +az.toFixed(2),
    gx: +noise(3).toFixed(1), gy: +noise(3).toFixed(1), gz: +noise(3).toFixed(1),
    gMax: +gMax.toFixed(2), tilt: Math.round(tilt), t: millis(),
  });
}

let battery = 64;
function tickStatus() {
  battery = Math.max(5, battery - 0.4);
  const host = new URL(url).hostname;
  pub('status', {
    fw: 'sim-1.4', up: Math.round(millis() / 1000), heap: 182000 - Math.round(Math.random() * 4000),
    rssi: -55 - Math.round(Math.random() * 15), ip: '192.168.0.42', ssid: net.ssid, ch: 6,
    portal: net.portal, ap: `EchoMap-${deviceId}`, ...(net.err ? { werr: net.err } : {}),
    ...(net.test ? { wtest: net.test, wtry: net.tryName } : {}),
    broker: `${host}:${new URL(url).port || 1883}`, auto: net.auto, mq: true, q: 0, lowlat: 1,
    ...(flag('status') ? { battery: Math.round(battery) } : {}), /* bateria so com --status (a placa real nao mede) */
    t: millis(),
  });
}

function onCommand(_topic, payload) {
  let cmd;
  try { cmd = JSON.parse(payload.toString()); } catch { return; }
  if (cmd.cmd === 'ping') pub('pong', { pong: cmd.id, t: millis() });
  else if (cmd.cmd === 'locate') console.log('[SIM] Painel pediu para tocar o buzzer');
  else if (cmd.cmd === 'diag') {
    /* teste dos ultrassônicos: esquerdo bom; direito conforme --diag-mv (padrão 40 mV = nada chega) */
    const mv = Number(opt('diag-mv', 40));
    setTimeout(() => pub('diag', { diag: {
      L: { trig: 18, echo: 19, idleHigh: false, echoOk: true, cm: 62.4, mv: -1, cross: false },
      R: { trig: 25, echo: 33, idleHigh: false, echoOk: mv >= 2400, cm: mv >= 2400 ? 58.1 : -1, mv, cross: false },
    }, t: millis() }), 400);
  }
  else if (cmd.cmd === 'portal') {
    console.log('[SIM] Painel pediu para abrir o portal de Wi-Fi');
    net.portal = true;
    setTimeout(() => { net.portal = false; tickStatus(); }, 60000);
    tickStatus();
  } else if (cmd.cmd === 'server') {
    /* imita o firmware 1.4: troca onde procura o servidor ("auto" = descoberta na rede) */
    console.log(`[SIM] Painel pediu servidor "${cmd.host}"`);
    net.auto = cmd.host === 'auto';
    tickStatus();
  } else if (cmd.cmd === 'wifi') {
    /* imita o teste do firmware: senha "errada123" falha, o resto conecta em ~3 s */
    console.log(`[SIM] Testando a rede "${cmd.ssid}"`);
    Object.assign(net, { test: 'running', tryName: cmd.ssid, err: null });
    tickStatus();
    setTimeout(() => {
      if (cmd.pass === 'errada123') Object.assign(net, { test: 'fail', err: 'senha' });
      else Object.assign(net, { test: 'ok', ssid: cmd.ssid, err: null });
      tickStatus();
      setTimeout(() => { net.test = null; tickStatus(); }, 60000);
    }, 3000);
  }
}
const net = { ssid: 'Rede-Casa', portal: false, test: null, tryName: null, err: null, auto: args.includes('--discover') };

function startClient() {
  /* mesmo formato de clientId do firmware: o servidor reconhece a placa e marca offline na hora ao desconectar */
  const suffix = Math.floor(Math.random() * 0xffffff).toString(16).toUpperCase().padStart(6, '0');
  client = mqtt.connect(url, { clientId: `echomap-${deviceId}-${suffix}` });
  client.on('message', onCommand);
  client.on('error', (err) => console.error(`[SIM] ${err.message}`));
  client.on('connect', onConnect);
}

if (args.includes('--discover')) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const port = Number(opt('discovery-port', 47801));
  console.log(`[SIM] Esperando o anuncio do servidor na porta UDP ${port}...`);
  sock.on('message', (msg, rinfo) => {
    let info;
    try { info = JSON.parse(msg.toString()); } catch { return; }
    if (!info.echomap) return;
    url = `mqtt://${rinfo.address}:${info.mqtt}`;
    console.log(`[SIM] Servidor encontrado: ${url} (${info.name})`);
    sock.close();
    startClient();
  });
  sock.bind(port);
} else {
  startClient();
}

function onConnect() {
  client.subscribe(topic('cmd'));
  console.log(`[SIM] Conectado em ${url} como ${deviceId}. Publicando em ${prefix}/${deviceId}/...`);
  setInterval(tickTelemetry, 200); /* TELEMETRY_PERIOD_MS */
  setInterval(() => {
    if (Math.random() < 0.35) {
      pub('events', { event: 'CRASH', t: millis() });
      console.log('[SIM] CRASH (clique longo no botao)');
    }
  }, 45000);
  setInterval(() => { mode = Math.random() < 0.8 ? 'RADAR' : 'SIM360'; }, 20000);

  if (flag('gps')) setInterval(tickGps, 1000); /* LOCATION_PERIOD_MS */
  if (flag('imu')) {
    setInterval(tickImu, 200); /* publicado junto com a telemetria */
    setInterval(() => {
      if (Math.random() < 0.3) {
        pub('events', { event: 'FALL', value: 3.4, unit: 'g', t: millis() });
        console.log('[SIM] FALL');
      }
    }, 60000);
  }
  tickStatus();
  setInterval(tickStatus, 5000); /* o firmware publica status a cada 5 s */
}
