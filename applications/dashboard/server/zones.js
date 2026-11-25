import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* Zonas seguras editáveis pelo painel (aba Mapa). Ficam em data/zones.json;
   na primeira vez, o arquivo nasce com as zonas de config.json (safeZones). */

const MAX_ZONES = 20;

export function validateZone(z, base = {}) {
  const out = { ...base };
  if (z.name !== undefined) {
    const name = typeof z.name === 'string' ? z.name.trim().slice(0, 40) : '';
    if (!name) return { error: 'Dê um nome para a zona (ex.: Casa, Escola).' };
    out.name = name;
  }
  if (z.lat !== undefined || z.lon !== undefined) {
    const lat = Number(z.lat), lon = Number(z.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { error: 'Posição inválida: clique no mapa para escolher o centro da zona.' };
    }
    out.lat = Math.round(lat * 1e6) / 1e6;
    out.lon = Math.round(lon * 1e6) / 1e6;
  }
  if (z.radiusM !== undefined) {
    const r = Math.round(Number(z.radiusM));
    if (!Number.isFinite(r) || r < 20 || r > 5000) return { error: 'O raio vai de 20 m a 5.000 m.' };
    out.radiusM = r;
  }
  if (out.name == null || out.lat == null || out.lon == null || out.radiusM == null) return { error: 'Zona incompleta.' };
  return { zone: out };
}

export function createZones({ dataDir, initial = [], onChange = () => {} }) {
  const file = path.join(dataDir, 'zones.json');
  let zones = [];
  try {
    zones = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    zones = initial.map((z) => validateZone(z).zone).filter(Boolean);
  }
  zones = zones.map((z) => ({ id: z.id ?? crypto.randomBytes(4).toString('hex'), ...z }));

  const write = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(zones, null, 2)}\n`);
  };
  const save = () => { write(); onChange(zones); };
  if (!fs.existsSync(file)) write();

  return {
    list: () => zones,
    add(body) {
      if (zones.length >= MAX_ZONES) return { error: `Limite de ${MAX_ZONES} zonas.` };
      const { zone, error } = validateZone(body ?? {});
      if (error) return { error };
      const z = { id: crypto.randomBytes(4).toString('hex'), ...zone };
      zones = [...zones, z];
      save();
      return { zone: z };
    },
    update(id, body) {
      const cur = zones.find((z) => z.id === id);
      if (!cur) return { error: 'Zona não encontrada.', status: 404 };
      const { zone, error } = validateZone(body ?? {}, cur);
      if (error) return { error };
      zones = zones.map((z) => (z.id === id ? zone : z));
      save();
      return { zone };
    },
    remove(id) {
      if (!zones.some((z) => z.id === id)) return { error: 'Zona não encontrada.', status: 404 };
      zones = zones.filter((z) => z.id !== id);
      save();
      return { ok: true };
    },
  };
}
