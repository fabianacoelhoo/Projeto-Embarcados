/* EchoMap - dashboard dos responsaveis (sem framework, sem build) */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem storage */ } },
};

const state = {
  devices: new Map(),
  selected: store.get('echomap.device'),
  events: [],
  series: new Map(), /* deviceId -> [{ts, distL, distR, thr}] */
  track: new Map(), /* deviceId -> [[lat, lon]] */
  config: { thresholds: { nearMissCm: 30 }, safeZones: [] },
  windowMs: 60000,
  eventFilter: 'pending',
  showTable: false,
  wsOnline: false,
};

const SERIES_MAX_MS = 30 * 60000;

/* ---------------- textos ---------------- */
const EVENT_LABEL = {
  NEAR_MISS: 'Quase colisão',
  CRASH: 'Colisão registrada',
  SOS: 'Pedido de ajuda',
  FALL: 'Queda detectada',
  IMPACT: 'Impacto detectado',
  GEOFENCE_EXIT: 'Saiu da zona segura',
  GEOFENCE_ENTER: 'Entrou na zona segura',
  LOW_BATTERY: 'Bateria baixa',
  DEVICE_OFFLINE: 'Dispositivo sem sinal',
  DEVICE_ONLINE: 'Dispositivo voltou a responder',
};
const SEV_ICON = { critical: '!', serious: '!', warning: '!', info: 'i', good: '✓' };
const SEV_LABEL = { critical: 'Crítico', serious: 'Grave', warning: 'Atenção', info: 'Info', good: 'OK' };
const SIDE = { L: 'lado esquerdo', R: 'lado direito' };
const MODE_LABEL = { RADAR: 'Radar', SIM360: 'Varredura 360°', SELFTEST: 'Autoteste' };

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('pt-BR');
const fmtCm = (v) => (v == null ? '—' : Math.round(v).toString());
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
const deviceName = (d) => (d ? d.name || d.id : '—');

function eventDetail(e) {
  const d = e.data ?? {};
  const parts = [];
  if (d.side) parts.push(SIDE[d.side] ?? d.side);
  if (d.value != null) parts.push(`${d.value}${d.unit ? ` ${d.unit}` : ' cm'}`);
  if (d.zone) parts.push(d.zone);
  if (e.type === 'CRASH') parts.push('botão pressionado por tempo longo');
  if (d.detectedBy === 'server') parts.push('detectado pelo servidor');
  return parts.join(' · ');
}

/* ---------------- classificação de proximidade ---------------- */
function proximityStatus(dist, thr) {
  const near = state.config.thresholds.nearMissCm;
  if (dist == null) return { sev: 'good', text: 'Livre' };
  if (dist < near) return { sev: 'critical', text: 'Muito perto' };
  if (thr != null && dist <= thr) return { sev: 'warning', text: 'Dentro do limiar' };
  return { sev: 'good', text: 'Livre' };
}
const sevColor = (sev) => `var(--${sev === 'info' ? 'muted' : sev})`;
const sevBadge = (sev) => `<span class="sev-icon sev-${sev}" aria-hidden="true">${SEV_ICON[sev]}</span>`;

/* ---------------- dados ---------------- */
async function loadState() {
  const res = await fetch('/api/state');
  const data = await res.json();
  state.config = data.config;
  state.events = data.events;
  state.devices = new Map(data.devices.map((d) => [d.id, d]));
  if (!state.devices.has(state.selected)) {
    const online = data.devices.find((d) => d.online);
    state.selected = (online ?? data.devices[0])?.id ?? null;
  }
  await loadHistory();
  renderAll();
}

