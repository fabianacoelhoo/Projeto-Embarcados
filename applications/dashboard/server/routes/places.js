/* Zonas seguras (fixas e âncora rápida), locais conhecidos por Wi-Fi e mapa de calor. */
import { computeHeatmap, parseTime } from '../heatmap.js';

export function registerPlaceRoutes(app, ctx) {
  const { config, db, hub, zones } = ctx;

  /* ---------------- zonas seguras ---------------- */
  app.get('/api/zones', (req, res) => res.json(zones.list()));
  app.post('/api/zones', (req, res) => {
    const out = zones.add(req.body);
    res.status(out.error ? 400 : 201).json(out.error ? { error: out.error } : out.zone);
  });
  app.patch('/api/zones/:id', (req, res) => {
    const out = zones.update(req.params.id, req.body);
    res.status(out.error ? out.status ?? 400 : 200).json(out.error ? { error: out.error } : out.zone);
  });
  app.delete('/api/zones/:id', (req, res) => {
    const out = zones.remove(req.params.id);
    res.status(out.error ? out.status ?? 400 : 200).json(out.error ? { error: out.error } : { ok: true });
  });

  /* ---------------- âncora rápida (zona segura dinâmica) ---------------- */
  /* POST {deviceId?, radiusM?, hours?, lat?, lng?}: sem lat/lng usa a posição atual do dispositivo */
  app.post('/api/safe-zones/anchor', (req, res) => {
    const b = req.body ?? {};
    const deviceId = typeof b.deviceId === 'string' && b.deviceId ? b.deviceId : config.defaultDeviceId;
    const radiusM = b.radiusM == null ? undefined : Number(b.radiusM);
    const hours = b.hours == null ? undefined : Number(b.hours);
    if (radiusM !== undefined && !(radiusM >= 20 && radiusM <= 5000)) return res.status(400).json({ error: 'O raio vai de 20 m a 5.000 m.' });
    if (hours !== undefined && !(hours > 0 && hours <= 24)) return res.status(400).json({ error: 'A âncora dura de alguns minutos a 24 h.' });
    const lat = b.lat == null ? undefined : Number(b.lat), lon = b.lng ?? b.lon;
    const out = hub.createAnchor(deviceId, { lat, lon: lon == null ? undefined : Number(lon), radiusM, durationMs: hours ? hours * 3600000 : undefined });
    res.status(out.error ? out.status ?? 400 : 201).json(out.error ? { error: out.error } : out.zone);
  });
  app.delete('/api/safe-zones/anchor', (req, res) => {
    const deviceId = String(req.query.deviceId ?? req.body?.deviceId ?? config.defaultDeviceId);
    const z = hub.removeAnchor(deviceId);
    res.status(z ? 200 : 404).json(z ? { ok: true, zone: z } : { error: 'Nenhuma âncora ativa para esse dispositivo.' });
  });

  /* ---------------- mapa de calor de barreiras urbanas ---------------- */
  /* GET /api/heatmap?from=<iso|ms>&to=<iso|ms>&min_severity=info|warning|serious|critical&types=NEAR_MISS&deviceId= */
  app.get('/api/heatmap', (req, res) => {
    const to = parseTime(req.query.to, Date.now());
    const from = parseTime(req.query.from, to - 7 * 86400000);
    if (from == null || to == null || from > to) return res.status(400).json({ error: 'Período inválido: use datas ISO (2026-11-25) ou milissegundos, com from antes de to.' });
    const minSeverity = String(req.query.min_severity ?? 'info');
    if (!['info', 'warning', 'serious', 'critical'].includes(minSeverity)) return res.status(400).json({ error: 'min_severity: info, warning, serious ou critical.' });
    const types = String(req.query.types ?? 'NEAR_MISS').split(',').map((s) => s.trim()).filter((s) => /^[A-Z_]{2,30}$/.test(s));
    res.json(computeHeatmap(db, { from, to, minSeverity, types: types.length ? types : ['NEAR_MISS'], deviceId: req.query.deviceId || null }));
  });

  /* ---------------- locais conhecidos por Wi-Fi (fallback do GPS em ambiente interno) ---------------- */
  app.get('/api/wifi-places', (req, res) => res.json(db.places()));
  app.post('/api/wifi-places', (req, res) => {
    const b = req.body ?? {};
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 40) : '';
    const bssid = typeof b.bssid === 'string' ? b.bssid.trim().toUpperCase() : '';
    const minRssi = b.minRssi == null ? -80 : Math.round(Number(b.minRssi));
    const lat = b.lat == null || b.lat === '' ? null : Number(b.lat), lng = b.lng == null || b.lng === '' ? null : Number(b.lng);
    if (!name) return res.status(400).json({ error: 'Dê um nome para o local (ex.: Casa, CESAR School).' });
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(bssid)) return res.status(400).json({ error: 'BSSID inválido (formato AA:BB:CC:DD:EE:FF).' });
    if (!(minRssi >= -100 && minRssi <= -20)) return res.status(400).json({ error: 'Sinal mínimo entre -100 e -20 dBm.' });
    if ((lat == null) !== (lng == null) || (lat != null && !(Math.abs(lat) <= 90 && Math.abs(lng) <= 180))) return res.status(400).json({ error: 'Posição inválida.' });
    if (db.placesByBssid(bssid).some((p) => p.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'Essa rede já está cadastrada com esse nome.' });
    const place = db.insertPlace({ name, bssid, minRssi, lat, lng, isSafeZone: b.isSafeZone !== false });
    ctx.broadcast({ type: 'wifiPlaces', places: db.places() });
    res.status(201).json(place);
  });
  app.delete('/api/wifi-places/:id', (req, res) => {
    if (!db.deletePlace(Number(req.params.id))) return res.status(404).json({ error: 'Local não encontrado.' });
    ctx.broadcast({ type: 'wifiPlaces', places: db.places() });
    res.json({ ok: true });
  });
}
