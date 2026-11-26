/* Cópia em JavaScript do detector de TTC do firmware (esp32-esp8266/no-principal/include/ttc_detector.h),
   usada pelo simulador para gerar NEAR_MISS do mesmo jeito que a placa. Os limiares são os do config.h. */

export const TTC_DEFAULTS = {
  vMinCmS: 15, ttcCriticalS: 1.5, ttcMaxDistCm: 150, closeCm: 25, closeSamples: 3,
  staticMaxCm: 120, cooldownMs: 3000, confirmSamples: 2, maxGapMs: 500, dropoutReset: 3,
};

const median3 = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

export class TtcDetector {
  constructor(cfg = TTC_DEFAULTS) {
    this.cfg = { ...TTC_DEFAULTS, ...cfg };
    this.reported = false;
    this.lastReportMs = 0;
    this.reset();
  }

  reset() {
    this.med = [];
    this.win = []; /* [{t, d}] */
    this.misses = 0;
    this.closeCount = 0;
    this.ttcCount = 0;
    this.lastLevel = 'clear';
    this.lastDist = -1;
  }

  slope() {
    const n = this.win.length;
    const t0 = this.win[0].t;
    const mt = this.win.reduce((s, p) => s + (p.t - t0) / 1000, 0) / n;
    const md = this.win.reduce((s, p) => s + p.d, 0) / n;
    let num = 0, den = 0;
    for (const p of this.win) {
      const dt = (p.t - t0) / 1000 - mt;
      num += dt * (p.d - md);
      den += dt * dt;
    }
    return den > 1e-6 ? num / den : 0;
  }

  /* raw em cm (0, -1 ou fora de 2..400 = falha), nowMs = millis() */
  update(raw, nowMs) {
    const c = this.cfg;
    const r = { level: 'clear', distCm: -1, velocityCmS: 0, ttcS: -1, report: false, reason: null };
    if (!(raw >= 2 && raw <= 400)) {
      this.misses += 1;
      this.closeCount = 0;
      this.ttcCount = 0;
      if (this.misses >= c.dropoutReset) { this.reset(); return r; }
      r.distCm = this.lastDist;
      r.level = this.lastLevel === 'critical' ? 'approaching' : this.lastLevel;
      return r;
    }
    this.misses = 0;
    this.med = [...this.med, raw].slice(-3);
    const d = this.med.length < 3 ? raw : median3(...this.med);
    if (this.med.length === 3) {
      if (this.win.length && nowMs - this.win[this.win.length - 1].t > c.maxGapMs) this.win = [];
      this.win = [...this.win, { t: nowMs, d }].slice(-5);
    }
    const vValid = this.win.length >= 3;
    const v = vValid ? -this.slope() : 0;
    r.distCm = d;
    r.velocityCmS = v;
    if (vValid && v > c.vMinCmS) r.ttcS = d / v;

    this.closeCount = raw <= c.closeCm ? this.closeCount + 1 : 0;
    const ttcHit = r.ttcS >= 0 && r.ttcS <= c.ttcCriticalS && d <= c.ttcMaxDistCm;
    this.ttcCount = ttcHit ? this.ttcCount + 1 : 0;

    if (this.closeCount >= c.closeSamples) { r.level = 'critical'; r.reason = 'close'; }
    else if (this.ttcCount >= c.confirmSamples) { r.level = 'critical'; r.reason = 'ttc'; }
    else if (vValid && v > c.vMinCmS && d <= c.ttcMaxDistCm) r.level = 'approaching';
    else if (d <= c.staticMaxCm) r.level = 'static';

    if (r.level === 'critical' && (!this.reported || nowMs - this.lastReportMs >= c.cooldownMs)) {
      this.reported = true;
      this.lastReportMs = nowMs;
      r.report = true;
    }
    this.lastLevel = r.level;
    this.lastDist = d;
    return r;
  }
}

/* o evento NEAR_MISS no mesmo formato do firmware 1.5 */
export function nearMissEvent(r, side, t) {
  return r.reason === 'ttc'
    ? { event: 'NEAR_MISS', side, value: +r.distCm.toFixed(1), reason: 'ttc', ttc: +r.ttcS.toFixed(2), v: Math.round(r.velocityCmS), t }
    : { event: 'NEAR_MISS', side, value: +r.distCm.toFixed(1), reason: 'close', t };
}
