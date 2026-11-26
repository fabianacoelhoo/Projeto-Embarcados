/* EchoMap · painel dos responsáveis (sem framework, sem build)
   Telas: Início, Ao vivo, Ocorrências (+ detalhe), Mapa, Movimento e Dispositivo. */

const $ = (sel, root = document) => root.querySelector(sel);
/* só troca o HTML quando muda: preserva foco do teclado, seleção e estado de hover */
function setHTML(el, html) {
  if (el && el._html !== html) { el.innerHTML = html; el._html = html; }
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
};

const state = {
  devices: new Map(),
  selected: store.get('echomap.device'),
  events: [],
  series: new Map(),    /* id -> [{ts, distL, distR, thr}] */
  imuSeries: new Map(), /* id -> [{ts, g}] */
  track: new Map(),     /* id -> [[lat, lon]] */
  config: { thresholds: { nearMissCm: 50, impactG: 3 }, safeZones: [], server: {} },
  wsOnline: false,
  windowMs: 60000,
  eventFilter: 'pending',
  serial: null,         /* cabo USB: detecção automática no servidor */
  logs: new Map(),      /* id -> últimas mensagens da placa ([NET] ...) pelo cabo */
};
const SERIES_MAX_MS = 30 * 60000;

let qrLib = null;
import('/vendor/qrcode/qrcode.mjs').then((m) => { qrLib = m.default; scheduleRefresh(); }).catch(() => { /* sem QR: mostra só o texto */ });

/* QR no padrão que a câmera do celular entende para entrar numa rede Wi-Fi */
function wifiQr(ssid, pass) {
  if (!qrLib) return '';
  const e = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
  const qr = qrLib(0, 'M');
  qr.addData(`WIFI:T:WPA;S:${e(ssid)};P:${e(pass)};;`);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: `Entrar na rede ${ssid}` });
}

const WIFI_ERR = {
  senha: 'senha incorreta',
  rede: 'rede não encontrada (fora do alcance ou é de 5 GHz)',
  tempo: 'a rede não respondeu a tempo',
  falha: 'não foi possível conectar',
};

/* ---------------- textos ---------------- */
const EVENT_LABEL = {
  NEAR_MISS: 'Quase colisão',
  CRASH: 'Alerta pelo botão',
  SOS: 'Pedido de ajuda',
  FALL: 'Queda detectada',
  IMPACT: 'Impacto detectado',
  GEOFENCE_EXIT: 'Saiu da zona segura',
  GEOFENCE_ENTER: 'Entrou na zona segura',
  LOW_BATTERY: 'Bateria baixa',
  DEVICE_OFFLINE: 'Dispositivo sem sinal',
  DEVICE_ONLINE: 'Dispositivo voltou a responder',
  DISMISSED: 'Alerta cancelado ("Estou bem")',
  ANCHOR_CREATED: 'Âncora rápida criada',
  ANCHOR_REMOVED: 'Âncora rápida removida',
  ANCHOR_EXPIRED: 'Âncora rápida expirou',
  ANCHOR_FAILED: 'Âncora rápida sem posição',
};
const CAUSE_WORD = { FALL: 'era uma queda', IMPACT: 'era uma batida' };
/* limiar de batida em uso: o calibrado que a placa informa (firmware 1.7) ou o do servidor */
const impactOf = (d) => d?.latest?.status?.impactG ?? state.config.thresholds.impactG;
const HYST_DEFAULT_CM = 10; /* BUZZER_HYST_CM do config.h */
/* tempo que falta: "3h 42m", "12 min", "menos de 1 min" */
function fmtLeft(ms) {
  if (ms <= 60000) return 'menos de 1 min';
  const m = Math.round(ms / 60000), h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`;
}
/* local conhecido por Wi-Fi ativo (o servidor casou a assinatura ha menos de 90 s) */
const indoorOf = (d) => {
  const i = d?.latest?.indoor;
  return i?.placeName && Date.now() - i.ts < 90000 ? i : null;
};
const anchorOf = (d) => (state.config.safeZones ?? []).find((z) => z.type === 'dynamic' && z.deviceId === d?.id && (!z.expiresAt || z.expiresAt > Date.now()));
/* linguagem haptica (firmware 1.6): o que cada padrao significa para quem usa */
const HAPTIC = [
  ['locate', 'Localizar', 'forte e alternado por 4 s, para achar o dispositivo'],
  ['approach', 'Aproximação rápida', 'dupla rápida (80 ms, pausa, 80 ms): algo vai bater em menos de 1,5 s'],
  ['proximity', 'Aproximando', 'pulsos que aceleram e ficam mais fortes conforme algo chega perto'],
  ['static', 'Obstáculo parado', 'pulso curto e espaçado (60 ms a cada 0,76 s): parede ou pessoa parada ao lado'],
  ['prealert', 'Pré-alerta "Estou bem"', 'batidas que aceleram por 5 s depois de uma queda ou batida'],
  ['heartbeat', 'Batimento', 'um pulso longo e suave a cada 10 min: está tudo funcionando'],
  ['confirm', 'Confirmação', 'dois toques curtos: ação aceita (alerta cancelado, por exemplo)'],
];
const SEV_WORD = { critical: 'Crítico', serious: 'Grave', warning: 'Atenção', info: 'Aviso' };
const SIDE = { L: 'lado esquerdo', R: 'lado direito' };
const MODE_LABEL = { RADAR: 'Modo radar', SELFTEST: 'Autoteste' };

/* ---------------- formatação (pt-BR) ---------------- */
const fmtNum = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('pt-BR');
function fmtAgo(ts) {
  if (!ts) return 'nunca';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `há ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  return new Date(ts).toLocaleDateString('pt-BR');
}
function fmtWhen(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? 'hoje' : d.toLocaleDateString('pt-BR')} às ${fmtTime(ts)}`;
}
function fmtDuration(sec) {
  if (sec == null) return '—';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${sec} s`;
}
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

/* ---------------- conceitos ---------------- */
const deviceName = (d) => (d ? d.name || d.id : '—');
const initialOf = (d) => (deviceName(d).trim()[0] ?? '?').toUpperCase();
const current = () => state.devices.get(state.selected);
const nearCm = (p) => p?.near ?? state.config.thresholds.nearMissCm;

function posture(tilt) {
  if (tilt == null) return { word: 'Sem dados', tone: 'muted' };
  if (tilt < 30) return { word: 'Em pé', tone: 'good' };
  if (tilt < 60) return { word: 'Inclinado', tone: 'warning' };
  return { word: 'Deitado', tone: 'critical' };
}

function proximity(dist, near) {
  if (dist == null) return { text: 'Nada por perto', tone: 'good', sev: 'good' };
  if (dist < near) return { text: 'Muito perto', tone: 'critical', sev: 'critical' };
  if (dist < near * 2) return { text: 'Perto', tone: 'warning', sev: 'warning' };
  return { text: 'Livre', tone: 'good', sev: 'good' };
}

function linkOf(d) {
  if (!d) return { on: false, text: 'Sem dispositivo' };
  if (!d.online) return { on: false, text: `Sem sinal, visto ${fmtAgo(d.lastSeen)}` };
  return { on: true, text: d.source === 'serial' ? 'Online pelo cabo USB' : 'Online pelo Wi-Fi' };
}
const stateTag = (d) => { const l = linkOf(d); return `<span class="state ${l.on ? 'on' : 'off'}"><i></i>${esc(l.text)}</span>`; };

function zoneOf(loc) {
  if (!loc || loc.lat == null) return null;
  const R = 6371000, rad = Math.PI / 180;
  for (const z of state.config.safeZones ?? []) {
    const dLat = (z.lat - loc.lat) * rad, dLon = (z.lon - loc.lon) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(loc.lat * rad) * Math.cos(z.lat * rad) * Math.sin(dLon / 2) ** 2;
    if (2 * R * Math.asin(Math.sqrt(a)) <= z.radiusM) return z;
  }
  return false;
}

function eventDetail(e, withName = false) {
  const d = e.data ?? {};
  const parts = [];
  if (withName) parts.push(deviceName(state.devices.get(e.deviceId)));
  if (d.side) parts.push(SIDE[d.side] ?? d.side);
  if (d.value != null) parts.push(d.unit === 'g' ? `${fmtNum(d.value, 2)} g` : d.unit === '%' ? `${fmtNum(d.value)}%` : `${fmtNum(d.value)} cm`);
  if (d.zone) parts.push(d.zone);
  if (e.type === 'FALL' && d.tilt != null) parts.push(`ficou inclinado ${fmtNum(d.tilt)}°`);
  if (e.type === 'NEAR_MISS' && d.reason === 'ttc' && d.ttc != null) parts.push(`aproximando a ${fmtNum(d.v)} cm/s, impacto em ${fmtNum(d.ttc, 1)} s`);
  if (e.type === 'NEAR_MISS' && d.reason === 'close') parts.push('perto demais');
  if (e.type === 'ANCHOR_CREATED') parts.push(`raio de ${fmtNum(d.radiusM)} m, ${d.by === 'botão' ? '2 cliques no botão' : 'pelo painel'}`);
  if (e.type === 'ANCHOR_REMOVED') parts.push(d.by === 'botão' ? '2 cliques no botão' : 'pelo painel');
  if (e.type === 'ANCHOR_FAILED') parts.push('sem posição de GPS nem local por Wi-Fi');
  if (e.type === 'DISMISSED') parts.push(`${CAUSE_WORD[d.cause] ?? 'alerta'}, cancelado no botão em 5 s`);
  if (e.type === 'CRASH') parts.push('botão segurado por 1,5 s');
  if (d.detectedBy === 'server') parts.push('detectado pelo servidor');
  return parts.join(', ');
}
const sevMark = (sev) => `<span class="sev ${sev}" aria-hidden="true">${sev === 'info' ? 'i' : '!'}</span>`;
const pendingEvents = () => state.events.filter((e) => !e.ackedAt && e.severity !== 'info');

/* ---------------- dados ---------------- */
async function loadState() {
  const res = await fetch('/api/state');
  if (res.status === 401) { location.href = `/login.html?next=${encodeURIComponent(`/${location.hash}`)}`; return; }
  const data = await res.json();
  state.config = data.config;
  state.serial = data.serial ?? null;
  state.events = data.events;
  state.devices = new Map(data.devices.map((d) => [d.id, d]));
  if (!state.devices.has(state.selected)) {
    const online = data.devices.find((d) => d.online);
    state.selected = (online ?? data.devices[0])?.id ?? null;
  }
  await loadHistory();
  renderChrome();
  route();
}

async function loadHistory() {
  const id = state.selected;
  if (!id) return;
  const q = (kind, minutes) => fetch(`/api/devices/${encodeURIComponent(id)}/readings?kind=${kind}&minutes=${minutes}`).then((r) => r.json());
  const [prox, loc, imu] = await Promise.all([q('proximity', 30), q('location', 180), q('imu', 5)]);
  const live = state.series.get(id) ?? [];
  const firstLive = live[0]?.ts ?? Infinity;
  state.series.set(id, [...prox.filter((p) => p.ts < firstLive).map((p) => ({ ts: p.ts, distL: p.distL, distR: p.distR, thr: p.thr })), ...live]);
  const liveImu = state.imuSeries.get(id) ?? [];
  const firstImu = liveImu[0]?.ts ?? Infinity;
  state.imuSeries.set(id, [...imu.filter((p) => p.ts < firstImu).map((p) => ({ ts: p.ts, g: p.gMax ?? p.g })), ...liveImu]);
  state.track.set(id, loc.filter((p) => p.lat != null).map((p) => [p.lat, p.lon]));
}

function selectDevice(id) {
  if (!id || id === state.selected) return;
  state.selected = id;
  store.set('echomap.device', id);
  loadHistory().then(() => route());
}

function onReading(msg) {
  let d = state.devices.get(msg.deviceId);
  if (!d) {
    d = { id: msg.deviceId, name: null, online: true, lastSeen: msg.ts, latest: {} };
    state.devices.set(d.id, d);
  }
  d.lastSeen = msg.ts;
  d.latest[msg.kind] = { ts: msg.ts, ...msg.data };
  if (!state.selected) { state.selected = d.id; route(); }
  if (msg.kind === 'indoor') renderChrome(); /* selo "Ambiente interno conhecido" no topo */

  const cut = msg.ts - SERIES_MAX_MS;
  if (msg.kind === 'proximity') {
    const arr = state.series.get(msg.deviceId) ?? [];
    arr.push({ ts: msg.ts, distL: msg.data.distL, distR: msg.data.distR, thr: msg.data.thr });
    while (arr.length && arr[0].ts < cut) arr.shift();
    state.series.set(msg.deviceId, arr);
  }
  if (msg.kind === 'imu') {
    const arr = state.imuSeries.get(msg.deviceId) ?? [];
    arr.push({ ts: msg.ts, g: msg.data.gMax ?? msg.data.g });
    while (arr.length && arr[0].ts < msg.ts - 5 * 60000) arr.shift();
    state.imuSeries.set(msg.deviceId, arr);
  }
  if (msg.kind === 'location' && msg.data.lat != null) {
    const tr = state.track.get(msg.deviceId) ?? [];
    tr.push([msg.data.lat, msg.data.lon]);
    if (tr.length > 500) tr.shift();
    state.track.set(msg.deviceId, tr);
  }
  scheduleRefresh();
}

