/* Áreas de alta colisão (collision_hotspots): cada quase colisão ou batida com posição de GPS
   entra numa célula geohash de precisão 8 e atualiza, numa transação, contagem, gravidade,
   distância média, lados e o risk_score. Essa tabela é a base do "Mapa de Acessibilidade Urbana"
   exportado em GeoJSON/CSV. */
import { encodeGeohash, decodeGeohash } from './geohash.js';

export const HOTSPOT_PRECISION = 8;
export const HOTSPOT_TYPES = new Set(['NEAR_MISS', 'IMPACT']);
export const GPS_WINDOW_MS = 5000; /* posição do GPS aceita até ±5 s da ocorrência */
const HALF_LIFE_DAYS = 30;

/* TTC crítico: impacto previsto em até 1 s, ou uma batida de verdade */
export const isCritical = (type, data) => type === 'IMPACT' || (data?.ttc != null && Number(data.ttc) <= 1.0);

/* risk_score de 0 a 100: frequência + severidade (TTC crítico vale 3×), mais alto quanto mais perto o
   obstáculo chega (distância média até 150 cm dobra o peso) e caindo pela metade a cada 30 dias sem
   ocorrência nova (o ponto continua no mapa, só pesa menos). */
export function riskScore({ eventCount, criticalTtcCount = 0, avgMinDistanceCm = null, lastSeen }, now = Date.now()) {
  if (!eventCount) return 0;
  const proximity = avgMinDistanceCm == null ? 1 : 1 + Math.max(0, 1 - Math.min(Math.max(avgMinDistanceCm, 0), 150) / 150);
  const ageDays = Math.max(0, (now - lastSeen) / 86400000);
  const recency = 0.25 + 0.75 * 0.5 ** (ageDays / HALF_LIFE_DAYS);
  const raw = (eventCount + 2 * criticalTtcCount) * proximity * recency;
  return Math.round(1000 * (1 - Math.exp(-raw / 8))) / 10;
}

const rowToHotspot = (r, now) => {
  const h = {
    cellId: r.cell_id,
    centerLat: Number(r.center_lat),
    centerLng: Number(r.center_lng),
    eventCount: Number(r.event_count),
    criticalTtcCount: Number(r.critical_ttc_count),
    avgMinDistanceCm: r.avg_min_distance_cm == null ? null : Math.round(Number(r.avg_min_distance_cm) * 10) / 10,
    leftHits: Number(r.left_hits),
    rightHits: Number(r.right_hits),
    firstSeen: Number(r.first_seen),
    lastSeen: Number(r.last_seen),
    label: r.label ?? null,
  };
  h.riskScore = riskScore(h, now); /* recalculado na consulta: a recência muda com o tempo */
  return h;
};

export function createHotspots(db) {
  const raw = db.raw;
  const q = {
    get: raw.prepare('SELECT * FROM collision_hotspots WHERE cell_id = ?'),
    upsert: raw.prepare(`INSERT INTO collision_hotspots(cell_id, center_lat, center_lng, event_count, critical_ttc_count,
        avg_min_distance_cm, distance_samples, left_hits, right_hits, risk_score, first_seen, last_seen)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(cell_id) DO UPDATE SET
        event_count = event_count + 1,
        critical_ttc_count = critical_ttc_count + excluded.critical_ttc_count,
        avg_min_distance_cm = CASE WHEN excluded.avg_min_distance_cm IS NULL THEN avg_min_distance_cm
          ELSE (COALESCE(avg_min_distance_cm, 0) * distance_samples + excluded.avg_min_distance_cm) / (distance_samples + 1) END,
        distance_samples = distance_samples + excluded.distance_samples,
        left_hits = left_hits + excluded.left_hits,
        right_hits = right_hits + excluded.right_hits,
        first_seen = MIN(first_seen, excluded.first_seen),
        last_seen = MAX(last_seen, excluded.last_seen)`),
    setScore: raw.prepare('UPDATE collision_hotspots SET risk_score = ? WHERE cell_id = ?'),
    all: raw.prepare('SELECT * FROM collision_hotspots WHERE last_seen >= ? AND first_seen <= ?'),
    count: raw.prepare('SELECT COUNT(*) AS n FROM collision_hotspots'),
  };

  /* uma ocorrência com posição -> célula atualizada de forma atômica (contagens + score) */
  function record({ lat, lon, ts, type, data = {} }) {
    if (!HOTSPOT_TYPES.has(type)) return null;
    const cell = encodeGeohash(lat, lon, HOTSPOT_PRECISION);
    const c = decodeGeohash(cell);
    const dist = type === 'NEAR_MISS' && Number.isFinite(Number(data.value)) && Number(data.value) > 0 ? Number(data.value) : null;
    raw.exec('BEGIN IMMEDIATE');
    try {
      q.upsert.run(cell, c.lat, c.lon, isCritical(type, data) ? 1 : 0, dist, dist == null ? 0 : 1,
        data.side === 'L' ? 1 : 0, data.side === 'R' ? 1 : 0, ts, ts);
      const h = rowToHotspot(q.get.get(cell), ts);
      q.setScore.run(h.riskScore, cell);
      raw.exec('COMMIT');
      return h;
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  }

  /* pontos críticos ordenados por risco (recalculado agora) */
  function list({ minScore = 0, from = 0, to = Date.now(), limit = 500, now = Date.now() } = {}) {
    return q.all.all(from, to).map((r) => rowToHotspot(r, now))
      .filter((h) => h.riskScore >= minScore)
      .sort((a, b) => b.riskScore - a.riskScore || b.eventCount - a.eventCount)
      .slice(0, limit);
  }

  const count = () => Number(q.count.get().n);
  return { record, list, count };
}

/* posição da ocorrência: a do próprio evento, ou a do GPS mais próxima no tempo (±5 s) */
export function positionOf(db, evt) {
  const d = evt.data ?? {};
  const lat = Number(d.lat), lon = Number(d.lon ?? d.lng);
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) return { lat, lon };
  const loc = db.nearestLocation(evt.deviceId, evt.ts, GPS_WINDOW_MS);
  return loc?.lat != null && loc?.lon != null ? { lat: Number(loc.lat), lon: Number(loc.lon) } : null;
}