async function loadHistory() {
  const id = state.selected;
  if (!id) return;
  const [prox, loc] = await Promise.all([
    fetch(`/api/devices/${encodeURIComponent(id)}/readings?kind=proximity&minutes=30`).then((r) => r.json()),
    fetch(`/api/devices/${encodeURIComponent(id)}/readings?kind=location&minutes=180`).then((r) => r.json()),
  ]);
  const live = state.series.get(id) ?? [];
  const firstLive = live[0]?.ts ?? Infinity;
  const hist = prox.filter((p) => p.ts < firstLive).map((p) => ({ ts: p.ts, distL: p.distL, distR: p.distR, thr: p.thr }));
  state.series.set(id, [...hist, ...live]);
  state.track.set(id, loc.filter((p) => p.lat != null).map((p) => [p.lat, p.lon]));
}

function onReading(msg) {
  let d = state.devices.get(msg.deviceId);
  if (!d) {
    d = { id: msg.deviceId, name: null, online: true, lastSeen: msg.ts, latest: {} };
    state.devices.set(d.id, d);
    renderDeviceSelect();
  }
  d.lastSeen = msg.ts;
  d.latest[msg.kind] = { ts: msg.ts, ...msg.data };
  if (!state.selected) { state.selected = d.id; renderAll(); }

  if (msg.kind === 'proximity') {
    const arr = state.series.get(msg.deviceId) ?? [];
    arr.push({ ts: msg.ts, distL: msg.data.distL, distR: msg.data.distR, thr: msg.data.thr });
    while (arr.length && arr[0].ts < msg.ts - SERIES_MAX_MS) arr.shift();
    state.series.set(msg.deviceId, arr);
  }
  if (msg.kind === 'location' && msg.data.lat != null) {
    const tr = state.track.get(msg.deviceId) ?? [];
    tr.push([msg.data.lat, msg.data.lon]);
    if (tr.length > 500) tr.shift();
    state.track.set(msg.deviceId, tr);
  }
  if (msg.deviceId === state.selected) scheduleRender(msg.kind);
}

function onEvent(evt, isNew) {
  const i = state.events.findIndex((e) => e.id === evt.id);
  if (i >= 0) state.events[i] = evt; else state.events.unshift(evt);
  state.events = state.events.slice(0, 300);
  if (isNew && (evt.severity === 'critical' || evt.severity === 'serious')) notify(evt);
  renderEvents();
  renderBanner();
  renderMotion();
}

/* ---------------- WebSocket ---------------- */
function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { state.wsOnline = true; renderPills(); loadState().catch(console.error); };
  ws.onclose = () => { state.wsOnline = false; renderPills(); setTimeout(connectWs, 2000); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'reading') onReading(msg);
    else if (msg.type === 'event') onEvent(msg.event, true);
    else if (msg.type === 'eventUpdated') onEvent(msg.event, false);
    else if (msg.type === 'device') {
      const prev = state.devices.get(msg.device.id);
      state.devices.set(msg.device.id, { ...prev, ...msg.device, latest: { ...prev?.latest, ...msg.device.latest } });
      if (!state.selected) state.selected = msg.device.id;
      renderDeviceSelect();
      renderPills();
    }
  };
}

/* ---------------- render agendado ---------------- */
const dirty = new Set();
let rafPending = false;
function scheduleRender(kind) {
  dirty.add(kind);
  if (rafPending) return;
  rafPending = true;
  setTimeout(() => requestAnimationFrame(() => {
    rafPending = false;
    if (dirty.has('proximity')) { renderNow(); renderChart(); }
    if (dirty.has('location')) renderMap();
    if (dirty.has('imu') || dirty.has('status')) renderMotion();
    dirty.clear();
  }), 150);
}

function renderAll() {
  renderDeviceSelect();
  renderPills();
  renderNow();
  renderChart();
  renderEvents();
  renderBanner();
  renderMap();
  renderMotion();
}

const current = () => state.devices.get(state.selected);