function onEvent(evt, isNew) {
  const i = state.events.findIndex((e) => e.id === evt.id);
  if (i >= 0) state.events[i] = evt; else state.events.unshift(evt);
  state.events = state.events.slice(0, 300);
  if (isNew && (evt.severity === 'critical' || evt.severity === 'serious')) notify(evt);
  renderChrome();
  scheduleRefresh();
}

function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { state.wsOnline = true; renderChrome(); loadState().catch(console.error); };
  ws.onclose = () => { state.wsOnline = false; renderChrome(); setTimeout(connectWs, 2000); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'reading') onReading(msg);
    else if (msg.type === 'event') onEvent(msg.event, true);
    else if (msg.type === 'eventUpdated') onEvent(msg.event, false);
    else if (msg.type === 'serial') { state.serial = msg.serial; scheduleRefresh(); }
    else if (msg.type === 'wifiPlaces') { state.config.wifiPlaces = msg.places; scheduleRefresh(); }
    else if (msg.type === 'zones') {
      state.config.safeZones = msg.zones;
      view.impl?.m?.setZones(msg.zones);
      view.impl?.map?.setZones(msg.zones);
      scheduleRefresh();
    }
    else if (msg.type === 'log') {
      const arr = state.logs.get(msg.deviceId) ?? [];
      arr.push({ ts: msg.ts, line: msg.line });
      state.logs.set(msg.deviceId, arr.slice(-6));
      scheduleRefresh();
    }
    else if (msg.type === 'device') {
      const prev = state.devices.get(msg.device.id);
      state.devices.set(msg.device.id, { ...prev, ...msg.device, latest: { ...prev?.latest, ...msg.device.latest } });
      if (!state.selected) state.selected = msg.device.id;
      renderChrome();
      scheduleRefresh();
    }
  };
}

/* ---------------- ações ---------------- */
let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

async function ack(id) {
  const res = await fetch(`/api/events/${id}/ack`, { method: 'POST' });
  if (res.ok) onEvent(await res.json(), false);
}

async function sendCommand(cmd, deviceId = state.selected, extra = {}) {
  const body = cmd === 'server' ? { cmd, host: 'auto' } : { cmd, ...extra };
  const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.status === 409) return toast('O dispositivo precisa estar online pelo Wi-Fi para receber comandos.');
  if (!res.ok) return toast('O comando não foi enviado. Confira se o servidor está rodando.');
  if (cmd === 'locate') toast('Pedido enviado: o dispositivo vai apitar por 4 segundos.');
  if (cmd === 'diag') toast('Testando os sensores: aponte os dois para uma parede a 30–100 cm. O resultado aparece em Ao vivo.');
  if (cmd === 'wifi_scan') toast('Pedido enviado: o dispositivo vai escanear o Wi-Fi. As redes aparecem em alguns segundos.');
  if (cmd === 'calibrate_start') toast('Calibração começou: ande em linha reta no seu passo normal até a barra completar.');
  if (cmd === 'calibrate_stop') toast('Calibração cancelada. Os limiares não mudaram.');
  if (cmd === 'calibrate_reset') toast('Padrões de fábrica restaurados.');
  if (cmd === 'haptic') toast(`Tocando "${HAPTIC.find((h) => h[0] === extra.pattern)?.[1] ?? extra.pattern}" no dispositivo.`);
  if (cmd === 'server') toast('Pedido enviado: o EchoMap vai procurar este computador na rede e reconectar. Leva alguns segundos.');
  if (cmd === 'portal') toast('Portal aberto no dispositivo: conecte o celular na rede EchoMap (senha echomap123) e abra 192.168.4.1.');
}

async function removeZone(id, name) {
  if (!confirm(`Remover a zona segura "${name}"? Sair dela deixa de gerar alerta.`)) return;
  const res = await fetch(`/api/zones/${encodeURIComponent(id)}`, { method: 'DELETE' });
  toast(res.ok ? `Zona "${name}" removida.` : 'Não foi possível remover a zona.');
}

async function anchorAction(act) {
  const id = current()?.id ?? state.selected;
  const res = act === 'create'
    ? await fetch('/api/safe-zones/anchor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: id }) })
    : await fetch(`/api/safe-zones/anchor?deviceId=${encodeURIComponent(id)}`, { method: 'DELETE' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return toast(body.error ?? 'Não foi possível mudar a âncora.');
  toast(act === 'create' ? `Âncora criada: raio de ${fmtNum(body.radiusM)} m, expira em ${fmtLeft(body.expiresAt - Date.now())}.` : 'Âncora removida.');
}

async function removePlace(id, name) {
  if (!confirm(`Remover o local "${name}"? Sem ele, o painel deixa de reconhecer esse lugar pelo Wi-Fi.`)) return;
  const res = await fetch(`/api/wifi-places/${encodeURIComponent(id)}`, { method: 'DELETE' });
  toast(res.ok ? `Local "${name}" removido.` : 'Não foi possível remover o local.');
}

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx ?? new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.35);
  } catch { /* sem áudio */ }
}
function notify(evt) {
  beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(`EchoMap: ${EVENT_LABEL[evt.type] ?? evt.type}`, { body: eventDetail(evt, true), tag: `evt-${evt.id}` });
  }
}

document.addEventListener('click', (e) => {
  const ackId = e.target.closest('[data-ack]')?.dataset.ack;
  if (ackId) { e.preventDefault(); ack(Number(ackId)); return; }
  const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
  if (cmd) { e.preventDefault(); sendCommand(cmd); return; }
  const cal = e.target.closest('[data-cal]')?.dataset.cal;
  if (cal) {
    e.preventDefault();
    const id = current()?.id ?? state.selected;
    if (cal === 'start') sendCommand('calibrate_start', id, { duration_s: 30 });
    if (cal === 'stop') sendCommand('calibrate_stop', id);
    if (cal === 'reset' && confirm('Voltar o limiar de batida e a histerese para os valores de fábrica?')) sendCommand('calibrate_reset', id);
    return;
  }
  const anchorAct = e.target.closest('[data-anchor]')?.dataset.anchor;
  if (anchorAct) { e.preventDefault(); anchorAction(anchorAct); return; }
  const delPlace = e.target.closest('[data-place-del]');
  if (delPlace) { e.preventDefault(); removePlace(delPlace.dataset.placeDel, delPlace.dataset.name); return; }
  const delZone = e.target.closest('[data-zone-del]');
  if (delZone) { e.preventDefault(); removeZone(delZone.dataset.zoneDel, delZone.dataset.name); return; }
  const dev = e.target.closest('[data-dev]')?.dataset.dev;
  if (dev) selectDevice(dev);
});

/* ---------------- elementos fixos (navegação, faixa de alerta) ---------------- */
function renderChrome() {
  const ls = $('#linkState');
  ls.className = `link-state ${state.wsOnline ? 'ok' : 'bad'}`;
  ls.querySelector('span').textContent = state.wsOnline ? 'Servidor conectado' : 'Sem conexão com o servidor';

  const n = pendingEvents().length;
  const c = $('#navCount');
  c.hidden = n === 0;
  c.textContent = n > 99 ? '99+' : String(n);

  /* ambiente interno conhecido por Wi-Fi (GPS sem sinal) */
  const ind = indoorOf(current());
  const pb = $('#placeBadge');
  pb.hidden = !ind;
  if (ind) setHTML(pb, `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="19.5" r="1"/></svg>
    <span><b>Ambiente interno conhecido: ${esc(ind.placeName)} (Wi-Fi)</b>. ${esc(deviceName(current()))} está sem GPS; a posição vem da rede cadastrada.</span>`);

  const band = $('#alertBand');
  const evt = state.events.find((e) => !e.ackedAt && e.severity === 'critical');
  if (!evt || view.name === 'alerta') { band.hidden = true; return; }
  band.hidden = false;
  band.innerHTML = `
    <span class="what">${esc(EVENT_LABEL[evt.type] ?? evt.type)}</span>
    <span class="ctx">${esc(eventDetail(evt, true))}, ${esc(fmtAgo(evt.ts))}</span>
    <span class="acts">
      <a class="btn small" href="#/alerta/${evt.id}">Ver o que aconteceu</a>
      <button class="btn small danger" data-ack="${evt.id}">Estou ciente</button>
    </span>`;
}

/* ---------------- componentes ---------------- */
function deviceChips() {
  if (state.devices.size < 2) return '';
  return `<div class="chips" role="group" aria-label="Dispositivo">${[...state.devices.values()].map((d) =>
    `<button data-dev="${esc(d.id)}" class="${d.id === state.selected ? 'on' : ''}">${esc(deviceName(d))}</button>`).join('')}</div>`;
}

function niceMax(v) {
  const steps = [1, 2, 3, 4, 5, 6, 8, 10, 50, 100, 150, 200, 250, 300, 400];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 100) * 100;
}

