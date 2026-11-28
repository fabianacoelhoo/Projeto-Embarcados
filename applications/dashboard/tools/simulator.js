/* Simula a ESP32 publicando no broker, no mesmo formato JSON do firmware.
   Uso:
     node tools/simulator.js               -> so os 2 ultrassonicos
     node tools/simulator.js --all         -> + GPS e MPU-6050 (igual ao firmware atual) e bateria (futuro)
     node tools/simulator.js --gps --imu --status --device node2 --url mqtt://192.168.0.10:1883
     node tools/simulator.js --all --discover   -> acha o servidor pelo anuncio UDP, como o firmware com "auto"
     node tools/simulator.js --all --cancelar 0.5 -> metade das quedas/batidas e cancelada no "Estou bem"
     node tools/simulator.js --all --economia  -> alterna 40 s ativo / 40 s em economia de energia (status "pwr")
     node tools/simulator.js --all --interno   -> sem GPS (dentro de casa): manda a assinatura de Wi-Fi a cada 30 s
     node tools/simulator.js --all --ancora    -> 10 s depois de conectar, "2 cliques" no botao (ancora rapida)
   Responde aos comandos do painel e gera os eventos como o firmware 1.5: NEAR_MISS pelo mesmo
   detector de TTC (tools/ttc.mjs) e queda/batida so depois dos 5 s do pre-alerta (ou DISMISSED). */
import dgram from 'node:dgram';
import mqtt from 'mqtt';
import { TtcDetector, nearMissEvent } from './ttc.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`) || args.includes('--all');
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

let url = opt('url', 'mqtt://localhost:1883');
const deviceId = opt('device', 'node1');
const prefix = opt('prefix', 'echomap');
const home = { lat: Number(opt('lat', -8.109656)), lon: Number(opt('lon', -34.906301)) }; /* zona Casa do config.json */
const NEAR_MISS_CM = 25; /* TTC_CLOSE_CM do config.h: vai na telemetria como "near" */
const PRE_ALERT_MS = 5000; /* igual ao config.h */
const cancelRate = Math.min(1, Math.max(0, Number(opt('cancelar', 0.4))));

const topic = (ch) => `${prefix}/${deviceId}/${ch}`;
let client = null;
const pub = (ch, obj) => client?.publish(topic(ch), JSON.stringify(obj));

const start = Date.now();
const millis = () => Date.now() - start;
const noise = (a) => (Math.random() - 0.5) * 2 * a;

let filtL = -1, filtR = -1;
const ttcL = new TtcDetector(), ttcR = new TtcDetector();
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

function vibration(d) {
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
    vibL: +vibration(filtL).toFixed(2), vibR: +vibration(filtR).toFixed(2),
    thr: Math.round(thr), pot: +pot.toFixed(2),
    near: NEAR_MISS_CM,
  });

  /* so o critico vira ocorrencia (TTC <= 1,5 s ou <= 25 cm por 3 leituras), com 3 s de cooldown por lado */
  const now = millis();
  const rl = ttcL.update(rawL, now);
  const rr = ttcR.update(rawR, now);
  if (rl.report) pub('events', nearMissEvent(rl, 'L', now));
  if (rr.report) pub('events', nearMissEvent(rr, 'R', now));
}

/* pre-alerta "Estou bem": o firmware segura queda/batida por 5 s; se o usuario clicar, vira DISMISSED */
function imuAlert(type, value, extra = {}) {
  const t = millis();
  console.log(`[SIM] ${type} detectado: pre-alerta de ${PRE_ALERT_MS / 1000} s`);
  setTimeout(() => {
    if (Math.random() < cancelRate) {
      pub('events', { event: 'DISMISSED', cause: type, value, unit: 'g', t });
      console.log(`[SIM] ${type} cancelado pelo botao ("Estou bem")`);
    } else {
      pub('events', { event: type, value, unit: 'g', ...extra, t });
      console.log(`[SIM] ${type} confirmado`);
    }
  }, PRE_ALERT_MS);
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
    imuAlert('IMPACT', +gMax.toFixed(2));
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
    fw: 'sim-2.0', up: Math.round(millis() / 1000), heap: 182000 - Math.round(Math.random() * 4000),
    rssi: -55 - Math.round(Math.random() * 15), ip: '192.168.0.42', ssid: net.ssid, ch: 6,
    portal: net.portal, ap: `EchoMap-${deviceId}`, ...(net.err ? { werr: net.err } : {}),
    ...(net.test ? { wtest: net.test, wtry: net.tryName } : {}),
    broker: `${host}:${new URL(url).port || 1883}`, auto: net.auto, mq: true, q: 0, lowlat: net.idle ? 0 : 1,
    pwr: net.idle ? 'idle' : 'active', impG: net.impG, hyst: net.hyst, cal: Boolean(net.calTimer),
    ...(flag('status') ? { battery: Math.round(battery) } : {}), /* bateria so com --status (a placa real nao mede) */
    t: millis(),
  });
}

/* firmware 1.8: as 3 redes mais fortes (a primeira e a "Casa" do exemplo do README) */
function sendFingerprint() {
  const j = () => Math.round(Math.random() * 6);
  pub('wifi', { type: 'wifi_fingerprint', aps: [
    { bssid: 'EC:08:6B:12:34:56', rssi: -58 - j(), ssid: net.ssid },
    { bssid: 'A4:2B:B0:11:22:33', rssi: -71 - j(), ssid: 'Vizinho 2.4G' },
    { bssid: '7C:8B:CA:44:55:66', rssi: -83 - j(), ssid: 'Rua' },
  ], t: millis() });
  console.log('[SIM] Assinatura de Wi-Fi enviada');
}

