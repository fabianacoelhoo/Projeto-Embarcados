#pragma once
/* Detector de colisão por tempo até o impacto (TTC), um por ultrassônico.
 *
 * C++ puro (sem Arduino/FreeRTOS): roda igual na ESP32 e no PC (host_test/test_ttc_detector.cpp).
 *
 *  1. Leitura inválida (0, -1, timeout, fora de 2..400 cm) não entra no cálculo: uma falha isolada
 *     não vira "0 cm" nem "400 cm". Depois de `dropoutReset` falhas seguidas, a janela é zerada
 *     (o obstáculo sumiu) e precisa se encher de novo antes de calcular velocidade.
 *  2. Mediana das 3 últimas leituras válidas descarta ecos espúrios isolados.
 *  3. Janela das últimas 5 medianas com tempo: a velocidade de aproximação é a inclinação da reta
 *     (mínimos quadrados), v = -dd/dt em cm/s (positiva = chegando perto).
 *  4. TTC = d / v quando v > vMin.
 *
 * Regras:
 *  - Crítico: TTC <= ttcCriticalS com d <= ttcMaxDistCm (confirmado em confirmSamples leituras
 *    seguidas), OU leitura <= closeCm em closeSamples leituras válidas seguidas.
 *  - Estático/paralelo: d <= staticMaxCm sem aproximação (|v| < vMin): só feedback local, sem ocorrência.
 *  - Cooldown: entre duas ocorrências do mesmo lado, pelo menos cooldownMs, e a condição crítica
 *    precisa estar valendo de novo (obstáculo ainda perto ou se aproximando outra vez).
 *
 * Compila em C++11 (core Arduino da ESP32): sem valor padrão em campo de struct inicializada com {...}. */
#include <stdint.h>

struct TtcConfig {
  float vMinCmS;          /* abaixo disso o obstáculo é considerado parado (15 cm/s) */
  float ttcCriticalS;     /* TTC que dispara o crítico (1,5 s) */
  float ttcMaxDistCm;     /* o TTC só vale até essa distância (150 cm) */
  float closeCm;          /* perto demais, independente da velocidade (25 cm) */
  uint8_t closeSamples;   /* leituras válidas seguidas <= closeCm (3) */
  float staticMaxCm;      /* faixa do feedback local para obstáculo parado (120 cm) */
  uint32_t cooldownMs;    /* intervalo mínimo entre ocorrências do mesmo lado (3000 ms) */
  uint8_t confirmSamples; /* leituras seguidas com TTC crítico (2: filtra ruído) */
  uint32_t maxGapMs;      /* amostra mais velha que isso não entra na velocidade */
  uint8_t dropoutReset;   /* falhas seguidas que zeram a janela */
};

enum class TtcLevel : uint8_t { Clear = 0, Static = 1, Approaching = 2, Critical = 3 };
enum class TtcReason : uint8_t { None = 0, Ttc = 1, Close = 2 };

struct TtcResult {
  TtcLevel level;
  float distCm;      /* distância filtrada (mediana); -1 = nada */
  float velocityCmS; /* positiva = aproximando; 0 enquanto a janela não tem 3 amostras */
  float ttcS;        /* -1 quando não se aplica */
  bool report;       /* mandar ocorrência ao painel agora */
  TtcReason reason;
};

class TtcDetector {
 public:
  static const uint8_t WINDOW = 5;
  static const uint8_t MEDIAN = 3;

  explicit TtcDetector(const TtcConfig &cfg) : cfg_(cfg), reported_(false), lastReportMs_(0) { reset(); }

  void reset() {
    nMed_ = 0;
    medHead_ = 0;
    nWin_ = 0;
    winHead_ = 0;
    misses_ = 0;
    closeCount_ = 0;
    ttcCount_ = 0;
    lastLevel_ = TtcLevel::Clear;
    lastDist_ = -1.0f;
  }