/* figura do eco: a pessoa no centro, obstáculos à esquerda e à direita */
function echoFigure(p, width, { labels = true } = {}) {
  const W = Math.max(300, Math.round(width || 640));
  const H = 136, cx = W / 2, cy = 70, personR = 26, laneH = 44;
  const thr = p?.thr ?? null;
  const near = nearCm(p);
  const maxCm = niceMax(Math.max((thr ?? 100) * 1.15, 120));
  const lanePx = cx - personR - 18;
  const px = lanePx / maxCm;

  const lane = (dir, dist, bz, color) => {
    const sign = dir === 'L' ? -1 : 1;
    const x0 = cx + sign * (personR + 6);
    const xAt = (cm) => x0 + sign * cm * px;
    const rect = (a, b, y, h, fill, extra = '') => `<rect x="${Math.min(a, b)}" y="${y}" width="${Math.abs(b - a)}" height="${h}" fill="${fill}" ${extra}/>`;
    let s = rect(x0, xAt(maxCm), cy - laneH / 2, laneH, 'var(--sunken)', 'rx="8"');
    s += rect(x0, xAt(near), cy - laneH / 2, laneH, 'var(--near-wash)');
    if (thr != null) {
      const xt = xAt(Math.min(thr, maxCm));
      s += `<line x1="${xt}" x2="${xt}" y1="${cy - laneH / 2 - 5}" y2="${cy + laneH / 2 + 5}" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    }
    const tick = lanePx < 200 ? 100 : 50;
    for (let cm = 0; cm <= maxCm; cm += tick) {
      s += `<text x="${xAt(cm)}" y="${cy + laneH / 2 + 18}" text-anchor="middle" font-size="12" fill="var(--muted)">${cm}</text>`;
    }
    if (dist != null && p) {
      const st = proximity(dist, near);
      const x = xAt(Math.min(dist, maxCm));
      const tone = st.sev === 'critical' ? 'var(--critical)' : st.sev === 'warning' ? 'var(--warning)' : color;
      s += `<line x1="${x0}" x2="${x}" y1="${cy}" y2="${cy}" stroke="${color}" stroke-width="2" stroke-dasharray="1 5" stroke-linecap="round"/>`;
      s += `<rect x="${x - 6}" y="${cy - laneH / 2 + 5}" width="12" height="${laneH - 10}" rx="5" fill="${tone}" stroke="var(--surface)" stroke-width="2"/>`;
      const lx = Math.min(Math.max(x, 34), W - 34);
      if (labels) s += `<text x="${lx}" y="${cy - laneH / 2 - 10}" text-anchor="middle" font-size="15" font-weight="700" fill="var(--ink)">${fmtNum(dist)} cm</text>`;
    } else if (p) {
      s += `<text x="${(x0 + xAt(maxCm)) / 2}" y="${cy + 5}" text-anchor="middle" font-size="13" fill="var(--muted)">nada por perto</text>`;
    }
    /* arcos de eco: um por terço do volume do buzzer */
    const waves = bz ? Math.ceil(bz * 3) : 0;
    for (let i = 1; i <= waves; i++) {
      const r = personR + 2 + i * 6, a = Math.PI / 4.5;
      const xA = cx + sign * r * Math.cos(a), yA = cy - r * Math.sin(a), yB = cy + r * Math.sin(a);
      s += `<path d="M${xA} ${yA} A${r} ${r} 0 0 ${dir === 'L' ? 0 : 1} ${xA} ${yB}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" opacity="${1 - i * 0.22}"/>`;
    }
    return s;
  };

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distância dos obstáculos: esquerda ${p?.distL == null ? 'nada' : `${Math.round(p.distL)} cm`}, direita ${p?.distR == null ? 'nada' : `${Math.round(p.distR)} cm`}">
    ${lane('L', p?.distL ?? null, p?.bzL ?? 0, 'var(--left)')}
    ${lane('R', p?.distR ?? null, p?.bzR ?? 0, 'var(--right)')}
    <circle cx="${cx}" cy="${cy}" r="${personR}" fill="var(--surface)" stroke="var(--ink)" stroke-width="2"/>
    <circle cx="${cx}" cy="${cy - 8}" r="6.5" fill="var(--ink)"/>
    <path d="M${cx - 12} ${cy + 16} Q${cx} ${cy - 4} ${cx + 12} ${cy + 16}" fill="var(--ink)"/>
  </svg>`;
}

const echoLegend = (p) => `<div class="echo-legend">
  <span><i class="sw l"></i>Esquerda</span><span><i class="sw r"></i>Direita</span>
  ${p?.thr != null ? `<span><i class="sw thr"></i>Limiar ajustado (${fmtNum(p.thr)} cm)</span>` : ''}
  <span><i class="sw near"></i>Quase colisão (abaixo de ${fmtNum(nearCm(p))} cm)</span></div>`;

/* gráfico de linhas no tempo, com dica ao passar o mouse */
function lineChart(el, tip, { pts, windowMs, series, yFloor = 60, bands = [], refs = [], unit = '', digits = 0 }) {
  const W = el.clientWidth || 600, H = el.clientHeight || 240;
  const m = { l: 40, r: 70, t: 24, b: 26 };
  const now = Date.now(), t0 = now - windowMs;
  const shown = pts.filter((p) => p.ts >= t0 - 2000);
  let maxV = 0;
  for (const p of shown) for (const s of series) maxV = Math.max(maxV, p[s.key] ?? 0);
  for (const r of refs) maxV = Math.max(maxV, r.v);
  const yMax = niceMax(Math.max(maxV * 1.1, yFloor));
  const x = (ts) => m.l + ((ts - t0) / windowMs) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - v / yMax) * (H - m.t - m.b);

  let s = '';
  for (const b of bands) s += `<rect x="${m.l}" y="${y(b.to)}" width="${W - m.l - m.r}" height="${y(b.from) - y(b.to)}" fill="${b.fill}"/>`;
  const step = yMax <= 5 ? 1 : yMax <= 10 ? 2 : yMax <= 100 ? 25 : yMax <= 200 ? 50 : 100;
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? 'var(--line-strong)' : 'var(--line)'}"/>`;
    s += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmtNum(v)}</text>`;
  }
  s += `<text x="${m.l - 8}" y="11" text-anchor="end">${unit}</text>`;
  /* no máximo um rótulo de tempo a cada ~80 px */
  const maxTicks = Math.max(2, Math.floor((W - m.l - m.r) / 80));
  const tickEvery = [5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000].find((t) => windowMs / t <= maxTicks) ?? 600000;
  for (let ts = Math.ceil(t0 / tickEvery) * tickEvery; ts <= now; ts += tickEvery) {
    const secs = Math.round((now - ts) / 1000);
    s += `<text x="${x(ts)}" y="${H - 6}" text-anchor="middle">${secs === 0 ? 'agora' : secs < 60 ? `-${secs} s` : `-${Math.round(secs / 60)} min`}</text>`;
  }
  for (const r of refs) {
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(r.v)}" y2="${y(r.v)}" stroke="${r.color}" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    s += `<text x="${W - m.r + 6}" y="${y(r.v) + 4}" style="fill:${r.color}">${esc(r.label)}</text>`;
  }
  for (const se of series) {
    let d = '', pen = false, prev = null;
    for (const p of shown) {
      const v = p[se.key];
      if (v == null || (prev && p.ts - prev.ts > 3000)) { pen = false; if (v == null) { prev = p; continue; } }
      const X = x(p.ts).toFixed(1), Y = y(v).toFixed(1);
      d += !pen ? `M${X} ${Y}` : se.stepped ? `H${X}V${Y}` : `L${X} ${Y}`;
      pen = true; prev = p;
    }
    if (d) s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.width ?? 2.2}" ${se.dash ? `stroke-dasharray="${se.dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  /* rótulo direto no fim de cada linha principal */
  const labels = [];
  for (const se of series.filter((q) => q.label)) {
    const p = [...shown].reverse().find((q) => q[se.key] != null);
    if (p && now - p.ts < 5000) labels.push({ y: y(p[se.key]), text: `${se.label} ${fmtNum(p[se.key], digits)}`, color: se.color });
  }
  if (labels.length === 2 && Math.abs(labels[0].y - labels[1].y) < 16) {
    const mid = (labels[0].y + labels[1].y) / 2, up = labels[0].y <= labels[1].y ? 0 : 1;
    labels[up].y = mid - 9; labels[1 - up].y = mid + 9;
  }
  for (const l of labels) s += `<text x="${W - m.r + 8}" y="${l.y + 4}" style="fill:${l.color};font-weight:700">${l.text}</text>`;
  if (!shown.length) s += `<text x="${(W - m.r + m.l) / 2}" y="${H / 2}" text-anchor="middle" style="font-size:14px">Sem leituras neste período</text>`;
  s += `<g class="hover"></g><rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Gráfico no tempo">${s}</svg>`;

  const hover = $('.hover', el);
  const hit = $('.hit', el);
  const draw = (hx) => {
    if (hx == null || !shown.length) { hover.innerHTML = ''; tip.hidden = true; return; }
    let best = null, bd = Infinity;
    for (const p of shown) { const dd = Math.abs(x(p.ts) - hx); if (dd < bd) { bd = dd; best = p; } }
    if (!best || bd > 40) { hover.innerHTML = ''; tip.hidden = true; return; }
    const X = x(best.ts);
    hover.innerHTML = `<line x1="${X}" x2="${X}" y1="${m.t}" y2="${H - m.b}" stroke="var(--line-strong)"/>` +
      series.filter((se) => best[se.key] != null && !se.stepped).map((se) => `<circle cx="${X}" cy="${y(best[se.key])}" r="4.5" fill="${se.color}" stroke="var(--surface)" stroke-width="2"/>`).join('');
    tip.innerHTML = `<div class="t">${fmtTime(best.ts)}</div>` + series.map((se) =>
      `<div class="row"><span>${esc(se.name)}</span><b>${best[se.key] == null ? '—' : `${fmtNum(best[se.key], digits)} ${unit}`}</b></div>`).join('');
    tip.hidden = false;
    const left = el.offsetLeft + X + 14;
    tip.style.left = `${X > W - 190 ? left - tip.offsetWidth - 28 : left}px`;
    tip.style.top = `${el.offsetTop + 8}px`;
  };
  hit.addEventListener('mousemove', (e) => { const b = el.getBoundingClientRect(); draw(((e.clientX - b.left) / b.width) * W); });
  hit.addEventListener('mouseleave', () => draw(null));
}

function makeMap(el, { zoom = 4, interactive = true } = {}) {
  if (typeof L === 'undefined') return null;
  const map = L.map(el, { zoomControl: interactive, attributionControl: true, dragging: interactive, scrollWheelZoom: interactive }).setView([-8.05, -34.9], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  const css = getComputedStyle(document.documentElement);
  const good = css.getPropertyValue('--good').trim(), echo = css.getPropertyValue('--echo').trim();
  const zoneLayer = L.layerGroup().addTo(map);
  const setZones = (list) => {
    zoneLayer.clearLayers();
    for (const z of list ?? []) {
      const dyn = z.type === 'dynamic';
      /* âncora rápida: tracejado curto na cor do eco, com o tempo que falta */
      L.circle([z.lat, z.lon], { radius: z.radiusM, color: dyn ? echo : good, weight: dyn ? 3 : 2, dashArray: dyn ? '3 7' : '6 6', fillOpacity: dyn ? 0.12 : 0.08 })
        .bindTooltip(dyn ? `Âncora rápida, expira em ${fmtLeft((z.expiresAt ?? 0) - Date.now())}` : `Zona segura: ${z.name}`).addTo(zoneLayer);
    }
  };
  setZones(state.config.safeZones);
  const trail = L.polyline([], { color: echo, weight: 3, opacity: 0.7 }).addTo(map);
  let marker = null, acc = null;
  return {
    map,
    setZones,
    update(loc, track) {
      if (!loc || loc.lat == null) return;
      const ll = [loc.lat, loc.lon];
      if (!marker) {
        acc = L.circle(ll, { radius: loc.accuracyM ?? 10, color: echo, weight: 1, fillOpacity: 0.12 }).addTo(map);
        marker = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: echo, fillOpacity: 1 }).addTo(map);
        map.setView(ll, 17);
      }
      marker.setLatLng(ll);
      acc.setLatLng(ll).setRadius(loc.accuracyM ?? 10);
      if (track) trail.setLatLngs(track);
      if (!map.getBounds().pad(-0.1).contains(ll)) map.panTo(ll);
    },
    destroy() { map.remove(); },
  };
}

function rssiQuality(rssi) {
  if (rssi == null) return { q: 0, word: '—' };
  if (rssi >= -55) return { q: 4, word: 'ótimo' };
  if (rssi >= -67) return { q: 3, word: 'bom' };
  if (rssi >= -75) return { q: 2, word: 'fraco' };
  return { q: 1, word: 'muito fraco' };
}

function sparkline(samples) {
  if (!samples?.length) return '';
  const W = 120, H = 28, max = Math.max(...samples, 10);
  const pts = samples.map((v, i) => `${(i / Math.max(1, samples.length - 1)) * (W - 4) + 2},${H - 3 - (v / max) * (H - 6)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--echo)" stroke-width="2" stroke-linejoin="round"/></svg>`;
}

function tiltGauge(tilt) {
  const t = Math.max(0, Math.min(90, tilt ?? 0));
  const cx = 100, cy = 104, r = 80;
  const pt = (deg, rr = r) => { const a = Math.PI - (deg / 90) * Math.PI; return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)]; };
  const arc = (a, b, color) => { const [x1, y1] = pt(a), [x2, y2] = pt(b); return `<path d="M${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="14"/>`; };
  const [nx, ny] = pt(t, r - 22);
  return `<svg viewBox="0 0 200 118" role="img" aria-label="Inclinação ${Math.round(t)} graus">
    ${arc(0, 30, 'var(--good)')}${arc(30, 60, 'var(--warning)')}${arc(60, 90, 'var(--critical)')}
    ${tilt == null ? '' : `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="var(--ink)" stroke-width="3.5" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="6" fill="var(--ink)"/>`}
  </svg>`;
}

function eventItem(e, withName) {
  return `<li class="item ${e.ackedAt ? 'acked' : ''}">
    ${sevMark(e.severity)}
    <a class="body" href="#/alerta/${e.id}">
      <div class="title">${esc(EVENT_LABEL[e.type] ?? e.type)} <span class="sevw">${esc(SEV_WORD[e.severity] ?? '')}</span></div>
      <div class="detail">${esc(eventDetail(e, withName)) || '&nbsp;'}</div>
      <div class="when" title="${esc(new Date(e.ts).toLocaleString('pt-BR'))}">${esc(fmtAgo(e.ts))}</div>
    </a>
    <div class="end">${e.ackedAt ? '<span class="done-mark">Ciente</span>' : e.severity === 'info' ? '' : `<button class="btn small" data-ack="${e.id}">Ciente</button>`}</div>
  </li>`;
}

/* resultado do teste de um ultrassônico, em linguagem de montagem */
function diagSideHtml(name, s) {
  if (!s) return '';
  const v = (mv) => `${fmtNum(mv / 1000, 1)} V`;
  let tone = 'bad', title, how;
  if (s.echoOk) {
    tone = 'ok';
    title = `Funcionando: eco a ${fmtNum(s.cm)} cm`;
    how = s.mv != null ? `O sinal chega com ${v(s.mv)} no pino, como deveria.` : 'O sensor respondeu ao disparo.';
  } else if (s.idleHigh) {
    title = 'O pino ECHO fica sempre em nível alto';
    how = `Confira o divisor: o ECHO do sensor vai no resistor de 1 kΩ, o meio vai no GPIO ${s.echo} e o resistor de 2 kΩ vai no GND. Um GPIO ligado direto no 3V3 ou no 5 V também causa isso.`;
  } else if (s.cross) {
    title = 'O eco apareceu no pino do outro lado';
    how = `Os fios de ECHO estão trocados entre os dois sensores: o ECHO deste sensor tem que ir para o divisor do GPIO ${s.echo}.`;
  } else if (s.mv != null && s.mv >= 2400) {
    title = `O sinal chega (${v(s.mv)}), mas o pulso não foi lido`;
    how = 'Fio com mau contato no GPIO. Troque o jumper que liga o meio do divisor à placa.';
  } else if (s.mv != null && s.mv >= 600) {
    title = `O sinal chega fraco: ${v(s.mv)} no GPIO ${s.echo}`;
    how = 'A ESP32 precisa de pelo menos 2,5 V para ler o pulso. Os resistores do divisor estão invertidos ou com valores errados: 1 kΩ (marrom, preto, vermelho) do ECHO até o GPIO e 2 kΩ (vermelho, preto, vermelho) do GPIO até o GND.';
  } else if (s.mv != null) {
    title = `Nenhum sinal chega no GPIO ${s.echo}`;
    how = `O sensor não respondeu ao disparo. Na ordem: o VCC do sensor está no VIN (5 V) e o GND no GND? O TRIG está no GPIO ${s.trig}? O fio do ECHO chega até o divisor? Se tudo estiver certo, troque os dois sensores de lugar: se o problema mudar de lado, o sensor está com defeito.`;
  } else {
    title = 'Sem eco';
    how = `Confira o VCC no VIN (5 V), o GND, o TRIG no GPIO ${s.trig} e o ECHO pelo divisor até o GPIO ${s.echo}.`;
  }
  return `<div class="diag-side ${tone}"><div class="k">${name} <span>TRIG ${s.trig}, ECHO ${s.echo}</span></div>
    <strong>${esc(title)}</strong><p>${esc(how)}</p></div>`;
}

