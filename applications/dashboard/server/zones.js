import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* Zonas seguras, guardadas no SQLite (tabela safe_zones):
   - "fixed": cadastradas na aba Mapa (Casa, Escola...);
   - "dynamic": âncora rápida (2 cliques no botão ou "Criar âncora aqui"), uma por dispositivo, com expires_at.
   Na primeira vez, importa data/zones.json (versão anterior) ou, sem ele, as safeZones do config.json. */

const MAX_ZONES = 20;

export function validateZone(z, base = {}) {
  const out = { ...base };
  if (z.name !== undefined) {
    const name = typeof z.name === 'string' ? z.name.trim().slice(0, 40) : '';
    if (!name) return { error: 'Dê um nome para a zona (ex.: Casa, Escola).' };
    out.name = name;
  }
  if (z.lat !== undefined || z.lon !== undefined || z.lng !== undefined) {
    const lat = Number(z.lat), lon = Number(z.lon ?? z.lng);
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

const newId = () => crypto.randomBytes(4).toString('hex');

export function createZones({ db, dataDir, initial = [], onChange = () => {} }) {
  /* migração de dados: zones.json (Fase 1/2) -> tabela, uma vez só (tabela vazia) */
  if (db.zoneCount() === 0) {
    const file = dataDir ? path.join(dataDir, 'zones.json') : null;
    let source = initial;
    let fromFile = false;
    try {
      if (file && fs.existsSync(file)) {
        source = JSON.parse(fs.readFileSync(file, 'utf8'));
        fromFile = true;
      }
    } catch { /* arquivo corrompido: fica com o config */ }
    for (const z of source) {
      const { zone } = validateZone(z);
      if (zone) db.insertZone({ id: z.id ?? newId(), ...zone, type: 'fixed' });
    }
    if (fromFile) {
      /* o arquivo fica como cópia de segurança, mas deixa de ser usado */
      try { fs.renameSync(file, `${file}.importado`); } catch { /* sem permissão: segue */ }
    }
  }

  const active = (now = Date.now()) => db.zones().filter((z) => z.type !== 'dynamic' || z.expiresAt == null || z.expiresAt > now);
  const changed = () => onChange(active());
  const fixedCount = () => db.zones().filter((z) => z.type === 'fixed').length;

  return {
    list: () => active(),
    add(body) {
      if (fixedCount() >= MAX_ZONES) return { error: `Limite de ${MAX_ZONES} zonas.` };
      const { zone, error } = validateZone(body ?? {});
      if (error) return { error };
      const z = db.insertZone({ id: newId(), ...zone, type: 'fixed' });
      changed();
      return { zone: z };
    },
    update(id, body) {
      const cur = db.zone(id);
      if (!cur) return { error: 'Zona não encontrada.', status: 404 };
      if (cur.type === 'dynamic') return { error: 'Âncora rápida não se edita: remova e crie de novo.', status: 409 };
      const { zone, error } = validateZone(body ?? {}, cur);
      if (error) return { error };
      const z = db.updateZone({ ...zone, id });
      changed();
      return { zone: z };
    },
    remove(id) {
      if (!db.deleteZone(id)) return { error: 'Zona não encontrada.', status: 404 };
      changed();
      return { ok: true };
    },

    /* ---------- âncora rápida (zona dinâmica, uma por dispositivo) ---------- */
    anchorFor(deviceId, now = Date.now()) {
      const a = db.anchorOf(deviceId);
      return a && (a.expiresAt == null || a.expiresAt > now) ? a : null;
    },
    addAnchor({ deviceId, lat, lon, radiusM, durationMs, name = 'Âncora rápida', now = Date.now() }) {
      const { zone, error } = validateZone({ name, lat, lon, radiusM });
      if (error) return { error };
      const old = db.anchorOf(deviceId);
      if (old) db.deleteZone(old.id); /* uma âncora por dispositivo: a nova substitui */
      const z = db.insertZone({ id: newId(), ...zone, type: 'dynamic', expiresAt: now + durationMs, deviceId, createdAt: now });
      changed();
      return { zone: z };
    },
    removeAnchor(deviceId) {
      const a = db.anchorOf(deviceId);
      if (!a) return null;
      db.deleteZone(a.id);
      changed();
      return a;
    },
    /* job periódico: apaga âncoras vencidas e devolve quais eram (para registrar na linha do tempo) */
    expire(now = Date.now()) {
      const gone = db.expiredZones(now);
      for (const z of gone) db.deleteZone(z.id);
      if (gone.length) changed();
      return gone;
    },
  };
}