  TtcResult update(float rawCm, uint32_t nowMs) {
    TtcResult r;
    r.level = TtcLevel::Clear;
    r.distCm = -1.0f;
    r.velocityCmS = 0.0f;
    r.ttcS = -1.0f;
    r.report = false;
    r.reason = TtcReason::None;

    bool valid = rawCm >= 2.0f && rawCm <= 400.0f;
    if (!valid) {
      if (misses_ < 255) misses_++;
      closeCount_ = 0; /* "seguidas" quebra na falha */
      ttcCount_ = 0;
      if (misses_ >= cfg_.dropoutReset) {
        reset();
        return r;
      }
      /* falha curta: mantém a última distância e o nível, sem calcular nada novo */
      r.distCm = lastDist_;
      r.level = lastLevel_ == TtcLevel::Critical ? TtcLevel::Approaching : lastLevel_;
      return r;
    }
    misses_ = 0;

    /* mediana das 3 últimas leituras válidas */
    med_[medHead_] = rawCm;
    medHead_ = (uint8_t)((medHead_ + 1) % MEDIAN);
    if (nMed_ < MEDIAN) nMed_++;
    float d = nMed_ < MEDIAN ? rawCm : median3(med_[0], med_[1], med_[2]);

    /* janela: só entra mediana "cheia" (logo depois de zerar, uma leitura solta não vira velocidade) */
    if (nMed_ == MEDIAN) {
      if (nWin_ > 0 && nowMs - winT_[newest()] > cfg_.maxGapMs) nWin_ = 0; /* janela velha */
      winT_[winHead_] = nowMs;
      winD_[winHead_] = d;
      winHead_ = (uint8_t)((winHead_ + 1) % WINDOW);
      if (nWin_ < WINDOW) nWin_++;
    }

    bool vValid = nWin_ >= 3;
    float v = vValid ? -slopeCmPerS() : 0.0f;
    r.distCm = d;
    r.velocityCmS = v;
    if (vValid && v > cfg_.vMinCmS) r.ttcS = d / v;

    closeCount_ = rawCm <= cfg_.closeCm ? (uint8_t)(closeCount_ < 255 ? closeCount_ + 1 : 255) : 0;
    bool ttcHit = r.ttcS >= 0.0f && r.ttcS <= cfg_.ttcCriticalS && d <= cfg_.ttcMaxDistCm;
    ttcCount_ = ttcHit ? (uint8_t)(ttcCount_ < 255 ? ttcCount_ + 1 : 255) : 0;

    if (closeCount_ >= cfg_.closeSamples) {
      r.level = TtcLevel::Critical;
      r.reason = TtcReason::Close;
    } else if (ttcCount_ >= cfg_.confirmSamples) {
      r.level = TtcLevel::Critical;
      r.reason = TtcReason::Ttc;
    } else if (vValid && v > cfg_.vMinCmS && d <= cfg_.ttcMaxDistCm) {
      r.level = TtcLevel::Approaching;
    } else if (d <= cfg_.staticMaxCm) {
      r.level = TtcLevel::Static;
    }

    if (r.level == TtcLevel::Critical && (!reported_ || nowMs - lastReportMs_ >= cfg_.cooldownMs)) {
      reported_ = true;
      lastReportMs_ = nowMs;
      r.report = true;
    }
    lastLevel_ = r.level;
    lastDist_ = d;
    return r;
  }

 private:
  static float median3(float a, float b, float c) {
    if (a > b) { float t = a; a = b; b = t; }
    if (b > c) { float t = b; b = c; c = t; }
    if (a > b) { float t = a; a = b; b = t; }
    return b;
  }

  uint8_t newest() const { return (uint8_t)((winHead_ + WINDOW - 1) % WINDOW); }

  /* inclinação (cm/s) da reta d(t) pelas amostras da janela */
  float slopeCmPerS() const {
    uint8_t first = (uint8_t)((winHead_ + WINDOW - nWin_) % WINDOW);
    uint32_t t0 = winT_[first];
    float st = 0, sd = 0;
    for (uint8_t i = 0; i < nWin_; i++) {
      uint8_t k = (uint8_t)((first + i) % WINDOW);
      st += (winT_[k] - t0) / 1000.0f;
      sd += winD_[k];
    }
    float mt = st / nWin_, md = sd / nWin_;
    float num = 0, den = 0;
    for (uint8_t i = 0; i < nWin_; i++) {
      uint8_t k = (uint8_t)((first + i) % WINDOW);
      float dt = (winT_[k] - t0) / 1000.0f - mt;
      num += dt * (winD_[k] - md);
      den += dt * dt;
    }
    return den > 1e-6f ? num / den : 0.0f;
  }

  TtcConfig cfg_;
  float med_[MEDIAN];
  uint8_t nMed_, medHead_;
  uint32_t winT_[WINDOW];
  float winD_[WINDOW];
  uint8_t nWin_, winHead_;
  uint8_t misses_, closeCount_, ttcCount_;
  TtcLevel lastLevel_;
  float lastDist_;
  bool reported_;
  uint32_t lastReportMs_;
};