/* ================================================================ telas */
const views = {};

/* ---------------- Início ---------------- */
views.inicio = {
  mount: () => `
    <div class="head"><div><p class="greet">${greeting()}</p><h1>Seus dependentes</h1></div></div>
    <div id="people"></div>
    <section class="section" style="margin-top:32px">
      <div class="section-head"><h2>Ocorrências recentes</h2><a class="aside" href="#/ocorrencias">Ver todas</a></div>
      <div class="panel" style="padding:4px 20px"><ul class="list" id="recent"></ul></div>
    </section>`,
  refresh() {
    const devs = [...state.devices.values()].sort((a, b) => Number(b.online) - Number(a.online));
    $('#people').innerHTML = devs.length ? devs.map((d) => {
      const p = d.latest?.proximity, imu = d.latest?.imu, loc = d.latest?.location;
      const pos = posture(imu?.tilt);
      const zone = zoneOf(loc);
      const place = zone ? zone.name : zone === false ? 'Fora das zonas' : 'Sem GPS';
      const pend = pendingEvents().filter((e) => e.deviceId === d.id).length;
      const silent = !d.online;
      return `<section class="panel person" style="margin-bottom:20px">
        <a href="#/ao-vivo" data-dev="${esc(d.id)}" style="text-decoration:none;display:grid;gap:18px">
          <div class="person-top">
            <span class="avatar" aria-hidden="true">${esc(initialOf(d))}</span>
            <div class="who"><strong>${esc(deviceName(d))}</strong><span>Dispositivo ${esc(d.id)}${d.latest?.status?.fw ? `, firmware ${esc(d.latest.status.fw)}` : ''}</span></div>
            ${stateTag(d)}
          </div>
          ${silent
            ? `<p class="note">Sem mensagens ${esc(fmtAgo(d.lastSeen))}. Confira se o dispositivo está ligado e dentro do alcance do Wi-Fi.</p>`
            : `<div class="echo">${echoFigure(p, Math.min(1080, $('#view').clientWidth - 42))}</div>`}
          <div class="facts">
            <div class="fact"><div class="k">Equilíbrio</div><div class="v word tone-${pos.tone}">${pos.word}</div></div>
            <div class="fact"><div class="k">Local</div><div class="v word ${zone === false ? 'tone-critical' : zone ? '' : 'tone-muted'}">${esc(place)}</div></div>
            <div class="fact"><div class="k">Pendentes</div><div class="v word ${pend ? 'tone-critical' : 'tone-good'}">${pend ? `${pend} ${pend === 1 ? 'ocorrência' : 'ocorrências'}` : 'Nenhuma'}</div></div>
            <div class="fact"><div class="k">Última leitura</div><div class="v word">${esc(fmtAgo(d.lastSeen))}</div></div>
          </div>
        </a>
      </section>`;
    }).join('') : `<div class="panel empty"><strong>Nenhum dispositivo ainda</strong>
      Ligue o EchoMap e conecte-o ao Wi-Fi (veja <a href="#/dispositivo">Dispositivo</a>). Ele aparece aqui sozinho assim que mandar a primeira leitura.</div>`;

    const recent = state.events.slice(0, 5);
    setHTML($('#recent'), recent.length ? recent.map((e) => eventItem(e, true)).join('')
      : '<li class="empty">Nada aconteceu ainda. Quase colisões, quedas e saídas da zona segura aparecem aqui.</li>');
  },
};

/* ---------------- Ao vivo ---------------- */
views['ao-vivo'] = {
  mount: () => `
    <div class="head">
      <div><h1 id="lvName"></h1><p class="sub" id="lvSub"></p></div>
      <div class="head-actions">${deviceChips()}<span id="lvState"></span></div>
    </div>
    <div class="cols">
      <section class="panel c8">
        <div class="section-head"><h2>Ao redor agora</h2><span class="aside" id="lvMode"></span></div>
        <div class="echo" id="lvEcho"></div>
        <div id="lvLegend"></div>
        <div class="sides" id="lvSides"></div>
      </section>
      <div class="c4 stack">
        <a class="panel" href="#/movimento" style="text-decoration:none" id="lvPosture"></a>
        <a class="panel" href="#/movimento" style="text-decoration:none" id="lvAccel"></a>
        <div class="actions" style="margin-top:0;flex-direction:column">
          <button class="btn" data-cmd="diag">Testar sensores</button>
          <button class="btn primary" data-cmd="locate"><svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>Tocar buzzer</button>
          <a class="btn" href="#/mapa">Ver no mapa</a>
        </div>
      </div>
    </div>
    <section class="panel" id="lvDiagPanel" hidden>
      <div class="section-head"><h2>Teste dos sensores</h2><span class="aside" id="lvDiagWhen"></span></div>
      <div class="diag" id="lvDiag"></div>
    </section>
    <section class="panel">
      <div class="section-head"><h2>Distância dos obstáculos</h2>
        <div class="seg" role="group" aria-label="Período">
          ${[[30000, '30 s'], [60000, '1 min'], [300000, '5 min'], [1800000, '30 min']].map(([ms, t]) => `<button data-win="${ms}" class="${state.windowMs === ms ? 'on' : ''}">${t}</button>`).join('')}
        </div>
      </div>
      <div class="chart" id="lvChart"></div><div class="tip" id="lvTip" hidden></div>
      <div class="legend"><span><i class="sw l"></i>Esquerda</span><span><i class="sw r"></i>Direita</span><span><i class="sw thr"></i>Limiar ajustado</span><span><i class="sw near"></i>Quase colisão</span></div>
    </section>`,
  after() {
    document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => {
      state.windowMs = Number(b.dataset.win);
      document.querySelectorAll('[data-win]').forEach((x) => x.classList.toggle('on', x === b));
      this.refresh();
    }));
  },
  refresh() {
    const d = current();
    const p = d?.latest?.proximity, imu = d?.latest?.imu;
    $('#lvName').textContent = d ? deviceName(d) : 'Nenhum dispositivo';
    $('#lvSub').textContent = d ? `Dispositivo ${d.id}${p ? `, última leitura às ${fmtTime(p.ts)}` : ''}` : 'Ligue o EchoMap para ver as leituras.';
    $('#lvState').innerHTML = d ? stateTag(d) : '';
    $('#lvMode').textContent = p?.mode ? (MODE_LABEL[p.mode] ?? p.mode) : '';
    $('#lvEcho').innerHTML = echoFigure(p, $('#lvEcho').clientWidth, { labels: false });
    $('#lvLegend').innerHTML = echoLegend(p);
    const near = nearCm(p);
    const side = (label, color, dist, bz) => {
      const st = proximity(dist, near);
      const vol = bz != null ? Math.round(bz * 100) : null;
      return `<div class="side">
        <div class="k"><i class="sw ${color}"></i>${label}</div>
        <div class="v">${p ? (dist == null ? '<span class="tone-muted">—</span>' : `${fmtNum(dist)}<small>cm</small>`) : '—'}</div>
        <div class="s tone-${p ? st.tone : 'muted'}">${p ? st.text : 'Aguardando leitura'}</div>
        <div class="meter" aria-hidden="true"><i style="width:${vol ?? 0}%;background:var(--${color === 'l' ? 'left' : 'right'})"></i></div>
        <div class="meter-k">Buzzer ${vol == null ? '—' : `${vol}%`}</div>
      </div>`;
    };
    $('#lvSides').innerHTML = side('Esquerda', 'l', p?.distL, p?.bzL) + side('Direita', 'r', p?.distR, p?.bzR);
    const pos = posture(imu?.tilt);
    $('#lvPosture').innerHTML = `<div class="mini" style="display:block"><div class="k">Equilíbrio</div>
      <div class="v tone-${pos.tone}">${pos.word}</div><div class="s">${imu?.tilt != null ? `Inclinação de ${fmtNum(imu.tilt)}° em relação à posição de uso` : 'Sem dados do acelerômetro'}</div></div>`;
    $('#lvAccel').innerHTML = `<div class="mini" style="display:block"><div class="k">Aceleração</div>
      <div class="v">${imu?.g != null ? `${fmtNum(imu.g, 2)} g` : '—'}</div><div class="s">${imu ? `Pico de ${fmtNum(imu.gMax ?? imu.g, 2)} g no último instante; parado, fica perto de 1 g` : 'Sem dados do acelerômetro'}</div></div>`;

    const dg = d?.latest?.diag;
    const fresh = dg && Date.now() - dg.ts < 15 * 60000;
    $('#lvDiagPanel').hidden = !fresh;
    if (fresh) {
      $('#lvDiagWhen').textContent = `feito ${fmtAgo(dg.ts)}`;
      setHTML($('#lvDiag'), diagSideHtml('Esquerdo', dg.L) + diagSideHtml('Direito', dg.R));
    }

    lineChart($('#lvChart'), $('#lvTip'), {
      pts: state.series.get(state.selected) ?? [], windowMs: state.windowMs, unit: 'cm',
      bands: [{ from: 0, to: near, fill: 'var(--near-wash)' }],
      series: [
        { key: 'thr', name: 'Limiar', color: 'var(--muted)', stepped: true, width: 1.5, dash: '5 4' },
        { key: 'distL', name: 'Esquerda', label: 'Esq.', color: 'var(--left)' },
        { key: 'distR', name: 'Direita', label: 'Dir.', color: 'var(--right)' },
      ],
    });
  },
};

/* ---------------- Ocorrências ---------------- */
views.ocorrencias = {
  mount: () => `
    <div class="head">
      <div><h1>Ocorrências</h1><p class="sub" id="ocSub"></p></div>
      <div class="seg" role="group" aria-label="Filtro">
        ${[['pending', 'Pendentes'], ['all', 'Todas'], ['serious', 'Graves'], ['dismissed', 'Descartados']].map(([k, t]) => `<button data-filter="${k}" class="${state.eventFilter === k ? 'on' : ''}">${t}</button>`).join('')}
      </div>
    </div>
    <div class="panel" style="padding:4px 20px" id="ocList"></div>`,
  after() {
    document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
      state.eventFilter = b.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('on', x === b));
      this.refresh();
    }));
  },
  refresh() {
    const pend = pendingEvents();
    $('#ocSub').textContent = pend.length ? `${pend.length} ${pend.length === 1 ? 'pendente' : 'pendentes'}` : 'Nada pendente';
    let html = '';
    if (state.eventFilter === 'pending') {
      html = pend.length ? `<ul class="list">${pend.map((e) => eventItem(e, true)).join('')}</ul>`
        : '<div class="empty"><strong>Tudo em dia</strong>Nenhuma ocorrência esperando confirmação.</div>';
    } else if (state.eventFilter === 'dismissed') {
      const list = state.events.filter((e) => e.type === 'DISMISSED');
      html = list.length ? `<ul class="list">${list.map((e) => eventItem(e, true)).join('')}</ul>`
        : '<div class="empty"><strong>Nenhum alerta cancelado</strong>Quando a pessoa aperta o botão nos 5 s depois de uma queda ou batida ("Estou bem"), o registro fica aqui, sem alarme.</div>';
    } else if (state.eventFilter === 'serious') {
      const list = state.events.filter((e) => e.severity === 'critical' || e.severity === 'serious');
      html = list.length ? `<ul class="list">${list.map((e) => eventItem(e, true)).join('')}</ul>`
        : '<div class="empty"><strong>Nenhuma ocorrência grave</strong>Quedas, impactos e saídas da zona segura aparecem aqui.</div>';
    } else {
      const resolved = state.events.filter((e) => e.ackedAt || e.severity === 'info');
      html = (pend.length ? `<p class="group-title">Pendentes</p><ul class="list">${pend.map((e) => eventItem(e, true)).join('')}</ul>` : '') +
        (resolved.length ? `<p class="group-title">Resolvidas e avisos</p><ul class="list">${resolved.map((e) => eventItem(e, true)).join('')}</ul>` : '') ||
        '<div class="empty"><strong>Nada registrado ainda</strong>As ocorrências aparecem aqui assim que o dispositivo mandar alguma.</div>';
    }
    setHTML($('#ocList'), html);
  },
};