function onCommand(_topic, payload) {
  let cmd;
  try { cmd = JSON.parse(payload.toString()); } catch { return; }
  if (cmd.cmd === 'ping') pub('pong', { pong: cmd.id, t: millis() });
  else if (cmd.cmd === 'locate') console.log('[SIM] Painel pediu para localizar (vibracao forte por 4 s)');
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
  } else if (cmd.cmd === 'haptic') {
    /* firmware 1.6: toca um padrao da linguagem haptica; tambem acorda da economia (houve uso) */
    console.log(`[SIM] Padrao haptico "${cmd.pattern}" nos motores`);
  } else if (cmd.cmd === 'wifi_scan') {
    sendFingerprint(); /* firmware 1.8: varredura pedida pelo painel */
  } else if (cmd.cmd === 'calibrate_start') {
    /* imita o firmware 1.7: progresso a cada 1 s e o resultado (passo x 1,6 entre 2,5 e 4,5 g) */
    const duration = cmd.duration_s ?? 30;
    let elapsed = 0, steps = 0;
    clearInterval(net.calTimer);
    console.log(`[SIM] Calibrando por ${duration} s`);
    net.calTimer = setInterval(() => {
      elapsed += 1;
      steps += 2;
      pub('calib', { calib: 'running', elapsed, duration, steps, t: millis() });
      if (elapsed < duration) return;
      clearInterval(net.calTimer);
      net.calTimer = null;
      const stepMax = +(1.38 + Math.random() * 0.4).toFixed(2);
      const before = { impactBefore: net.impG, hystBefore: net.hyst };
      const noiseL = +(0.8 + Math.random()).toFixed(2), noiseR = +(0.6 + Math.random()).toFixed(2);
      net.impG = +Math.min(4.5, Math.max(2.5, stepMax * 1.6)).toFixed(2);
      net.hyst = +Math.min(30, Math.max(5, 3 * Math.max(noiseL, noiseR))).toFixed(1);
      pub('calib', { calib: 'done', type: 'calibration_result', ok: true, reason: 'ok', duration, steps,
        stepMean: +(stepMax - 0.06).toFixed(2), stepStd: 0.04, stepMax, noiseL, noiseR,
        ...before, impactAfter: net.impG, hystAfter: net.hyst, t: millis() });
      console.log(`[SIM] Calibracao pronta: batida ${net.impG} g, histerese ${net.hyst} cm`);
      tickStatus();
    }, 1000);
    tickStatus();
  } else if (cmd.cmd === 'calibrate_stop') {
    clearInterval(net.calTimer);
    net.calTimer = null;
    pub('calib', { calib: 'cancelled', impG: net.impG, hyst: net.hyst, t: millis() });
    tickStatus();
  } else if (cmd.cmd === 'calibrate_reset') {
    const before = { impactBefore: net.impG, hystBefore: net.hyst };
    net.impG = 3.0;
    net.hyst = 10;
    pub('calib', { calib: 'reset', type: 'calibration_result', ok: true, ...before, impactAfter: 3.0, hystAfter: 10, t: millis() });
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
const net = { ssid: 'Rede-Casa', portal: false, test: null, tryName: null, err: null, auto: args.includes('--discover'), idle: false, impG: 3.0, hyst: 10, calTimer: null };

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
  setInterval(() => { mode = Math.random() < 0.9 ? 'RADAR' : 'SELFTEST'; }, 20000); /* 1 clique alterna radar/autoteste */

  if (flag('gps') && !args.includes('--interno')) setInterval(tickGps, 1000); /* LOCATION_PERIOD_MS */
  if (args.includes('--interno')) {
    /* GPS sem sinal: como o firmware, a primeira varredura sai 15 s depois e as outras a cada 30 s */
    setTimeout(() => { sendFingerprint(); setInterval(sendFingerprint, 30000); }, 15000);
  }
  if (args.includes('--ancora')) {
    setTimeout(() => {
      const p = args.includes('--interno') ? {} : { lat: +pos.lat.toFixed(6), lng: +pos.lon.toFixed(6) };
      pub('events', { event: 'ANCHOR_TOGGLE', type: 'quick_anchor_toggle', ...p, t: millis() });
      console.log('[SIM] 2 cliques: ancora rapida');
    }, 10000);
  }
  if (flag('imu')) {
    setInterval(tickImu, 200); /* publicado junto com a telemetria */
    setInterval(() => {
      if (Math.random() < 0.3) {
        imuAlert('FALL', 3.4, { tilt: 72 });
      }
    }, 60000);
  }
  tickStatus();
  setInterval(tickStatus, 5000); /* o firmware publica status a cada 5 s */
  if (args.includes('--economia')) {
    /* imita o PowerManager: parado -> economia; mexeu -> ativo (o status sai na hora, como no firmware) */
    setInterval(() => {
      net.idle = !net.idle;
      console.log(`[SIM] Energia: ${net.idle ? 'economia' : 'ativo'}`);
      tickStatus();
    }, 40000);
  }
}
