/* Áreas de alta colisão e exportação do Mapa de Acessibilidade Urbana. */
import { parseTime } from '../heatmap.js';
import { toCSV, toGeoJSON } from '../services/hotspots.js';

function query(req) {
  const to = parseTime(req.query.to, Date.now());
  const from = parseTime(req.query.from, 0);
  const minScore = req.query.min_score == null || req.query.min_score === '' ? 0 : Number(req.query.min_score);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 500) || 500, 1), 5000);
  if (from == null || to == null || from > to) return { error: 'Período inválido: use datas ISO (2026-11-25) ou milissegundos, com from antes de to.' };
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) return { error: 'min_score vai de 0 a 100.' };
  return { from, to, minScore, limit };
}

export function registerHotspotRoutes(app, ctx) {
  /* GET /api/hotspots?min_score=&from=&to=&limit= : pontos críticos, do maior risco para o menor */
  app.get('/api/hotspots', (req, res) => {
    const q = query(req);
    if (q.error) return res.status(400).json({ error: q.error });
    const list = ctx.hotspots.list(q);
    res.json({ count: list.length, hotspots: list });
  });

  /* GET /api/hotspots/export?format=geojson|csv (mesmos filtros) */
  app.get('/api/hotspots/export', (req, res) => {
    const q = query(req);
    if (q.error) return res.status(400).json({ error: q.error });
    const format = String(req.query.format ?? 'geojson').toLowerCase();
    if (!['geojson', 'csv'].includes(format)) return res.status(400).json({ error: 'format: geojson ou csv.' });
    const list = ctx.hotspots.list({ ...q, limit: 5000 });
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="echomap-barreiras-${stamp}.csv"`);
      return res.send(toCSV(list));
    }
    res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="echomap-barreiras-${stamp}.geojson"`);
    res.send(JSON.stringify(toGeoJSON(list), null, 2));
  });
}