/* ---------------- Detalhe do alerta ---------------- */
views.alerta = {
  mount(arg) {
    this.id = Number(arg);
    this.ctx = null;
    this.key = null;
    return `<a class="back" href="#/ocorrencias">Voltar para ocorrências</a><div id="alBody"></div>`;
  },
  async after() {
    const e = state.events.find((x) => x.id === this.id);
    if (!e) return;
    /* o que os sensores marcavam em volta do momento */
    const q = (kind) => fetch(`/api/devices/${encodeURIComponent(e.deviceId)}/readings?kind=${kind}&from=${e.ts - 60000}&to=${e.ts + 60000}`).then((r) => r.json()).catch(() => []);
    const [prox, imu, loc] = await Promise.all([q('proximity'), q('imu'), q('location')]);
    const nearest = (arr) => arr.reduce((b, r) => (!b || Math.abs(r.ts - e.ts) < Math.abs(b.ts - e.ts) ? r : b), null);
    const closeProx = prox.filter((r) => Math.abs(r.ts - e.ts) <= 5000);
    let obst = null;
    for (const r of closeProx) for (const [k, s] of [['distL', 'L'], ['distR', 'R']]) if (r[k] != null && (!obst || r[k] < obst.v)) obst = { v: r[k], side: s };
    this.ctx = { imu: nearest(imu.filter((r) => Math.abs(r.ts - e.ts) <= 5000)), obst, loc: nearest(loc) };
    if (view.name === 'alerta') this.refresh();
  },
  refresh() {
    const e = state.events.find((x) => x.id === this.id);
    if (!e) { $('#alBody').innerHTML = '<div class="panel empty"><strong>Ocorrência não encontrada</strong>Ela pode ter saído da lista recente.</div>'; return; }
    const d = state.devices.get(e.deviceId);
    const data = e.data ?? {}, ctx = this.ctx ?? {};
    const accel = data.unit === 'g' ? data.value : ctx.imu ? (ctx.imu.gMax ?? ctx.imu.g) : null;
    const tilt = data.tilt ?? ctx.imu?.tilt ?? null;
    const obst = e.type === 'NEAR_MISS' ? { v: data.value, side: data.side } : ctx.obst;
    const aroundAll = state.events.filter((x) => x.deviceId === e.deviceId && Math.abs(x.ts - e.ts) <= 180000);
    const around = [...aroundAll].sort((a, b) => Math.abs(a.ts - e.ts) - Math.abs(b.ts - e.ts)).slice(0, 9).sort((a, b) => a.ts - b.ts);
    const hiddenCount = aroundAll.length - around.length;
    const sev = e.severity;
    const loc = ctx.loc ?? d?.latest?.location;
    const key = JSON.stringify([e.id, e.ackedAt, Boolean(this.ctx), around.map((x) => x.id), loc?.lat, loc?.lon, d?.name, currentTheme()]);
    if (this.key === key) { $('#alAgo').textContent = fmtAgo(e.ts); return; }
    this.key = key;
    $('#alBody').innerHTML = `
      <div class="detail-top ${sev}">
        <span class="badge ${sev}">${esc(SEV_WORD[sev] ?? '')}</span>
        <h1>${esc(EVENT_LABEL[e.type] ?? e.type)}</h1>
        <p>${esc(deviceName(d))}, ${esc(fmtWhen(e.ts))} (<span id="alAgo">${esc(fmtAgo(e.ts))}</span>)</p>
      </div>
      <div class="cols">
        <div class="c7">
          <div class="figures">
            <div><div class="k">Aceleração</div><div class="v">${accel != null ? `${fmtNum(accel, 2)} g` : '—'}</div><div class="s">batida a partir de ${fmtNum(impactOf(d), 1)} g</div></div>
            <div><div class="k">Obstáculo</div><div class="v">${obst?.v != null ? `${fmtNum(obst.v)} cm` : '—'}</div><div class="s">${obst?.side ? SIDE[obst.side] : 'no momento'}</div></div>
            <div><div class="k">Inclinação</div><div class="v">${tilt != null ? `${fmtNum(tilt)}°` : '—'}</div><div class="s">${tilt != null ? posture(tilt).word.toLowerCase() : 'sem dados'}</div></div>
          </div>
          <section class="section" style="margin-top:28px">
            <div class="section-head"><h2>O que aconteceu</h2><span class="aside">${hiddenCount > 0 ? `as ${around.length} mais próximas de ${aroundAll.length} nesses 3 minutos` : 'nos 3 minutos em volta'}</span></div>
            <ul class="timeline">${around.map((x) => `<li class="${x.severity === 'info' ? (x.type === 'DEVICE_ONLINE' || x.type === 'GEOFENCE_ENTER' ? 'good' : '') : x.severity} ${x.id === e.id ? 'this' : ''}">
              <i></i><strong>${esc(EVENT_LABEL[x.type] ?? x.type)}</strong>${eventDetail(x) ? `, ${esc(eventDetail(x))}` : ''}
              <div class="t">${esc(fmtTime(x.ts))}</div></li>`).join('')}</ul>
          </section>
        </div>
        <div class="c5">
          ${loc?.lat != null ? `<div class="map-box small"><div class="map" id="alMap"></div></div>
            <p class="explain">${(() => { const z = zoneOf(loc); return z ? `Dentro da zona segura ${esc(z.name)}` : z === false ? 'Fora das zonas seguras' : ''; })()}${loc.accuracyM != null ? `, precisão de ${fmtNum(loc.accuracyM)} m` : ''}</p>` : ''}
          <div class="actions" style="flex-direction:column">
            <button class="btn ${sev === 'critical' ? 'danger' : 'primary'}" data-cmd="locate">Tocar buzzer no dispositivo</button>
            ${e.ackedAt ? `<p class="explain">Marcada como ciente ${esc(fmtAgo(e.ackedAt))}.</p>` : `<button class="btn" data-ack="${e.id}">Marcar como ciente</button>`}
            <a class="btn" href="#/mapa" data-dev="${esc(e.deviceId)}">Abrir no mapa</a>
          </div>
        </div>
      </div>`;
    if (loc?.lat != null) {
      this.map?.destroy();
      this.map = makeMap($('#alMap'), { interactive: false });
      this.map?.update(loc, null);
    }
  },
  unmount() { this.map?.destroy(); this.map = null; },
};

/* ---------------- Mapa ---------------- */
views.mapa = {
  mount: () => `
    <div class="head"><div><h1>Localização</h1><p class="sub" id="mpSub"></p></div><div class="head-actions">${deviceChips()}</div></div>
    <div class="cols">
      <div class="c8"><div class="map-box"><div class="map" id="mpMap"></div>
        <div class="map-empty" id="mpEmpty"><strong>Aguardando o GPS</strong>
          <span>A posição aparece quando o GPS do dispositivo encontrar satélites. Em ambiente fechado pode demorar ou não acontecer; perto de uma janela costuma funcionar.</span></div></div></div>
      <div class="c4">
        <section class="panel" id="mpWhere"></section>
        <section class="panel">
          <div class="section-head"><h2>Âncora rápida</h2></div>
          <div id="mpAnchor"></div>
        </section>
        <section class="panel">
          <div class="section-head"><h2>Mapa de calor de obstáculos</h2></div>
          <div class="heat-row">
            <label class="check"><input type="checkbox" id="hmOn"> Mostrar no mapa</label>
            <label class="sr-only" for="hmPeriod">Período</label>
            <select id="hmPeriod">
              <option value="today">Hoje</option><option value="7" selected>7 dias</option><option value="30">30 dias</option><option value="all">Tudo</option>
            </select>
          </div>
          <div class="heat-legend" aria-hidden="true"><span>poucas</span><i></i><span>muitas quase colisões</span></div>
          <p class="explain" id="hmInfo">Mostra onde as quase colisões aconteceram, pela posição do GPS no momento de cada uma. Aproximações mais rápidas pesam mais.</p>
        </section>
        <section class="panel">
          <div class="section-head"><h2>Zonas seguras</h2></div>
          <ul class="zones" id="mpZones"></ul>
          <details class="phone zone-add" id="zAdd">
            <summary>Adicionar zona</summary>
            <form class="wifi-form" id="zForm" autocomplete="off">
              <label for="zName">Nome</label>
              <input type="text" id="zName" maxlength="40" placeholder="Ex.: Escola">
              <label for="zRadius">Raio em metros</label>
              <input type="number" id="zRadius" min="20" max="5000" step="10" value="100" inputmode="numeric">
              <p class="explain" id="zCenter">Clique no mapa no centro da zona.</p>
              <div class="actions">
                <button class="btn" type="button" id="zHere" hidden>Usar a posição atual do EchoMap</button>
                <button class="btn primary" type="submit">Salvar zona</button>
              </div>
            </form>
          </details>
          <p class="explain">Sair de uma zona gera um alerta grave. As zonas ficam salvas no servidor e valem para todos os aparelhos.</p>
        </section>
        <section class="panel">
          <div class="section-head"><h2>Locais por Wi-Fi</h2><button class="quiet" type="button" data-cmd="wifi_scan">Escanear agora</button></div>
          <p class="explain">Dentro de casa o GPS costuma não pegar. Depois de 15 s sem GPS, o dispositivo escaneia o Wi-Fi; se uma rede cadastrada aqui aparecer, o painel mostra o local e não avisa saída de zona por engano.</p>
          <ul class="zones place-list" id="wpList"></ul>
          <form class="wifi-form wifi-place-form" id="wpForm" autocomplete="off">
            <label for="wpAp">Rede vista agora pelo dispositivo</label>
            <div id="wpApBox"></div>
            <label for="wpName">Nome do local</label>
            <input type="text" id="wpName" maxlength="40" placeholder="Ex.: Casa, CESAR School">
            <label class="check"><input type="checkbox" id="wpSafe" checked> Conta como zona segura</label>
            <label class="check"><input type="checkbox" id="wpPos" checked> Guardar a posição atual do mapa para esse local</label>
            <button class="btn primary" type="submit">Cadastrar este local</button>
          </form>
        </section>
      </div>
    </div>`,
  after() {
    this.m = makeMap($('#mpMap'));
    this.draft = null;
    const z0 = (state.config.safeZones ?? [])[0];
    const loc = current()?.latest?.location;
    if (this.m && z0 && !(loc && loc.lat != null)) this.m.map.setView([z0.lat, z0.lon], 16);
    const radius = () => Math.min(5000, Math.max(20, Number($('#zRadius').value) || 100));
    const setCenter = (lat, lon) => {
      this.draft = { lat, lon };
      $('#zCenter').textContent = `Centro: ${lat.toFixed(5)}, ${lon.toFixed(5)}. Clique de novo no mapa para mudar.`;
      if (!this.m) return;
      if (!this.preview) this.preview = L.circle([lat, lon], { radius: radius(), color: getComputedStyle(document.documentElement).getPropertyValue('--echo').trim(), weight: 2, fillOpacity: 0.12 }).addTo(this.m.map);
      this.preview.setLatLng([lat, lon]).setRadius(radius());
    };
    const clearDraft = () => { this.draft = null; this.preview?.remove(); this.preview = null; $('#zCenter').textContent = 'Clique no mapa no centro da zona.'; };
    this.m?.map.on('click', (ev) => { $('#zAdd').open = true; setCenter(ev.latlng.lat, ev.latlng.lng); });
    $('#zRadius').addEventListener('input', () => this.preview?.setRadius(radius()));
    $('#zAdd').addEventListener('toggle', () => { if (!$('#zAdd').open) clearDraft(); });
    $('#zHere').addEventListener('click', () => {
      const l = current()?.latest?.location;
      if (l?.lat != null) { setCenter(l.lat, l.lon); this.m?.map.setView([l.lat, l.lon], 17); }
    });
    /* mapa de calor */
    const loadHeat = async () => {
      if (!$('#hmOn').checked || !this.m) return;
      if (typeof L.heatLayer !== 'function') { $('#hmInfo').textContent = 'O componente do mapa de calor não carregou (public/vendor/leaflet-heat).'; return; }
      const p = $('#hmPeriod').value, now = Date.now();
      const from = p === 'all' ? 0 : p === 'today' ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : now - Number(p) * 86400000;
      const d = current();
      const res = await fetch(`/api/heatmap?from=${from}&to=${now}${d ? `&deviceId=${encodeURIComponent(d.id)}` : ''}`).catch(() => null);
      const data = res?.ok ? await res.json() : null;
      if (!data || !this.m || !$('#hmOn').checked) return;
      this.heat?.remove();
      this.heat = L.heatLayer(data.points, {
        radius: 24, blur: 18, maxZoom: 18, max: Math.max(1, data.max),
        gradient: { 0.2: '#2c7bb6', 0.4: '#abd9e9', 0.6: '#ffffbf', 0.8: '#fdae61', 1: '#d7191c' },
      }).addTo(this.m.map);
      $('#hmInfo').textContent = data.total
        ? `${data.matched} de ${data.total} quase colisões no mapa${data.unmatched ? ` (${data.unmatched} sem posição de GPS no momento)` : ''}, em ${data.points.length} ${data.points.length === 1 ? 'ponto' : 'pontos'}.`
        : 'Nenhuma quase colisão nesse período.';
      if (data.points.length && !(current()?.latest?.location?.lat != null)) this.m.map.fitBounds(data.points.map((q) => [q[0], q[1]]), { maxZoom: 17, padding: [30, 30] });
    };
    const clearHeat = () => { this.heat?.remove(); this.heat = null; };
    $('#hmOn').addEventListener('change', () => { if ($('#hmOn').checked) loadHeat(); else clearHeat(); });
    $('#hmPeriod').addEventListener('change', loadHeat);
    this.heatTimer = setInterval(loadHeat, 60000);

    /* cadastrar o Wi-Fi atual como local conhecido */
    $('#wpForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const d = current(), sel = $('#wpAp');
      const ap = sel ? (d?.latest?.wifi?.aps ?? []).find((a) => a.bssid === sel.value) : null;
      if (!ap) { toast('Nenhuma rede vista ainda: toque em "Escanear agora" com o dispositivo ligado.'); return; }
      const name = $('#wpName').value.trim();
      if (!name) { toast('Dê um nome para o local (ex.: Casa).'); $('#wpName').focus(); return; }
      const loc = d?.latest?.location;
      const pos = $('#wpPos').checked && loc?.lat != null ? { lat: loc.lat, lng: loc.lon } : {};
      const res = await fetch('/api/wifi-places', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, bssid: ap.bssid, minRssi: Math.max(-95, (ap.rssi ?? -70) - 15), isSafeZone: $('#wpSafe').checked, ...pos }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { toast(body.error ?? 'Não foi possível cadastrar o local.'); return; }
      toast(`Local "${body.name}" cadastrado pela rede ${ap.ssid || ap.bssid}.`);
      $('#wpName').value = '';
    });

    $('#zForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = $('#zName').value.trim();
      if (!name) { toast('Dê um nome para a zona (ex.: Casa, Escola).'); $('#zName').focus(); return; }
      if (!this.draft) { toast('Clique no mapa para escolher o centro da zona.'); return; }
      const res = await fetch('/api/zones', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, lat: this.draft.lat, lon: this.draft.lon, radiusM: radius() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { toast(body.error ?? 'Não foi possível salvar a zona.'); return; }
      toast(`Zona "${body.name}" salva.`);
      $('#zName').value = '';
      $('#zAdd').open = false;
      clearDraft();
    });
  },
  refresh() {
    const d = current();
    const loc = d?.latest?.location;
    const has = loc && loc.lat != null;
    $('#mpEmpty').hidden = !!has;
    $('#mpSub').textContent = d ? deviceName(d) : '';
    const z = zoneOf(loc);
    const ind = indoorOf(d);
    if (ind) {
      $('#mpWhere').innerHTML = `
      <div class="where ${ind.isSafeZone ? 'in' : ''}"><i></i>Ambiente interno conhecido</div>
      <h2 style="margin-top:8px">${esc(deviceName(d))} está em ${esc(ind.placeName)} (Wi-Fi)</h2>
      <p class="explain" style="margin-top:6px">Sem GPS aqui dentro. A posição vem da rede cadastrada (sinal de ${fmtNum(ind.rssi)} dBm), atualizada ${esc(fmtAgo(ind.ts))}.${ind.isSafeZone ? ' Conta como zona segura: o painel não avisa saída por causa do GPS ruim.' : ''}</p>`;
    } else $('#mpWhere').innerHTML = has ? `
      <div class="where ${z ? 'in' : 'out'}"><i></i>${z ? 'Dentro da zona segura' : 'Fora das zonas seguras'}</div>
      <h2 style="margin-top:8px">${esc(deviceName(d))} ${z ? `está em ${esc(z.name)}` : 'está fora das zonas'}</h2>
      <p class="explain" style="margin-top:6px">Atualizado ${esc(fmtAgo(loc.ts))}${loc.accuracyM != null ? `, precisão de ${fmtNum(loc.accuracyM)} m` : ''}${loc.sats != null ? `, ${loc.sats} satélites` : ''}.</p>`
      : '<div class="where"><i></i>Sem posição</div><p class="explain" style="margin-top:6px">Assim que o GPS tiver sinal, a posição e o trajeto aparecem no mapa.</p>';
    const zones = state.config.safeZones ?? [];
    setHTML($('#mpZones'), zones.length ? zones.map((zz) => zz.type === 'dynamic'
      ? `<li><span class="zone-ring dynamic" aria-hidden="true"></span>
      <div><strong>Âncora rápida</strong><div class="s">Raio de ${fmtNum(zz.radiusM)} m, expira em ${fmtLeft((zz.expiresAt ?? 0) - Date.now())}</div></div></li>`
      : `<li><span class="zone-ring" aria-hidden="true"></span>
      <div><strong>${esc(zz.name)}</strong><div class="s">Raio de ${fmtNum(zz.radiusM)} m, avisa ao sair</div></div>
      ${zz.id ? `<button class="quiet" type="button" data-zone-del="${esc(zz.id)}" data-name="${esc(zz.name)}">Remover</button>` : ''}</li>`).join('')
      : '<li class="s">Nenhuma zona ainda. Clique no mapa para criar a primeira.</li>');

    /* âncora rápida do dispositivo selecionado */
    const anc = anchorOf(d);
    const def = state.config.anchor ?? { radiusM: 100, hours: 4 };
    setHTML($('#mpAnchor'), anc
      ? `<p class="res ok">Âncora ativa: raio de ${fmtNum(anc.radiusM)} m, expira em <b>${fmtLeft((anc.expiresAt ?? 0) - Date.now())}</b>. Sair dela gera alerta como qualquer zona segura.</p>
        <div class="actions"><button class="btn" type="button" data-anchor="remove">Remover âncora</button></div>`
      : `<p class="explain">Cria uma zona segura temporária onde ${esc(d ? deviceName(d) : 'o dispositivo')} está agora (raio de ${fmtNum(def.radiusM)} m, por ${fmtNum(def.hours)} h). No dispositivo: 2 cliques rápidos no botão fazem o mesmo.</p>
        <div class="actions"><button class="btn primary" type="button" data-anchor="create" ${has ? '' : 'disabled'}>Criar âncora aqui</button></div>
        ${has ? '' : '<p class="explain">Precisa de uma posição do dispositivo (GPS ou local por Wi-Fi).</p>'}`);

    /* locais por Wi-Fi */
    const places = state.config.wifiPlaces ?? [];
    setHTML($('#wpList'), places.length ? places.map((p) => `<li><span class="zone-ring ${p.isSafeZone ? '' : 'dynamic'}" aria-hidden="true"></span>
      <div><strong>${esc(p.name)}</strong><div class="s"><code>${esc(p.bssid)}</code>, sinal a partir de ${fmtNum(p.minRssi)} dBm${p.isSafeZone ? ', zona segura' : ''}${p.lat == null ? ', sem posição' : ''}</div></div>
      <button class="quiet" type="button" data-place-del="${p.id}" data-name="${esc(p.name)}">Remover</button></li>`).join('')
      : '<li class="s">Nenhum local cadastrado.</li>');
    const aps = d?.latest?.wifi?.aps ?? [];
    const apsKey = aps.map((a) => a.bssid).join(',');
    if (this.apsKey !== apsKey) {
      this.apsKey = apsKey;
      setHTML($('#wpApBox'), aps.length
        ? `<select id="wpAp">${aps.map((a) => `<option value="${esc(a.bssid)}">${esc(a.ssid || '(rede oculta)')} — ${esc(a.bssid)}, ${fmtNum(a.rssi)} dBm</option>`).join('')}</select>`
        : '<p class="explain">Nenhuma varredura ainda. Toque em "Escanear agora" com o dispositivo ligado no local que quer cadastrar.</p>');
    }
    $('#zHere').hidden = !has;
    if (has) this.m?.update(loc, state.track.get(state.selected));
  },
  unmount() { clearInterval(this.heatTimer); this.heat = null; this.m?.destroy(); this.m = null; this.preview = null; this.apsKey = null; },
};