/* ---------------- topo ---------------- */
function renderDeviceSelect() {
  const sel = $('#deviceSelect');
  const opts = [...state.devices.values()].map((d) =>
    `<option value="${esc(d.id)}" ${d.id === state.selected ? 'selected' : ''}>${esc(deviceName(d))}${d.name ? ` (${esc(d.id)})` : ''}</option>`);
  sel.innerHTML = opts.length ? opts.join('') : '<option>Nenhum dispositivo ainda</option>';
  sel.disabled = !opts.length;
  $('#renameBtn').disabled = !opts.length;
}

function renderPills() {
  const d = current();
  const dp = $('#devicePill');
  dp.className = `pill ${d ? (d.online ? 'ok' : 'bad') : ''}`;
  dp.querySelector('.pill-text').textContent = d
    ? (d.online ? `Online · ${d.source === 'serial' ? 'USB' : 'Wi-Fi'}` : `Sem sinal · visto ${fmtAgo(d.lastSeen)}`)
    : 'Sem dispositivo';
  const lp = $('#linkPill');
  lp.className = `pill ${state.wsOnline ? 'ok' : 'bad'}`;
  lp.querySelector('.pill-text').textContent = state.wsOnline ? 'Servidor conectado' : 'Servidor desconectado';
}

/* ---------------- situação atual ---------------- */
function renderNow() {
  const d = current();
  const p = d?.latest?.proximity;
  $('#modeChip').textContent = p?.mode ? (MODE_LABEL[p.mode] ?? p.mode) : '—';
  renderFigure(p);
  renderSideTile('#tileL', 'Esquerda', 'var(--series-l)', p?.distL, p?.bzL, p?.thr, p);
  renderSideTile('#tileR', 'Direita', 'var(--series-r)', p?.distR, p?.bzR, p?.thr, p);

  $('#tileThr').innerHTML = `
    <div class="label">Limiar de alerta</div>
    <div class="value">${p?.thr != null ? Math.round(p.thr) : '—'}<small>cm</small></div>
    <div class="meter-label">ajustado no potenciômetro${p?.pot != null ? ` (${Math.round(p.pot * 100)}%)` : ''}</div>`;

  const status = d?.latest?.status;
  $('#tileDevice').innerHTML = `
    <div class="label">Última leitura</div>
    <div class="value">${p ? fmtTime(p.ts) : '—'}</div>
    <div class="meter-label">${status?.battery != null ? `bateria ${status.battery}%` : 'bateria: sem sensor'}</div>`;
}

function renderSideTile(sel, label, color, dist, bz, thr, p) {
  const st = proximityStatus(dist, thr);
  const vol = bz != null ? Math.round(bz * 100) : null;
  $(sel).innerHTML = `
    <div class="label"><i class="sw" style="background:${color}"></i>${label}</div>
    <div class="value">${p ? fmtCm(dist) : '—'}<small>${dist != null ? 'cm' : ''}</small></div>
    <span class="status">${p ? `${sevBadge(st.sev)}${dist == null ? 'Nada detectado' : st.text}` : 'Aguardando dados'}</span>
    <div class="meter" title="Volume do buzzer"><i style="width:${vol ?? 0}%;background:${color}"></i></div>
    <div class="meter-label">buzzer ${vol != null ? `${vol}%` : '—'}</div>`;
}

function niceMax(v) {
  const steps = [50, 100, 150, 200, 250, 300, 400];
  return steps.find((s) => s >= v) ?? 400;
}

