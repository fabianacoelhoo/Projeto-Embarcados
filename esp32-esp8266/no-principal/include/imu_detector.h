#pragma once

/*=====================================================*/
/* EchoMap - deteccao de queda e impacto                 */
/* Logica pura (sem Arduino): recebe o modulo da         */
/* aceleracao em g e o tempo em ms. Testada no PC em     */
/* host_test/test_imu_detector.cpp                        */
/*=====================================================*/

#include <math.h>
#include <stdint.h>

/* Jump = queda livre + impacto, mas a pessoa continuou de pe (pulo, corrida, degrau):
   nao vira alerta, so aparece no log da Serial */
enum class ImuEvent : uint8_t { None, Fall, Impact, Jump };

struct ImuDetectorConfig {
  float freeFallG;          /* abaixo disso o corpo esta "sem peso" (queda livre) */
  uint32_t freeFallMinMs;   /* tempo minimo em queda livre para contar como queda */
  uint32_t fallWindowMs;    /* tempo maximo entre o fim da queda livre e o impacto */
  float fallImpactG;        /* impacto que confirma a queda */
  float impactG;            /* pancada sem queda livre antes (batida) */
  uint32_t peakWindowMs;    /* espera o pico do impacto antes de avisar */
  uint32_t cooldownMs;      /* intervalo minimo entre dois eventos */
  uint32_t fallConfirmMs;   /* depois do impacto, espera esse tempo para ver a postura */
  float fallTiltDeg;        /* inclinacao media no fim da espera para confirmar a queda (0 = nao confirma) */
  float hardImpactG;        /* queda nao confirmada mas com pancada >= isso vira IMPACT (ex.: bateu correndo) */
};

class ImuDetector {
 public:
  explicit ImuDetector(const ImuDetectorConfig &cfg) : cfg_(cfg) {}

  /* Chamar a cada amostra com o modulo da aceleracao (g) e a inclinacao (graus) em relacao
     a posicao de uso. Quando retorna um evento, peakG traz o pico do impacto e tiltDeg a
     inclinacao media usada para confirmar a queda. */
  ImuEvent update(float g, float tilt, uint32_t nowMs, float &peakG, float &tiltDeg) {
    peakG = 0.0f;
    tiltDeg = 0.0f;

    /* 1) impacto ja detectado: acompanha o pico ate o fim da janela */
    if (pending_ != ImuEvent::None) {
      if (g > peak_) peak_ = g;
      if (nowMs - pendingSinceMs_ < cfg_.peakWindowMs) return ImuEvent::None;
      ImuEvent evt = pending_;
      pending_ = ImuEvent::None;
      freeFall_ = false;
      lowActive_ = false;
      if (evt == ImuEvent::Fall && cfg_.fallTiltDeg > 0.0f) {
        /* queda precisa de confirmacao: quem cai fica inclinado/deitado; quem pula continua de pe */
        confirming_ = true;
        confirmUntilMs_ = nowMs + cfg_.fallConfirmMs;
        tiltSum_ = 0.0f;
        tiltN_ = 0;
        return ImuEvent::None;
      }
      return finish(evt, nowMs, peakG, tiltDeg, tilt);
    }

    /* 2) esperando a postura depois do impacto (media do ultimo terco da espera) */
    if (confirming_) {
      if ((int32_t)(nowMs - (confirmUntilMs_ - cfg_.fallConfirmMs / 3)) >= 0) {
        tiltSum_ += tilt;
        tiltN_++;
      }
      if ((int32_t)(nowMs - confirmUntilMs_) < 0) return ImuEvent::None;
      confirming_ = false;
      float avg = tiltN_ ? tiltSum_ / tiltN_ : tilt;
      ImuEvent evt = ImuEvent::Jump;
      if (avg >= cfg_.fallTiltDeg) evt = ImuEvent::Fall;
      else if (cfg_.hardImpactG > 0.0f && peak_ >= cfg_.hardImpactG) evt = ImuEvent::Impact;
      return finish(evt, nowMs, peakG, tiltDeg, avg);
    }

    /* 3) depois de um evento, ignora o resto da mesma pancada */
    if (coolingDown_) {
      if ((int32_t)(nowMs - cooldownUntilMs_) < 0) return ImuEvent::None;
      coolingDown_ = false;
    }

    /* 4) queda livre: aceleracao baixa por tempo suficiente */
    if (g < cfg_.freeFallG) {
      if (!lowActive_) {
        lowActive_ = true;
        lowStartMs_ = nowMs;
      }
      lastLowMs_ = nowMs;
      if (!freeFall_ && nowMs - lowStartMs_ >= cfg_.freeFallMinMs) freeFall_ = true;
    } else {
      lowActive_ = false;
    }
    if (freeFall_ && g >= cfg_.freeFallG && nowMs - lastLowMs_ > cfg_.fallWindowMs) {
      freeFall_ = false; /* caiu "no vazio" e nao bateu: nao conta */
    }

    /* 5) impacto: com queda livre antes = queda (a confirmar); sem = batida */
    if (freeFall_ && g >= cfg_.fallImpactG) {
      start(ImuEvent::Fall, g, nowMs);
    } else if (g >= cfg_.impactG) {
      start(ImuEvent::Impact, g, nowMs);
    }
    return ImuEvent::None;
  }

 private:
  ImuEvent finish(ImuEvent evt, uint32_t nowMs, float &peakG, float &tiltDeg, float tilt) {
    peakG = peak_;
    tiltDeg = tilt;
    cooldownUntilMs_ = nowMs + cfg_.cooldownMs;
    coolingDown_ = true;
    return evt;
  }

  void start(ImuEvent evt, float g, uint32_t nowMs) {
    pending_ = evt;
    pendingSinceMs_ = nowMs;
    peak_ = g;
  }

  ImuDetectorConfig cfg_;
  bool lowActive_ = false;
  bool freeFall_ = false;
  uint32_t lowStartMs_ = 0;
  uint32_t lastLowMs_ = 0;
  ImuEvent pending_ = ImuEvent::None;
  uint32_t pendingSinceMs_ = 0;
  float peak_ = 0.0f;
  bool coolingDown_ = false;
  uint32_t cooldownUntilMs_ = 0;
  bool confirming_ = false;
  uint32_t confirmUntilMs_ = 0;
  float tiltSum_ = 0.0f;
  uint32_t tiltN_ = 0;
};

/* Inclinacao (graus) entre a direcao atual da gravidade e a de referencia,
   medida no boot com o dispositivo na posicao normal de uso. Funciona com o
   modulo montado em qualquer orientacao. */
inline float tiltFromReferenceDeg(const float ref[3], float ax, float ay, float az) {
  float n1 = sqrtf(ref[0] * ref[0] + ref[1] * ref[1] + ref[2] * ref[2]);
  float n2 = sqrtf(ax * ax + ay * ay + az * az);
  if (n1 < 1e-3f || n2 < 1e-3f) return 0.0f;
  float c = (ref[0] * ax + ref[1] * ay + ref[2] * az) / (n1 * n2);
  if (c > 1.0f) c = 1.0f;
  if (c < -1.0f) c = -1.0f;
  return acosf(c) * 57.29578f;
}