/* ---------------- Movimento ---------------- */
views.movimento = {
  mount: () => `
    <div class="head"><div><h1>Movimento e equilíbrio</h1><p class="sub" id="mvSub"></p></div><div class="head-actions">${deviceChips()}</div></div>
    <div class="cols">
      <section class="panel c5"><div class="section-head"><h2>Equilíbrio</h2></div><div id="mvGauge"></div></section>
      <section class="panel c7"><div class="section-head"><h2>Aceleração</h2><span class="aside">último minuto</span></div>
        <div class="chart short" id="mvChart"></div><div class="tip" id="mvTip" hidden></div>
        <div class="legend"><span><i class="sw" style="background:var(--echo)"></i>Aceleração</span><span><i class="sw" style="background:var(--critical)"></i>Batida</span><span><i class="sw" style="background:var(--warning)"></i>Sem peso (início de queda)</span></div>
      </section>
    </div>
    <section class="panel">
      <div class="section-head"><h2>Quedas e batidas</h2></div>
      <ul class="list" id="mvList"></ul>
      <p class="explain">Queda: o corpo fica sem peso (abaixo de 0,5 g), bate (2 g ou mais) e continua inclinado depois de 2 segundos. Pulos, corrida e degraus têm o mesmo começo, mas a pessoa continua de pé, por isso não viram alerta. Queda e batida só chegam aqui 5 s depois: nesse tempo o dispositivo pisca em âmbar e apita, e 1 clique no botão cancela ("Estou bem", aparece como alerta cancelado). Batida: pancada de ${fmtNum(impactOf(current()), 1)} g ou mais (ajustável na calibração, tela Dispositivo).</p>
    </section>`,
  refresh() {
    const d = current();
    const imu = d?.latest?.imu;
    $('#mvSub').textContent = d ? `${deviceName(d)}, acelerômetro MPU` : '';
    const pos = posture(imu?.tilt);
    $('#mvGauge').innerHTML = `<div class="gauge">${tiltGauge(imu?.tilt)}
      <div><div class="v">${imu?.tilt != null ? `${fmtNum(imu.tilt)}°` : '—'}</div><div class="word tone-${pos.tone}">${pos.word}</div>
      <p class="s">Inclinação em relação à posição em que o dispositivo estava ao ligar.</p></div></div>
      <div class="bands"><span class="b1">0 a 30°, em pé</span><span class="b2">30 a 60°, inclinado</span><span class="b3">acima de 60°, deitado</span></div>`;
    lineChart($('#mvChart'), $('#mvTip'), {
      pts: state.imuSeries.get(state.selected) ?? [], windowMs: 60000, unit: 'g', yFloor: 4, digits: 2,
      refs: [{ v: impactOf(current()), label: 'batida', color: 'var(--critical)' }, { v: 0.5, label: 'sem peso', color: 'var(--warning)' }],
      series: [{ key: 'g', name: 'Aceleração', color: 'var(--echo)' }],
    });
    const list = state.events.filter((e) => e.deviceId === state.selected && (e.type === 'FALL' || e.type === 'IMPACT' || e.type === 'DISMISSED'));
    setHTML($('#mvList'), list.length ? list.slice(0, 20).map((e) => eventItem(e, false)).join('')
      : '<li class="empty">Nenhuma queda ou batida registrada.</li>');
  },
};

