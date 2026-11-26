#pragma once
/* Calibração assistida (30 s andando em linha reta num corredor livre).
 *
 * Coleta online, sem guardar as amostras (algoritmo de Welford: média e desvio padrão em O(1) de RAM):
 *  - passos: cada pico de |a| acima de stepMinG (com pausa mínima entre passos) é um passo;
 *    média, desvio padrão e máximo dos picos;
 *  - eco dos ultrassônicos: ruído de cada lado pela diferença entre leituras seguidas
 *    (std(d[i] - d[i-1]) / sqrt(2)): mede o tremor do eco, e não o fato de as paredes do corredor
 *    chegarem mais perto ou mais longe enquanto a pessoa anda.
 *
 * No fim:
 *  - limiar de batida = max(minImpactG, maior pico de passo x impactFactor), limitado a maxImpactG
 *    (se a pessoa correu ou bateu o pé durante a calibração, o limiar não sobe a ponto de esconder batidas);
 *  - histerese dos ultrassônicos = hystK x maior ruído entre os lados, entre hystMinCm e hystMaxCm.
 * Com menos de minSteps passos a calibração falha e nada muda. Sem eco suficiente, a histerese fica como estava.
 *
 * C++ puro (sem Arduino/FreeRTOS), testado no PC em host_test/test_calibration.cpp. */
#include <math.h>
#include <stdint.h>

struct Welford {
  uint32_t n;
  double mean;
  double m2;
  float maxV;

  void reset() { n = 0; mean = 0; m2 = 0; maxV = 0; }
  void add(float x) {
    n++;
    double d = x - mean;
    mean += d / n;
    m2 += d * (x - mean);
    if (n == 1 || x > maxV) maxV = x;
  }
  float stdDev() const { return n > 1 ? (float)sqrt(m2 / (n - 1)) : 0.0f; }
};

struct CalibConfig {
  float stepMinG;           /* pico acima disso conta como passo (1,15 g) */
  uint32_t stepRefractoryMs; /* intervalo mínimo entre dois passos (250 ms) */
  float impactFactor;       /* limiar de batida = maior passo x isso (1,6) */
  float minImpactG;         /* piso do limiar de batida */
  float maxImpactG;         /* teto do limiar de batida */
  float hystK;              /* histerese = hystK x ruído do eco (3) */
  float hystMinCm;
  float hystMaxCm;
  uint16_t minSteps;        /* menos passos que isso: calibração inválida */
  uint16_t minEchoSamples;  /* menos diferenças válidas que isso num lado: lado ignorado */
  float maxEchoJumpCm;      /* salto maior que isso entre leituras é outro objeto, não ruído */
};

enum class CalibStatus : uint8_t { Idle = 0, Running = 1, Done = 2, Failed = 3 };

struct CalibResult {
  CalibStatus status;
  const char *reason;   /* por que falhou, ou "ok" */
  uint16_t steps;
  float stepMean, stepStd, stepMax;
  float noiseL, noiseR; /* ruído do eco (cm); -1 = sem eco suficiente */
  uint16_t echoNL, echoNR;
  float impactBefore, impactAfter;
  float hystBefore, hystAfter;
};

class Calibrator {
 public:
  explicit Calibrator(const CalibConfig &cfg) : cfg_(cfg), running_(false), startMs_(0), durationMs_(0) { clear(); }

  void start(uint32_t nowMs, uint32_t durationMs) {
    clear();
    running_ = true;
    startMs_ = nowMs;
    durationMs_ = durationMs;
  }
  void cancel() { running_ = false; }
  bool running() const { return running_; }

  /* módulo da aceleração (g normalizado), na taxa da IMU */
  void addAccel(float g, uint32_t nowMs) {
    if (!running_) return;
    if (g >= cfg_.stepMinG) {
      if (!inPeak_ && (steps_.n == 0 || nowMs - lastStepMs_ >= cfg_.stepRefractoryMs)) {
        inPeak_ = true;
        peak_ = g;
        lastStepMs_ = nowMs;
      } else if (inPeak_ && g > peak_) {
        peak_ = g;
      }
    } else if (inPeak_ && g < cfg_.stepMinG - 0.05f) {
      steps_.add(peak_); /* passo terminou: guarda o pico */
      inPeak_ = false;
    }
  }