function renderFigure(p) {
  /* desenha na largura real do card: o texto mantém o tamanho legível no celular */
  const W = Math.max(300, Math.round($('#figure').clientWidth || 640));
  const H = 130, cx = W / 2, cy = 72, personR = 24, laneH = 40;
  const thr = p?.thr ?? null;
  const near = state.config.thresholds.nearMissCm;
  const maxCm = niceMax(Math.max((thr ?? 100) * 1.2, 120));
  const lanePx = cx - personR - 16;
  const px = lanePx / maxCm;

  const lane = (dir, dist, bz, color) => {
    const sign = dir === 'L' ? -1 : 1;
    const x0 = cx + sign * (personR + 4);
    const xAt = (cm) => x0 + sign * cm * px;
    const rect = (a, b, y, h, fill, extra = '') => `<rect x="${Math.min(a, b)}" y="${y}" width="${Math.abs(b - a)}" height="${h}" fill="${fill}" ${extra}/>`;
    let s = rect(x0, xAt(maxCm), cy - laneH / 2, laneH, 'var(--surface-2)', 'rx="6"');
    s += rect(x0, xAt(near), cy - laneH / 2, laneH, 'var(--critical-wash)');
    if (thr != null) {
      const xt = xAt(Math.min(thr, maxCm));
      s += `<line x1="${xt}" x2="${xt}" y1="${cy - laneH / 2 - 6}" y2="${cy + laneH / 2 + 6}" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    }
    const tick = lanePx < 180 ? (maxCm <= 200 ? 100 : 200) : (maxCm <= 200 ? 50 : 100);
    for (let cm = 0; cm <= maxCm; cm += tick) {
      const x = xAt(cm);
      s += `<text x="${x}" y="${cy + laneH / 2 + 18}" text-anchor="middle" font-size="11" fill="var(--muted)">${cm}</text>`;
    }
    if (dist != null && p) {
      const st = proximityStatus(dist, thr);
      const x = xAt(Math.min(dist, maxCm));
      s += `<line x1="${x0}" x2="${x}" y1="${cy}" y2="${cy}" stroke="${color}" stroke-width="2" stroke-dasharray="2 4" opacity=".6"/>`;
      s += `<rect x="${x - 5}" y="${cy - laneH / 2 + 4}" width="10" height="${laneH - 8}" rx="4" fill="${sevColor(st.sev)}" stroke="var(--surface)" stroke-width="2"/>`;
      /* rótulo preso dentro da figura, sem invadir a pessoa no centro */
      const lx = Math.min(Math.max(x, 30), W - 30);
      s += `<text x="${lx}" y="${cy - laneH / 2 - 10}" text-anchor="middle" font-size="13" font-weight="650" fill="var(--ink)">${Math.round(dist)} cm</text>`;
    } else if (p) {
      s += `<text x="${(x0 + xAt(maxCm)) / 2}" y="${cy + 4}" text-anchor="middle" font-size="12" fill="var(--muted)">nada detectado</text>`;
    }
    /* ondas do buzzer: quanto mais alto, mais arcos */
    const waves = bz ? Math.ceil(bz * 3) : 0;
    for (let i = 1; i <= waves; i++) {
      const r = personR + 2 + i * 5;
      const a = Math.PI / 5;
      const xA = cx + sign * r * Math.cos(a), yA = cy - r * Math.sin(a), yB = cy + r * Math.sin(a);
      s += `<path d="M${xA} ${yA} A${r} ${r} 0 0 ${dir === 'L' ? 0 : 1} ${xA} ${yB}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" opacity="${1 - i * 0.2}"/>`;
    }
    return s;
  };

  $('#figure').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distância dos obstáculos à esquerda e à direita">
      ${lane('L', p?.distL ?? null, p?.bzL ?? 0, 'var(--series-l)')}
      ${lane('R', p?.distR ?? null, p?.bzR ?? 0, 'var(--series-r)')}
      <circle cx="${cx}" cy="${cy}" r="${personR}" fill="var(--surface)" stroke="var(--ink-2)" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy - 7}" r="6" fill="var(--ink-2)"/>
      <path d="M${cx - 11} ${cy + 15} Q${cx} ${cy - 4} ${cx + 11} ${cy + 15}" fill="var(--ink-2)"/>
    </svg>
    <div class="figure-legend">
      <span><i class="sw sw-l"></i>Esquerda</span>
      <span><i class="sw sw-r"></i>Direita</span>
      <span><i class="sw sw-thr"></i>Limiar${thr != null ? ` (${Math.round(thr)} cm)` : ''}</span>
      <span><i class="sw sw-near"></i>Quase colisão (&lt; ${near} cm)</span>
    </div>`;
}

/* ---------------- gráfico ---------------- */
let hoverX = null;
let chartGeom = null;

function renderChart() {
  const el = $('#chart');
  const W = el.clientWidth || 600, H = el.clientHeight || 260;
  const m = { l: 40, r: 70, t: 14, b: 26 };
  const now = Date.now();
  const t0 = now - state.windowMs;
  const all = state.series.get(state.selected) ?? [];
  const pts = all.filter((p) => p.ts >= t0 - 2000);
  const near = state.config.thresholds.nearMissCm;

  let maxV = 0;
  for (const p of pts) maxV = Math.max(maxV, p.distL ?? 0, p.distR ?? 0, p.thr ?? 0);
  const yMax = niceMax(Math.max(maxV * 1.08, 60));
  const x = (ts) => m.l + ((ts - t0) / state.windowMs) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - v / yMax) * (H - m.t - m.b);
  chartGeom = { x, y, t0, W, H, m, pts };

  let s = '';
  /* faixa de quase colisão */
  s += `<rect x="${m.l}" y="${y(near)}" width="${W - m.l - m.r}" height="${y(0) - y(near)}" fill="var(--critical-wash)"/>`;
  /* grade */
  const step = yMax <= 100 ? 25 : yMax <= 200 ? 50 : 100;
  for (let v = 0; v <= yMax; v += step) {
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/>`;
    s += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  s += `<text x="${m.l - 8}" y="${m.t - 2}" text-anchor="end">cm</text>`;
  const tickEvery = state.windowMs <= 60000 ? 10000 : state.windowMs <= 300000 ? 60000 : 300000;
  for (let ts = Math.ceil(t0 / tickEvery) * tickEvery; ts <= now; ts += tickEvery) {
    const secs = Math.round((now - ts) / 1000);
    const label = secs === 0 ? 'agora' : secs < 60 ? `-${secs}s` : `-${Math.round(secs / 60)}min`;
    s += `<text x="${x(ts)}" y="${H - 6}" text-anchor="middle">${label}</text>`;
  }

  /* limiar (escada, pois muda com o potenciômetro) */
  const thrPath = pathFor(pts, 'thr', x, y, true);
  if (thrPath) s += `<path d="${thrPath}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5 4"/>`;

  for (const [key, color] of [['distL', 'var(--series-l)'], ['distR', 'var(--series-r)']]) {
    const d = pathFor(pts, key, x, y, false);
    if (d) s += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  /* rótulos diretos no fim das linhas */
  const last = [...pts].reverse();
  const labels = [];
  for (const [key, name, color] of [['distL', 'Esq.', 'var(--series-l)'], ['distR', 'Dir.', 'var(--series-r)']]) {
    const p = last.find((q) => q[key] != null);
    if (p && now - p.ts < 5000) labels.push({ y: y(p[key]), text: `${name} ${Math.round(p[key])}`, color, cx: x(p.ts) });
  }
  if (labels.length === 2 && Math.abs(labels[0].y - labels[1].y) < 14) {
    const mid = (labels[0].y + labels[1].y) / 2;
    const up = labels[0].y <= labels[1].y ? 0 : 1;
    labels[up].y = mid - 8; labels[1 - up].y = mid + 8;
  }
  for (const l of labels) {
    s += `<text x="${W - m.r + 8}" y="${l.y + 4}" style="fill:var(--ink-2);font-size:12px">${l.text}</text>`;
    s += `<rect x="${W - m.r + 2}" y="${l.y - 1}" width="4" height="3" rx="1" fill="${l.color}"/>`;
  }

  if (!pts.length) {
    s += `<text x="${(W - m.r + m.l) / 2}" y="${H / 2}" text-anchor="middle" style="font-size:13px">Sem leituras nesta janela</text>`;
  }

  s += '<g id="hoverLayer"></g>';
  s += `<rect id="hitArea" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Gráfico de distância esquerda e direita ao longo do tempo">${s}</svg>`;

  const hit = $('#hitArea');
  hit.addEventListener('mousemove', (e) => {
    const box = el.getBoundingClientRect();
    hoverX = ((e.clientX - box.left) / box.width) * W;
    drawHover();
  });
  hit.addEventListener('mouseleave', () => { hoverX = null; drawHover(); });
  drawHover();
  if (state.showTable) renderTable(pts);
}

function pathFor(pts, key, x, y, stepped) {
  let d = '';
  let pen = false;
  let prev = null;
  for (const p of pts) {
    const v = p[key];
    /* quebra a linha quando o sensor nao detectou nada ou houve lacuna grande */
    if (v == null || (prev && p.ts - prev.ts > 3000)) { pen = false; if (v == null) { prev = p; continue; } }
    const X = x(p.ts).toFixed(1), Y = y(v).toFixed(1);
    if (!pen) d += `M${X} ${Y}`;
    else d += stepped ? `H${X}V${Y}` : `L${X} ${Y}`;
    pen = true;
    prev = p;
  }
  return d;
}

function drawHover() {
  const layer = $('#hoverLayer');
  const tip = $('#chartTip');
  if (!layer || !chartGeom) return;
  const { x, y, pts, m, H, W } = chartGeom;
  if (hoverX == null || !pts.length) { layer.innerHTML = ''; tip.hidden = true; return; }

  /* ponto mais próximo do cursor */
  let best = null, bestD = Infinity;
  for (const p of pts) {
    const dd = Math.abs(x(p.ts) - hoverX);
    if (dd < bestD) { bestD = dd; best = p; }
  }
  if (!best || bestD > 40) { layer.innerHTML = ''; tip.hidden = true; return; }
  const X = x(best.ts);
  let s = `<line x1="${X}" x2="${X}" y1="${m.t}" y2="${H - m.b}" stroke="var(--axis)" stroke-width="1"/>`;
  for (const [key, color] of [['distL', 'var(--series-l)'], ['distR', 'var(--series-r)']]) {
    if (best[key] != null) s += `<circle cx="${X}" cy="${y(best[key])}" r="4.5" fill="${color}" stroke="var(--surface)" stroke-width="2"/>`;
  }
  layer.innerHTML = s;

  const row = (name, color, v, unit = 'cm') => `<div class="row"><span><i class="sw" style="background:${color}"></i>${name}</span><b>${v == null ? '—' : `${Math.round(v)} ${unit}`}</b></div>`;
  tip.innerHTML = `<div class="t">${fmtTime(best.ts)}</div>
    ${row('Esquerda', 'var(--series-l)', best.distL)}
    ${row('Direita', 'var(--series-r)', best.distR)}
    ${row('Limiar', 'var(--muted)', best.thr)}`;
  tip.hidden = false;
  const chartEl = $('#chart');
  const left = chartEl.offsetLeft + X + 14;
  const flip = X > W - 180;
  tip.style.left = `${flip ? left - tip.offsetWidth - 28 : left}px`;
  tip.style.top = `${chartEl.offsetTop + 8}px`;
}

function renderTable(pts) {
  const rows = pts.slice(-30).reverse().map((p) =>
    `<tr><td>${fmtTime(p.ts)}</td><td>${fmtCm(p.distL)}</td><td>${fmtCm(p.distR)}</td><td>${fmtCm(p.thr)}</td></tr>`).join('');
  $('#chartTable').innerHTML = `<table><thead><tr><th>Hora</th><th>Esquerda (cm)</th><th>Direita (cm)</th><th>Limiar (cm)</th></tr></thead><tbody>${rows || '<tr><td colspan="4">Sem dados</td></tr>'}</tbody></table>`;
}

/* ---------------- eventos ---------------- */
function visibleEvents() {
  return state.events.filter((e) => e.deviceId === state.selected
    && (state.eventFilter === 'all' || (!e.ackedAt && e.type !== 'DEVICE_ONLINE')));
}

function renderEvents() {
  const list = visibleEvents().slice(0, 100);
  $('#eventList').innerHTML = list.length ? list.map((e) => `
    <li class="${e.ackedAt ? 'acked' : ''}">
      ${sevBadge(e.severity)}
      <div class="body">
        <div class="title">${esc(EVENT_LABEL[e.type] ?? e.type)} <span class="muted">· ${SEV_LABEL[e.severity] ?? ''}</span></div>
        <div class="detail">${esc(eventDetail(e)) || '&nbsp;'}</div>
      </div>
      <div style="text-align:right">
        <div class="when" title="${new Date(e.ts).toLocaleString('pt-BR')}">${fmtAgo(e.ts)}</div>
        ${e.ackedAt ? '' : `<button class="ghost" data-ack="${e.id}">Ciente</button>`}
      </div>
    </li>`).join('')
    : `<li class="empty">${state.eventFilter === 'pending' ? 'Nenhuma ocorrência pendente' : 'Nenhuma ocorrência registrada'}</li>`;
}

function renderBanner() {
  const b = $('#alertBanner');
  const evt = state.events.find((e) => !e.ackedAt && e.severity === 'critical' && e.deviceId === state.selected);
  if (!evt) { b.hidden = true; return; }
  const pending = state.events.filter((e) => !e.ackedAt && e.severity === 'critical' && e.deviceId === state.selected).length;
  b.hidden = false;
  b.innerHTML = `${sevBadge('critical')}
    <strong>${esc(EVENT_LABEL[evt.type] ?? evt.type)}</strong>
    <span class="grow">${esc(deviceName(current()))} · ${fmtTime(evt.ts)} (${fmtAgo(evt.ts)})${eventDetail(evt) ? ` · ${esc(eventDetail(evt))}` : ''}${pending > 1 ? ` · +${pending - 1} pendente(s)` : ''}</span>
    <button data-ack="${evt.id}">Estou ciente</button>`;
}

async function ack(id) {
  const res = await fetch(`/api/events/${id}/ack`, { method: 'POST' });
  if (res.ok) onEvent(await res.json(), false);
}

/* ---------------- mapa ---------------- */
let map = null, marker = null, accCircle = null, trail = null, zonesLayer = null;
function ensureMap() {
  if (map || typeof L === 'undefined') return map;
  map = L.map('map', { zoomControl: true, attributionControl: true }).setView([-15.8, -47.9], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  zonesLayer = L.layerGroup().addTo(map);
  for (const z of state.config.safeZones ?? []) {
    L.circle([z.lat, z.lon], { radius: z.radiusM, color: '#0ca30c', weight: 2, fillOpacity: 0.08 })
      .bindTooltip(`Zona segura: ${z.name}`).addTo(zonesLayer);
  }
  trail = L.polyline([], { color: '#2a78d6', weight: 2, opacity: 0.7 }).addTo(map);
  return map;
}

function renderMap() {
  ensureMap();
  const loc = current()?.latest?.location;
  const has = loc && loc.lat != null;
  $('#mapEmpty').hidden = !!has;
  $('#locMeta').textContent = has ? `${fmtAgo(loc.ts)}${loc.accuracyM != null ? ` · precisão ±${loc.accuracyM} m` : ''}` : 'sem GPS';
  if (!map || !has) return;
  const ll = [loc.lat, loc.lon];
  if (!marker) {
    marker = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 2, fillColor: '#2a78d6', fillOpacity: 1 }).addTo(map);
    accCircle = L.circle(ll, { radius: loc.accuracyM ?? 10, color: '#2a78d6', weight: 1, fillOpacity: 0.1 }).addTo(map);
    map.setView(ll, 17);
  }
  marker.setLatLng(ll);
  accCircle.setLatLng(ll).setRadius(loc.accuracyM ?? 10);
  trail.setLatLngs(state.track.get(state.selected) ?? []);
  if (!map.getBounds().pad(-0.1).contains(ll)) map.panTo(ll);
}

/* ---------------- movimento / bateria ---------------- */
function renderMotion() {
  const d = current();
  const imu = d?.latest?.imu;
  const st = d?.latest?.status;
  const lastOf = (types) => state.events.find((e) => e.deviceId === state.selected && types.includes(e.type));
  const fall = lastOf(['FALL']);
  const impact = lastOf(['IMPACT', 'CRASH']);
  const stat = (k, v, s) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  $('#motionStats').innerHTML = [
    stat('Aceleração', imu?.g != null ? `${imu.g.toFixed(2)} g` : '—', imu ? `atualizado ${fmtAgo(imu.ts)}` : 'acelerômetro ainda não instalado'),
    stat('Última queda', fall ? fmtAgo(fall.ts) : 'nenhuma', fall ? fmtTime(fall.ts) : 'evento FALL do firmware'),
    stat('Último impacto/colisão', impact ? fmtAgo(impact.ts) : 'nenhum', impact ? `${EVENT_LABEL[impact.type]} · ${fmtTime(impact.ts)}` : 'IMPACT ou CRASH'),
    stat('Bateria', st?.battery != null ? `${st.battery}%` : '—', st ? `sinal ${st.rssi ?? '—'} dBm` : 'publicar em echomap/<id>/status'),
  ].join('');
}

/* ---------------- notificações ---------------- */
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
    const d = state.devices.get(evt.deviceId);
    new Notification(`EchoMap: ${EVENT_LABEL[evt.type] ?? evt.type}`, { body: `${deviceName(d)} · ${eventDetail(evt)}`, tag: `evt-${evt.id}` });
  }
}