/* ---------------- Dispositivo (nome, conexão, Wi-Fi, painel) ---------------- */
views.dispositivo = {
  mount: () => `
    <div class="head"><div><h1>Dispositivo</h1><p class="sub" id="dvSub"></p></div><div class="head-actions">${deviceChips()}</div></div>
    <div class="cols">
      <div class="c6 stack">
        <section class="panel">
          <div class="section-head"><h2>Nome de quem usa</h2></div>
          <form class="name-form" id="dvName"><label class="sr-only" for="dvNameIn">Nome</label>
            <input type="text" id="dvNameIn" maxlength="60" placeholder="Ex.: Ana" autocomplete="off"><button class="btn" type="submit">Salvar nome</button></form>
        </section>
        <section class="panel">
          <div class="section-head"><h2>Conexão</h2><div class="channel-row" id="dvPower"></div></div>
          <dl class="rows" id="dvNet"></dl>
          <div id="dvBroker"></div>
          <div class="actions">
            <button class="btn" data-cmd="portal">Abrir o portal no celular</button>
          </div>
          <div class="haptic-test">
            <label for="hpSel">Testar um aviso no dispositivo</label>
            <div class="pick">
              <select id="hpSel">${HAPTIC.map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('')}</select>
              <button class="btn" type="button" id="hpBtn">Tocar no dispositivo</button>
            </div>
            <p class="explain" id="hpHint"></p>
          </div>
        </section>
        <section class="panel">
          <div class="section-head"><h2>Calibração</h2><span class="aside" id="calWhen"></span></div>
          <div id="calBody"></div>
        </section>
      </div>
      <div class="c6 stack">
        <section class="panel">
          <div class="section-head"><h2>Wi-Fi do EchoMap</h2><div class="channel-row" id="wfBadge"></div></div>
          <div id="wfState"></div>
          <div id="wfOnline">
          <div id="wfHost"></div>
          <form class="wifi-form" id="wfForm" autocomplete="off">
            <label for="wfSsid">Rede Wi-Fi</label>
            <input type="text" id="wfSsid" maxlength="32" autocapitalize="none" spellcheck="false" placeholder="Nome da rede da casa">
            <label for="wfPass">Senha</label>
            <input type="password" id="wfPass" maxlength="63" autocomplete="new-password" placeholder="Vazia se a rede for aberta">
            <button class="btn primary" type="submit" id="wfBtn">Conectar a esta rede</button>
          </form>
          <p class="explain" id="wfHint"></p>
          <div class="board-log-wrap" id="wfLogWrap" hidden><p class="log-title">Mensagens da placa</p><ul class="board-log" id="wfLog"></ul></div>
          <details class="phone" id="wfPhone">
            <summary>Conectar pelo celular, sem o painel</summary>
            <div class="phone-body" id="wfPhoneBody"></div>
          </details>
          </div>
          <div class="two-ways" id="wfOffline" hidden>
            <div class="way">
              <h3>Pelo cabo USB</h3>
              <div id="wfUsb"></div>
            </div>
            <div class="way">
              <h3>Pelo celular</h3>
              <div class="phone-body" id="wfPhoneWay"></div>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="section-head"><h2>Este painel</h2></div>
          <dl class="rows" id="dvPanel"></dl>
          <div class="actions"><button class="btn" id="notifyBtn" type="button"></button><button class="btn" id="themeBtn2" type="button"></button><button class="btn" id="logoutBtn" type="button" hidden>Sair deste aparelho</button></div>
        </section>
      </div>
    </div>`,
  after() {
    const d = current();
    $('#dvNameIn').value = d?.name ?? '';
    $('#dvName').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const dev = current();
      if (!dev) return;
      const res = await fetch(`/api/devices/${encodeURIComponent(dev.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#dvNameIn').value }),
      });
      toast(res.ok ? 'Nome salvo.' : 'Não foi possível salvar o nome.');
    });
    $('#wfPass').addEventListener('input', () => this.refresh());
    $('#wfSsid').addEventListener('input', () => this.refresh());
    $('#notifyBtn').addEventListener('click', async () => {
      beep();
      if ('Notification' in window && Notification.permission !== 'granted') await Notification.requestPermission();
      this.refresh();
    });
    $('#themeBtn2').addEventListener('click', toggleTheme);
    $('#hpSel').addEventListener('change', () => this.refresh());
    $('#hpBtn').addEventListener('click', () => {
      const pattern = $('#hpSel').value, id = current()?.id ?? state.selected;
      /* "Localizar" usa o comando antigo, que todo firmware entende */
      if (pattern === 'locate') sendCommand('locate', id);
      else sendCommand('haptic', id, { pattern });
    });
    $('#logoutBtn').hidden = !state.config.auth?.remote;
    $('#logoutBtn').addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
      location.href = '/login.html';
    });
    this.loadHost();
    this.hostTimer = setInterval(() => this.loadHost(), 20000);
    /* ultimo resultado de calibracao guardado no servidor (o "latest" se perde quando o servidor reinicia) */
    if (d) fetch(`/api/devices/${encodeURIComponent(d.id)}/calibrations?limit=1`).then((r) => r.json())
      .then((list) => { this.calLast = list[0] ?? null; this.refresh(); }).catch(() => {});
    $('#wfHost').addEventListener('click', async (ev) => {
      const act = ev.target.closest('[data-host]')?.dataset.host;
      if (act === 'use' && this.host?.ssid) {
        $('#wfSsid').value = this.host.ssid;
        $('#wfPass').value = '';
        this.hostUsed = true;
        this.refresh();
        $('#wfPass').focus();
      } else if (act === 'pass') {
        const res = await fetch('/api/host-wifi/password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ssid: $('#wfSsid').value.trim() }),
        });
        const body = await res.json().catch(() => ({}));
        if (body.password) { $('#wfPass').value = body.password; toast('Senha salva do Windows preenchida.'); }
        else toast(body.error ?? 'Não foi possível ler a senha salva. Digite a senha.');
      }
    });
    $('#wfForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const dev = current() ?? { id: state.serial?.deviceId ?? 'node1' };
      const ssid = $('#wfSsid').value.trim();
      if (!ssid) { toast('Digite o nome da rede Wi-Fi (ou use a rede deste computador).'); $('#wfSsid').focus(); return; }
      const res = await fetch(`/api/devices/${encodeURIComponent(dev.id)}/command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'wifi', ssid, pass: $('#wfPass').value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { toast(body.error ?? 'Não foi possível enviar.'); return; }
      $('#wfPass').value = '';
      this.sent = { ssid, at: Date.now() };
      this.refresh();
    });
  },
  refresh() {
    const d = current();
    const st = d?.latest?.status ?? {}, net = d?.latest?.net;
    $('#dvSub').textContent = d ? `${deviceName(d)}, identificação ${d.id}` : 'Nenhum dispositivo conectado ainda';
    const rq = rssiQuality(st.rssi);
    const row = (k, v, hint) => `<dt>${k}</dt><dd>${v}${hint ? `<span class="hint">${hint}</span>` : ''}</dd>`;
    const wifi = d?.source === 'mqtt' || st.ip;
    setHTML($('#dvNet'), !d ? row('Situação', 'Aguardando o primeiro contato') :
      row('Situação', esc(linkOf(d).text)) +
      (wifi ? row('Rede Wi-Fi', esc(st.ssid ?? '—'), st.channel != null ? `canal ${st.channel}` : '') : '') +
      (st.rssi != null ? row('Sinal', `<span class="bars q${rq.q}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${rq.word}, ${fmtNum(st.rssi)} dBm`) : '') +
      (net ? row('Latência', `${fmtNum(net.rttAvgMs)} ms${sparkline(net.samples)}`, `ida e volta até o dispositivo; última ${fmtNum(net.rttMs)} ms, pior recente ${fmtNum(net.rttMaxMs)} ms`) : wifi ? row('Latência', '—', 'medida a cada 5 s quando o dispositivo está online pelo Wi-Fi') : '') +
      (st.ip ? row('Endereço do dispositivo', `<code>${esc(st.ip)}</code>`) : '') +
      (st.broker ? row('Servidor', `<code>${esc(st.broker)}</code>`, st.autoBroker ? 'encontrado automaticamente na rede' : 'endereço fixo configurado') : '') +
      (st.lowLatency != null ? row('Modo de baixa latência', st.lowLatency ? 'Ligado' : 'Desligado', st.lowLatency ? 'Wi-Fi sempre acordado: respostas em milissegundos, gasta mais bateria' : 'economiza bateria, respostas podem demorar até 300 ms') : '') +
      (st.queued ? row('Alertas aguardando envio', fmtNum(st.queued)) : '') +
      (st.powerState ? row('Energia', st.powerState === 'idle' ? 'Economia' : 'Ativo', st.powerState === 'idle'
        ? 'parado há 2 min: sensores a 1 leitura por segundo e Wi-Fi em economia; qualquer movimento ou clique volta na hora'
        : 'sensores a cerca de 10 leituras por segundo') : '') +
      (st.actuator ? row('Avisos no corpo', st.actuator === 'motor' ? 'Motor de vibração' : 'Buzzer', 'troque com "atuador motor" ou "atuador buzzer" na Serial') : '') +
      row('Firmware', esc(st.fw ?? '—')) +
      row('Ligado há', fmtDuration(st.uptimeS)) +
      (st.heap != null ? row('Memória livre', `${fmtNum(st.heap / 1024)} KB`) : '') +
      (st.battery != null ? row('Bateria', `${fmtNum(st.battery)}%`) : ''));
    setHTML($('#dvPower'), st.powerState && d?.online
      ? `<span class="channel power-${st.powerState}"><i></i>${st.powerState === 'idle' ? 'Economia' : 'Ativo'}</span>` : '');
    const hp = HAPTIC.find((h) => h[0] === $('#hpSel').value) ?? HAPTIC[0];
    $('#hpHint').textContent = `${hp[2]}. Toca no ${st.actuator === 'motor' ? 'motor de vibração' : 'buzzer'} do dispositivo${st.fw && st.fw < '1.6' ? ' (padrões novos precisam do firmware 1.6; com firmware antigo só "Localizar" funciona)' : ''}.`;
    $('#hpBtn').disabled = !d?.online;
    const srv = state.config.server ?? {};
    /* a placa esta no Wi-Fi mas nao fala com o broker deste PC (IP fixo antigo, outra rede, firewall) */
    const brokerHost = st.broker?.split(':')[0];
    const brokerLost = Boolean(d && st.wstate === 'connected' && (st.mqtt === false
      || (st.mqtt == null && d.source !== 'mqtt' && brokerHost && srv.ips?.length && !srv.ips.includes(brokerHost))));
    setHTML($('#dvBroker'), brokerLost ? `<div class="broker-lost">
      <p class="warn"><b>O EchoMap está no Wi-Fi, mas não alcança este servidor.</b> Ele procura o painel em <code>${esc(brokerHost || 'nenhum endereço')}</code>${st.autoBroker === false ? ' (endereço fixo)' : ''}${srv.ips?.length ? `, e este computador está em ${srv.ips.map(esc).join(', ')}` : ''}. Os alertas ficam guardados na placa até a conexão voltar.</p>
      <button class="btn small" type="button" data-cmd="server">Encontrar o servidor automaticamente</button></div>` : '');
    const notifOn = 'Notification' in window && Notification.permission === 'granted';
    setHTML($('#dvPanel'),
      row('Computador', esc(srv.host ?? '—'), srv.ips?.length ? `endereços ${srv.ips.map(esc).join(', ')}` : '') +
      (state.config.auth?.password ? row('Senha para outros aparelhos', `<code>${esc(state.config.auth.password)}</code>`, 'celular ou outro PC pedem essa senha; neste computador o painel abre direto') : '') +
      (srv.mqttPort ? row('Porta MQTT', String(srv.mqttPort), srv.discovery ? 'anunciada na rede para a descoberta automática' : 'descoberta automática desligada') : '') +
      (srv.serial ? row('Cabo USB', `<code>${esc(srv.serial)}</code>`) : '') +
      row('Quase colisão', `impacto em até 1,5 s ou abaixo de ${fmtNum(nearCm(d?.latest?.proximity))} cm`, 'parede ou pessoa parada ao lado só gera o aviso local, sem ocorrência (firmware 1.5)') +
      row('Batida', `a partir de ${fmtNum(impactOf(d), 2)} g`, d?.latest?.status?.impactG != null ? 'limiar em uso na placa (calibrável)' : '') +
      row('Sem sinal', `depois de ${fmtNum((state.config.offlineAfterMs ?? 10000) / 1000)} s sem mensagens`));
    this.refreshWifi(d, st);
    this.refreshCalibration(d, st);
    $('#notifyBtn').textContent = notifOn ? 'Alertas no navegador ligados' : 'Ligar alertas no navegador';
    $('#notifyBtn').disabled = notifOn;
    $('#themeBtn2').textContent = themeLabel();
  },
};

views.dispositivo.loadHost = async function loadHost() {
  try {
    this.host = await (await fetch('/api/host-wifi')).json();
  } catch { this.host = null; }
  if (view.name === 'dispositivo') this.refresh();
};

views.dispositivo.unmount = function unmount() { clearInterval(this.hostTimer); };

/* passos do celular (aparece dentro do "Conectar pelo celular" e, desconectado, em destaque) */
function phoneSteps(ap, pw) {
  return `<div class="qr" aria-hidden="true">${wifiQr(ap, pw)}</div>
    <ol class="steps">
      <li>Dê <b>3 cliques rápidos</b> no botão do EchoMap. O LED fica azul, pulsando.</li>
      <li>No celular, aponte a câmera para o código ou entre na rede <code>${esc(ap)}</code> com a senha <code>${esc(pw)}</code>.</li>
      <li>A página abre sozinha (ou abra <code>192.168.4.1</code>). Toque na rede da casa, digite a senha e toque em <b>Testar e salvar</b>.</li>
    </ol>`;
}

/* bloco do cabo USB: busca automática, porta em uso, escolha da porta, porta liberada */
function usbBlock(s) {
  if (!s || s.status === 'unavailable') {
    return '<p>A leitura pelo cabo precisa do pacote <code>serialport</code>: rode <code>npm install</code> na pasta do painel e reinicie o servidor.</p>';
  }
  if (s.status === 'off') return '<p>A detecção do cabo está desligada (servidor iniciado com <code>--sem-usb</code>).</p>';
  const opts = (s.ports ?? []).map((p) => `<option value="${esc(p.path)}" ${p.path === s.path ? 'selected' : ''}>${esc(p.label)}${p.compatible ? '' : ' (não parece uma placa)'}</option>`).join('');
  const picker = opts ? `<div class="port-pick"><label class="sr-only" for="wfPort">Porta USB</label><select id="wfPort">${opts}</select>
    <button class="btn small" type="button" data-usb="connect">Conectar via USB</button></div>` : '';
  const drivers = '<p class="s">Use um cabo de dados (alguns só carregam). Se a placa não aparecer no Gerenciador de Dispositivos, instale o driver CP210x ou CH340.</p>';
  switch (s.status) {
    case 'choose': return `<p>Encontrei mais de uma placa. Escolha a porta do EchoMap:</p>${picker}`;
    case 'connecting': return `<p class="searching"><i class="pulse" aria-hidden="true"></i>Conectando em ${esc(s.path)}…</p>`;
    case 'busy': return `<p class="tone-critical">${esc(s.error ?? 'A porta está em uso.')}</p>${picker}`;
    case 'connected': return `<p class="searching"><i class="pulse" aria-hidden="true"></i>Conectado em ${esc(s.path)}, esperando o EchoMap responder…</p>`;
    case 'paused': {
      const at = s.pausedUntil ? new Date(s.pausedUntil).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
      return `<p>A porta está liberada para gravar o firmware${at ? ` até ${at}` : ''}.</p><button class="btn small" type="button" data-usb="auto">Usar o cabo agora</button>`;
    }
    default: return `<p class="searching"><i class="pulse" aria-hidden="true"></i>Procurando o EchoMap nas portas USB… conecte o cabo.</p>${drivers}${s.ports?.length ? `<details class="ports"><summary>Escolher a porta à mão</summary>${picker}</details>` : ''}`;
  }
}

