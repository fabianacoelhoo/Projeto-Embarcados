/* Mapa de calor de barreiras urbanas: onde as quase colisões acontecem.
   Cada ocorrência ganha uma posição (a que veio no evento, ou a leitura de GPS mais próxima no tempo,
   até toleranceMs antes ou depois) e um peso; ocorrências próximas (~5 m) somam no mesmo ponto. */

const SEVERITY_RANK = { info: 0, warning: 1, serious: 2, critical: 3 };
const SEVERITY_WEIGHT = { info: 0.5, warning: 1, serious: 1.3, critical: 1.6 };
const CELL_DEG = 0.00005; /* ~5,5 m de lado no Equador */

/* peso de uma ocorrência (0..~1,6): TTC menor pesa mais; "perto demais" pesa fixo; eventos antigos sem motivo pesam menos */
export function eventWeight(e) {
  const d = e.data ?? {};
  let w = 0.4;
  if (d.reason === 'ttc' && Number.isFinite(d.ttc)) w = 0.5 + 0.5 * Math.min(1, Math.max(0, (1.5 - d.ttc) / 1.5));
  else if (d.reason === 'close') w = 0.7;
  return w * (SEVERITY_WEIGHT[e.severity] ?? 1);
}

/* "2026-11-25", "2026-11-25T10:00:00-03:00" ou milissegundos */
export function parseTime(v, fallback) {
  if (v == null || v === '') return fallback;
  if (/^\d+$/.test(String(v))) return Number(v);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

export function computeHeatmap(db, { from, to, minSeverity = 'info', types = ['NEAR_MISS'], deviceId = null, toleranceMs = 5000 }) {
  const minRank = SEVERITY_RANK[minSeverity] ?? 0;
  const events = db.eventsInRange({ types, from, to, deviceId }).filter((e) => (SEVERITY_RANK[e.severity] ?? 0) >= minRank);
  const cells = new Map();
  let matched = 0, fromEvent = 0;
  for (const e of events) {
    const d = e.data ?? {};
    let lat = Number(d.lat), lon = Number(d.lon ?? d.lng);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      fromEvent += 1;
    } else {
      const loc = db.nearestLocation(e.deviceId, e.ts, toleranceMs);
      if (!loc || loc.lat == null || loc.lon == null) continue;
      lat = loc.lat;
      lon = loc.lon;
    }
    matched += 1;
    const key = `${Math.round(lat / CELL_DEG)}:${Math.round(lon / CELL_DEG)}`;
    const c = cells.get(key) ?? { lat: 0, lon: 0, n: 0, w: 0 };
    c.lat += lat;
    c.lon += lon;
    c.n += 1;
    c.w += eventWeight(e);
    cells.set(key, c);
  }
  const points = [...cells.values()].map((c) => [+(c.lat / c.n).toFixed(6), +(c.lon / c.n).toFixed(6), +c.w.toFixed(3)]);
  const max = points.reduce((m, p) => Math.max(m, p[2]), 0);
  return { from, to, minSeverity, types, total: events.length, matched, fromEvent, unmatched: events.length - matched, max, points };
}
