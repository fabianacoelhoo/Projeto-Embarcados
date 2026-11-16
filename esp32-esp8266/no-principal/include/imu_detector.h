#pragma once

/*=====================================================*/
/* EchoMap - deteccao de queda e impacto                 */
/* Logica pura (sem Arduino): recebe o modulo da         */
/* aceleracao em g e o tempo em ms. Testada no PC em     */
/* host_test/test_imu_detector.cpp                        */
/*=====================================================*/

#include <math.h>
#include <stdint.h>

enum class ImuEvent : uint8_t { None, Fall, Impact };

struct ImuDetectorConfig {
  float freeFallG;          /* abaixo disso o corpo esta "sem peso" (queda livre) */
  uint32_t freeFallMinMs;   /* tempo minimo em queda livre para contar como queda */
  uint32_t fallWindowMs;    /* tempo maximo entre o fim da queda livre e o impacto */
  float fallImpactG;        /* impacto que confirma a queda */
  float impactG;            /* pancada sem queda livre antes (batida) */
  uint32_t peakWindowMs;    /* espera o pico do impacto antes de avisar */
  uint32_t cooldownMs;      /* intervalo minimo entre dois eventos */
};

class ImuDetector {
 public:
  explicit ImuDetector(const ImuDetectorConfig &cfg) : cfg_(cfg) {}

  /* Chamar a cada amostra. Quando retorna Fall ou Impact, peakG traz o maior
     valor medido durante o impacto. */
  ImuEvent update(float g, uint32_t nowMs, float &peakG) {
    peakG = 0.0f;

    /* 1) impacto ja detectado: acompanha o pico e avisa no fim da janela */
    if (pending_ != ImuEvent::None) {
      if (g > peak_) peak_ = g;
      if (nowMs - pendingSinceMs_ < cfg_.peakWindowMs) return ImuEvent::None;
      ImuEvent evt = pending_;
      peakG = peak_;
      pending_ = ImuEvent::None;
      cooldownUntilMs_ = nowMs + cfg_.cooldownMs;
      coolingDown_ = true;
      freeFall_ = false;
      lowActive_ = false;
      return evt;
    }

    /* 2) depois de um evento, ignora o resto da mesma pancada */
    if (coolingDown_) {
      if ((int32_t)(nowMs - cooldownUntilMs_) < 0) return ImuEvent::None;
      coolingDown_ = false;
    }

    /* 3) queda livre: aceleracao baixa por tempo suficiente */
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

    /* 4) impacto: com queda livre antes = queda; sem = batida */
    if (freeFall_ && g >= cfg_.fallImpactG) {
      start(ImuEvent::Fall, g, nowMs);
    } else if (g >= cfg_.impactG) {
      start(ImuEvent::Impact, g, nowMs);
    }
    return ImuEvent::None;
  }

 private:
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
