/* Geohash (função pura, sem dependências): transforma lat/lon numa célula do mapa.
   Precisão 8 = célula de ~38 m × 19 m no equador (~19 m × 19 m em Recife, 8° S, mais estreita em longitude).
   Ocorrências na mesma célula viram o mesmo ponto urbano (esquina, calçada, travessia). */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encodeGeohash(lat, lon, precision = 8) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new RangeError(`posição inválida: ${lat}, ${lon}`);
  }
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let hash = '', bits = 0, value = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { value = (value << 1) | 1; lonMin = mid; } else { value <<= 1; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { value = (value << 1) | 1; latMin = mid; } else { value <<= 1; latMax = mid; }
    }
    even = !even;
    bits += 1;
    if (bits === 5) { hash += BASE32[value]; bits = 0; value = 0; }
  }
  return hash;
}

/* limites e centro da célula */
export function decodeGeohash(hash) {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180, even = true;
  for (const ch of String(hash).toLowerCase()) {
    const v = BASE32.indexOf(ch);
    if (v < 0) throw new RangeError(`geohash inválido: ${hash}`);
    for (let b = 4; b >= 0; b -= 1) {
      const bit = (v >> b) & 1;
      if (even) { const mid = (lonMin + lonMax) / 2; if (bit) lonMin = mid; else lonMax = mid; }
      else { const mid = (latMin + latMax) / 2; if (bit) latMin = mid; else latMax = mid; }
      even = !even;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2, latErr: (latMax - latMin) / 2, lonErr: (lonMax - lonMin) / 2 };
}