/* liga o serviço ao hub: cada NEAR_MISS/IMPACT novo entra na célula. Se o GPS daquele instante
   ainda não chegou (ele vem 1×/s), tenta de novo depois da janela de 5 s. Na primeira vez,
   monta a tabela a partir das ocorrências já gravadas (sem apagar nada). */
export function attachHotspots({ hub, db, onUpdate = () => {}, retryMs = GPS_WINDOW_MS + 1000 }) {
  const store = createHotspots(db);
  const tryRecord = (e, retry) => {
    const pos = positionOf(db, e);
    if (pos) { onUpdate(store.record({ ...pos, ts: e.ts, type: e.type, data: e.data })); return; }
    if (retry) setTimeout(() => tryRecord(e, false), retryMs).unref?.();
  };
  hub.on('event', (e) => { if (HOTSPOT_TYPES.has(e.type)) tryRecord(e, true); });

  if (store.count() === 0) {
    let n = 0;
    for (const e of db.eventsInRange({ types: [...HOTSPOT_TYPES], from: 0, to: Date.now() })) {
      const pos = positionOf(db, e);
      if (pos) { store.record({ ...pos, ts: e.ts, type: e.type, data: e.data }); n += 1; }
    }
    if (n) console.log(`[HOTSPOTS] ${n} ocorrências antigas agrupadas em ${store.count()} áreas.`);
  }
  return store;
}

/* ---------------- exportação: Mapa de Acessibilidade Urbana ---------------- */
const props = (h) => ({
  cell_id: h.cellId,
  risk_score: h.riskScore,
  event_count: h.eventCount,
  critical_ttc_count: h.criticalTtcCount,
  avg_min_distance_cm: h.avgMinDistanceCm,
  left_hits: h.leftHits,
  right_hits: h.rightHits,
  first_seen: new Date(h.firstSeen).toISOString(),
  last_seen: new Date(h.lastSeen).toISOString(),
  label: h.label,
});

export function toGeoJSON(list) {
  return {
    type: 'FeatureCollection',
    name: 'echomap_barreiras',
    features: list.map((h) => ({
      type: 'Feature',
      id: h.cellId,
      geometry: { type: 'Point', coordinates: [Number(h.centerLng.toFixed(7)), Number(h.centerLat.toFixed(7))] },
      properties: props(h),
    })),
  };
}

const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCSV(list) {
  const cols = ['cell_id', 'lat', 'lng', 'risk_score', 'event_count', 'critical_ttc_count', 'avg_min_distance_cm', 'left_hits', 'right_hits', 'first_seen', 'last_seen', 'label'];
  const rows = list.map((h) => {
    const p = props(h);
    return [p.cell_id, h.centerLat.toFixed(7), h.centerLng.toFixed(7), p.risk_score, p.event_count, p.critical_ttc_count,
      p.avg_min_distance_cm, p.left_hits, p.right_hits, p.first_seen, p.last_seen, p.label].map(csvCell).join(',');
  });
  return `${cols.join(',')}\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}