document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-usb]')?.dataset.usb;
  if (!act) return;
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json()).catch(() => null);
  let next = null;
  if (act === 'connect') next = await post('/api/serial/connect', { path: $('#wfPort')?.value });
  if (act === 'auto') next = await post('/api/serial/auto');
  if (act === 'release') {
    next = await post('/api/serial/release', { minutes: 3 });
    toast('Porta USB liberada por 3 minutos: grave o firmware no PlatformIO. Depois o painel volta a usar o cabo sozinho.');
  }
  if (next) { state.serial = next; scheduleRefresh(); }
});

/* calibracao assistida: instrucoes, progresso ao vivo (0-30 s) e antes/depois dos limiares */
views.dispositivo.refreshCalibration = function refreshCalibration(d, st) {
  const live = d?.latest?.calibration;
  const running = Boolean(d?.online && (st.calibrating || (live?.state === 'running' && Date.now() - live.ts < 4000)));
  const last = live && live.state !== 'running' && live.state !== 'cancelled' ? live : this.calLast;
  const oldFw = st.fw && st.fw < '1.7';
  const impact = impactOf(d), hyst = st.hystCm ?? HYST_DEFAULT_CM;
  const calibrated = (st.impactG != null && Math.abs(st.impactG - state.config.thresholds.impactG) > 0.005) || Math.abs(hyst - HYST_DEFAULT_CM) > 0.05;
  $('#calWhen').textContent = d?.calibratedAt ? `calibrado ${fmtAgo(d.calibratedAt)}` : '';

  if (running) {
    const dur = live?.durationS ?? 30, el = Math.min(live?.elapsedS ?? 0, dur);
    setHTML($('#calBody'), `
      <p class="res run">Ande em linha reta num corredor livre, no seu passo normal. O LED pisca em azul enquanto mede.</p>
      <div class="cal-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${dur}" aria-valuenow="${Math.round(el)}"><i style="width:${(el / dur) * 100}%"></i></div>
      <p class="cal-count"><b>${fmtNum(el)} de ${fmtNum(dur)} s</b>, ${fmtNum(live?.steps ?? 0)} passos contados</p>
      <div class="actions"><button class="btn" type="button" data-cal="stop">Cancelar calibração</button></div>`);
    return;
  }

  let result = '';
  if (last?.state === 'failed') {
    result = `<p class="res bad">A última calibração não valeu: só ${fmtNum(last.steps)} passos em ${fmtNum(last.durationS)} s. Ande no seu passo normal durante todo o tempo. Os limiares não mudaram.</p>`;
  } else if (last && (last.state === 'done' || last.state === 'reset')) {
    const rowsHtml = (k, a, b, unit, dg) => `<tr><th scope="row">${k}</th><td>${a == null ? '—' : `${fmtNum(a, dg)} ${unit}`}</td><td><b>${b == null ? '—' : `${fmtNum(b, dg)} ${unit}`}</b></td></tr>`;
    result = `<p class="cal-title">${last.state === 'reset' ? 'Padrões de fábrica restaurados' : 'Resultado da última calibração'}</p>
      <table class="cal-table"><thead><tr><th></th><th scope="col">Antes</th><th scope="col">Depois</th></tr></thead><tbody>
        ${rowsHtml('Limiar de batida', last.impactBefore, last.impactAfter, 'g', 2)}
        ${rowsHtml('Histerese dos ultrassônicos', last.hystBefore, last.hystAfter, 'cm', 1)}
      </tbody></table>
      ${last.state === 'done' ? `<p class="explain">${fmtNum(last.steps)} passos, pico médio ${fmtNum(last.stepMean, 2)} g (maior ${fmtNum(last.stepMax, 2)} g). Ruído do eco: esquerdo ${last.noiseL != null ? `${fmtNum(last.noiseL, 1)} cm` : 'sem eco'}, direito ${last.noiseR != null ? `${fmtNum(last.noiseR, 1)} cm` : 'sem eco'}.${last.reason === 'sem_eco' ? ' Sem eco suficiente nos ultrassônicos: a histerese ficou como estava.' : ''}</p>` : ''}`;
  }

  setHTML($('#calBody'), `
    <p class="explain">Ajusta o limiar de batida ao jeito de andar de quem usa (passo × 1,6, entre 2,5 e 4,5 g) e a histerese dos ultrassônicos ao ruído do eco. Prenda o dispositivo como no dia a dia, aperte Iniciar e ande 30 s em linha reta num corredor livre.</p>
    <p class="cal-now">Em uso: batida a partir de <b>${fmtNum(impact, 2)} g</b>, histerese de <b>${fmtNum(hyst, 1)} cm</b> ${calibrated ? '(calibrado)' : '(de fábrica)'}.</p>
    ${result}
    ${oldFw ? '<p class="warn">A calibração precisa do firmware 1.7. Grave o firmware novo pelo PlatformIO.</p>' : ''}
    <div class="actions">
      <button class="btn primary" type="button" data-cal="start" ${d?.online && !oldFw ? '' : 'disabled'}>Iniciar calibração (30 s)</button>
      ${calibrated ? '<button class="btn" type="button" data-cal="reset">Restaurar padrões de fábrica</button>' : ''}
    </div>`);
};

views.dispositivo.refreshWifi = function refreshWifi(d, st) {
  const s = state.serial;
  const usbId = s?.deviceId ?? d?.id ?? 'node1';
  const usb = s?.status === 'connected' && (!d || usbId === d.id) && Boolean(d?.online || !d);
  const channel = usb ? 'usb' : d?.online ? 'wifi' : 'none';
  const ap = st.ap ?? `EchoMap-${d?.id ?? usbId}`;
  const pw = state.config.portalPassword ?? 'echomap123';

  /* selo do canal ativo */
  setHTML($('#wfBadge'), channel === 'usb'
    ? `<span class="channel usb"><i></i>Configurando via cabo USB (${esc(s.path)})</span><button class="quiet" type="button" data-usb="release" title="Solta a porta por 3 minutos para o PlatformIO gravar o firmware">Liberar a porta</button>`
    : channel === 'wifi' ? '<span class="channel wifi"><i></i>Configurando via Wi-Fi</span>'
      : '<span class="channel none"><i></i>EchoMap desconectado</span>');
  $('#wfOnline').hidden = channel === 'none';
  $('#wfOffline').hidden = channel !== 'none';

  if (channel === 'none') {
    setHTML($('#wfState'), '<p class="res run">O painel não alcança o EchoMap agora. Escolha um dos dois caminhos abaixo: assim que ele aparecer, o formulário da rede é liberado.</p>');
    setHTML($('#wfUsb'), usbBlock(s));
    setHTML($('#wfPhoneWay'), phoneSteps(ap, pw));
    return;
  }

  /* o que o EchoMap está fazendo com o Wi-Fi (pelo cabo isso chega na hora) */
  const sent = this.sent && Date.now() - this.sent.at < 60000 ? this.sent : null;
  const errTxt = WIFI_ERR[st.wifiErr] ?? WIFI_ERR.falha;
  let msg = '';
  if (st.wifiTest === 'running') {
    msg = `<p class="res run">Testando a rede <b>${esc(st.wifiTry)}</b>. Leva até 20 s; o LED pisca em azul-claro.</p>`;
  } else if (st.wifiTest === 'ok') {
    msg = `<p class="res ok">Conectado em <b>${esc(st.wifiTry ?? st.ssid)}</b>. A rede foi salva no EchoMap.</p>`;
  } else if (st.wifiTest === 'fail') {
    msg = `<p class="res bad">Não conectou em <b>${esc(st.wifiTry)}</b>: ${esc(errTxt)}. ${st.wcfg ? 'O EchoMap continua na rede anterior.' : ''}</p>`;
  } else if (sent) {
    msg = `<p class="res run">Pedido enviado${channel === 'usb' ? ' pelo cabo' : ''}. O EchoMap vai testar <b>${esc(sent.ssid)}</b>${channel === 'wifi' ? ' e sai do ar por alguns segundos' : ''}; o resultado aparece aqui.</p>`;
  } else if (st.wstate === 'connecting' && st.wcfg) {
    msg = `<p class="res bad">O EchoMap está tentando a rede <b>${esc(st.wcfg)}</b> e não consegue${st.wifiErr ? `: ${esc(errTxt)}` : ''}. Digite a rede certa abaixo.</p>`;
  } else if (st.wstate === 'none') {
    msg = '<p class="res run">O EchoMap ainda não tem rede Wi-Fi. Digite a rede abaixo.</p>';
  }
  if (st.portal) {
    msg += `<div class="portal-now"><div class="qr">${wifiQr(ap, pw)}</div><p><b>Portal aberto.</b> Também dá para configurar pelo celular: aponte a câmera para o código ou entre na rede <code>${esc(ap)}</code> (senha <code>${esc(pw)}</code>).</p></div>`;
  }
  setHTML($('#wfState'), msg);

  /* rede deste computador: 1 clique */
  const h = this.host;
  const typed = $('#wfSsid').value.trim();
  let host = '';
  if (h?.ssid) {
    const same = typed === h.ssid;
    const working = st.ssid === h.ssid && st.wstate === 'connected'; /* o EchoMap já está nessa rede: nada a sugerir */
    host = same ? '' : `<button class="btn small ghost-acc" type="button" data-host="use">Usar a rede deste computador (${esc(h.ssid)})</button>`;
    if (same && !working && h.canReadPassword && !$('#wfPass').value) host += '<button class="btn small ghost-acc" type="button" data-host="pass">Preencher a senha salva do Windows</button>';
    if (h.band === '5' && !working && (same || !typed)) {
      host += `<p class="warn">Este computador está em <b>5 GHz</b>${h.channel ? ` (canal ${h.channel})` : ''}, e o EchoMap só conecta em <b>2,4 GHz</b>. Funciona se o roteador usa o mesmo nome nas duas faixas; se a rede 2,4 GHz tiver outro nome (muitas vezes sem o "5G"), use esse.</p>`;
    }
    if (h.uncertain && same) host += '<p class="warn">Confira o nome da rede: ele tem acento e pode ter vindo com letras trocadas.</p>';
  }
  setHTML($('#wfHost'), host ? `<div class="host-row">${host}</div>` : '');

  $('#wfBtn').disabled = st.wifiTest === 'running';
  $('#wfBtn').textContent = st.wifiTest === 'running' ? 'Testando a rede…' : 'Conectar a esta rede';
  $('#wfHint').textContent = channel === 'usb'
    ? 'A rede vai pelo cabo USB. O EchoMap testa antes de salvar e mostra aqui, na hora, se a senha estiver errada ou se a rede não for encontrada. Use uma rede de 2,4 GHz.'
    : 'O EchoMap testa a rede nova antes de trocar: se não conectar em 20 s, continua na atual e mostra o motivo aqui. Use uma rede de 2,4 GHz.';

  const logs = state.logs.get(d?.id ?? usbId) ?? [];
  $('#wfLogWrap').hidden = channel !== 'usb' || !logs.length;
  setHTML($('#wfLog'), logs.map((l) => `<li><span>${esc(fmtTime(l.ts))}</span> ${esc(l.line)}</li>`).join(''));
  setHTML($('#wfPhoneBody'), phoneSteps(ap, pw));
};

/* ================================================================ roteador */
const view = { name: null, impl: null };
const ROUTES = { '': 'inicio', 'ao-vivo': 'ao-vivo', ocorrencias: 'ocorrencias', alerta: 'alerta', mapa: 'mapa', movimento: 'movimento', dispositivo: 'dispositivo' };

function route() {
  const [, seg = '', arg] = location.hash.replace(/^#/, '').split('/');
  const name = ROUTES[seg] ?? 'inicio';
  view.impl?.unmount?.();
  view.name = name;
  view.impl = views[name];
  const el = $('#view');
  el.innerHTML = view.impl.mount(arg);
  document.querySelectorAll('#nav a').forEach((a) => {
    const active = a.dataset.route === name || (name === 'alerta' && a.dataset.route === 'ocorrencias');
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  view.impl.after?.(arg);
  view.impl.refresh();
  renderChrome();
}

let refreshPending = false;
function scheduleRefresh() {
  if (refreshPending) return;
  refreshPending = true;
  requestAnimationFrame(() => setTimeout(() => {
    refreshPending = false;
    view.impl?.refresh();
  }, 80));
}

window.addEventListener('hashchange', () => { route(); $('#view').focus({ preventScroll: true }); window.scrollTo(0, 0); });
window.addEventListener('resize', () => view.impl?.refresh());
/* atualiza "há X s", rola os gráficos sem dados novos e revela o "sem sinal" */
setInterval(() => { renderChrome(); view.impl?.refresh(); }, 1000);

/* ---------------- tema ---------------- */
function currentTheme() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
function themeLabel() { return currentTheme() === 'dark' ? 'Tema claro' : 'Tema escuro'; }
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === 'dark' ? '#0e1514' : '#f3f5f4';
  $('#themeBtn').textContent = themeLabel();
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  store.set('echomap.theme', next);
  applyTheme(next);
  route();
}
applyTheme(store.get('echomap.theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#themeBtn').addEventListener('click', toggleTheme);

route();
connectWs();