/* ---------------- interações ---------------- */
$('#deviceSelect').addEventListener('change', async (e) => {
  state.selected = e.target.value;
  store.set('echomap.device', state.selected);
  if (marker) { marker.remove(); accCircle.remove(); marker = null; }
  await loadHistory();
  renderAll();
});

$('#renameBtn').addEventListener('click', async () => {
  const d = current();
  if (!d) return;
  const name = prompt('Nome para este dispositivo (ex.: nome da criança):', d.name ?? '');
  if (name == null) return;
  await fetch(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
});

document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => {
  state.windowMs = Number(b.dataset.win);
  document.querySelectorAll('[data-win]').forEach((x) => x.classList.toggle('on', x === b));
  renderChart();
}));

document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
  state.eventFilter = b.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('on', x === b));
  renderEvents();
}));

$('#tableBtn').addEventListener('click', () => {
  state.showTable = !state.showTable;
  $('#chartTable').hidden = !state.showTable;
  $('#tableBtn').textContent = state.showTable ? 'Ocultar tabela' : 'Ver tabela';
  renderChart();
});

document.addEventListener('click', (e) => {
  const id = e.target.closest('[data-ack]')?.dataset.ack;
  if (id) ack(id);
});

$('#notifyBtn').addEventListener('click', async () => {
  beep(); /* libera o áudio no navegador */
  if ('Notification' in window && Notification.permission !== 'granted') await Notification.requestPermission();
  updateNotifyBtn();
});
function updateNotifyBtn() {
  const on = 'Notification' in window && Notification.permission === 'granted';
  $('#notifyBtn').textContent = on ? 'Alertas ativos' : 'Ativar alertas';
}

const savedTheme = store.get('echomap.theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('#themeBtn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  store.set('echomap.theme', document.documentElement.dataset.theme);
});

window.addEventListener('resize', () => { renderChart(); renderNow(); });
/* atualiza "há X s", rola o gráfico mesmo sem dados novos e revela o "sem sinal" */
setInterval(() => { renderPills(); renderChart(); renderEvents(); renderMotion(); }, 1000);

updateNotifyBtn();
connectWs();