  /* leitura de um ultrassônico (0 = esquerdo, 1 = direito); inválida (< 0) quebra a sequência */
  void addEcho(uint8_t side, float cm) {
    if (!running_ || side > 1) return;
    if (cm < 2.0f || cm > 400.0f) {
      hasPrev_[side] = false;
      return;
    }
    if (hasPrev_[side]) {
      float d = cm - prev_[side];
      if (fabsf(d) <= cfg_.maxEchoJumpCm) echo_[side].add(d);
    }
    prev_[side] = cm;
    hasPrev_[side] = true;
  }

  float progress(uint32_t nowMs) const {
    if (!running_) return 0.0f;
    float p = (float)(nowMs - startMs_) / (float)durationMs_;
    return p > 1.0f ? 1.0f : p;
  }
  uint32_t elapsedMs(uint32_t nowMs) const { return running_ ? nowMs - startMs_ : 0; }
  uint32_t durationMs() const { return durationMs_; }
  uint16_t steps() const { return (uint16_t)steps_.n; }

  /* true quando o tempo acabou (chame finish() em seguida) */
  bool due(uint32_t nowMs) const { return running_ && nowMs - startMs_ >= durationMs_; }

  CalibResult finish(float impactNow, float hystNow) {
    running_ = false;
    CalibResult r;
    r.steps = (uint16_t)steps_.n;
    r.stepMean = (float)steps_.mean;
    r.stepStd = steps_.stdDev();
    r.stepMax = steps_.n ? steps_.maxV : 0.0f;
    r.echoNL = (uint16_t)echo_[0].n;
    r.echoNR = (uint16_t)echo_[1].n;
    r.noiseL = echo_[0].n >= cfg_.minEchoSamples ? echo_[0].stdDev() / 1.41421356f : -1.0f;
    r.noiseR = echo_[1].n >= cfg_.minEchoSamples ? echo_[1].stdDev() / 1.41421356f : -1.0f;
    r.impactBefore = impactNow;
    r.hystBefore = hystNow;
    r.impactAfter = impactNow;
    r.hystAfter = hystNow;

    if (steps_.n < cfg_.minSteps) {
      r.status = CalibStatus::Failed;
      r.reason = "poucos_passos";
      return r;
    }
    float impact = r.stepMax * cfg_.impactFactor;
    if (impact < cfg_.minImpactG) impact = cfg_.minImpactG;
    if (impact > cfg_.maxImpactG) impact = cfg_.maxImpactG;
    r.impactAfter = impact;

    float noise = r.noiseL > r.noiseR ? r.noiseL : r.noiseR;
    if (noise >= 0.0f) {
      float h = cfg_.hystK * noise;
      if (h < cfg_.hystMinCm) h = cfg_.hystMinCm;
      if (h > cfg_.hystMaxCm) h = cfg_.hystMaxCm;
      r.hystAfter = h;
      r.reason = "ok";
    } else {
      r.reason = "sem_eco"; /* deu certo para a batida; a histerese ficou como estava */
    }
    r.status = CalibStatus::Done;
    return r;
  }

 private:
  void clear() {
    steps_.reset();
    echo_[0].reset();
    echo_[1].reset();
    hasPrev_[0] = hasPrev_[1] = false;
    prev_[0] = prev_[1] = 0;
    inPeak_ = false;
    peak_ = 0;
    lastStepMs_ = 0;
  }

  CalibConfig cfg_;
  bool running_;
  uint32_t startMs_, durationMs_;
  Welford steps_;
  Welford echo_[2];
  bool hasPrev_[2];
  float prev_[2];
  bool inPeak_;
  float peak_;
  uint32_t lastStepMs_;
};
