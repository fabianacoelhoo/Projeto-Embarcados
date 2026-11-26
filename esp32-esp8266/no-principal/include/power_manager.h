#pragma once
/* Economia de energia guiada pelo MPU-6050.
 *
 *   ACTIVE --(sem movimento por idleAfterMs)--> IDLE_SAVING
 *   IDLE_SAVING --(qualquer movimento ou clique no botão)--> ACTIVE   (na mesma amostra: < 5 ms a 200 Hz)
 *
 * "Movimento" em uma amostra (g normalizado, parado = 1 g):
 *   - |g - 1| > accelThrG              (passo, sacudida, queda), ou
 *   - desvio padrão recente de g > stdThrG (tremor/balanço contínuo, média móvel exponencial), ou
 *   - giro > gyroThrDps                (girou o corpo sem mudar a aceleração).
 *
 * Quem usa: em IDLE_SAVING, ultrassônicos a 1 Hz e Wi-Fi em modem-sleep; ao acordar, volta tudo.
 * C++ puro (sem Arduino/FreeRTOS), testado no PC em host_test/test_power_manager.cpp. */
#include <math.h>
#include <stdint.h>

struct PowerConfig {
  float accelThrG;     /* desvio de 1 g que já conta como movimento (0,06 g) */
  float stdThrG;       /* desvio padrão recente de g que conta como movimento (0,03 g) */
  float gyroThrDps;    /* giro que conta como movimento (12 graus/s) */
  float varAlpha;      /* peso da amostra nova na média/variância móvel (0,02 = ~250 ms a 200 Hz) */
  uint32_t idleAfterMs; /* parado por isso -> economia (120 s; menor nos testes) */
};

enum class PowerState : uint8_t { Active = 0, IdleSaving = 1 };
enum class PowerChange : uint8_t { None = 0, EnterIdle = 1, Wake = 2 };

class PowerManager {
 public:
  explicit PowerManager(const PowerConfig &cfg)
      : cfg_(cfg), state_(PowerState::Active), started_(false), lastMotionMs_(0), mean_(1.0f), var_(0.0f) {}

  /* g = módulo da aceleração normalizado; gyroDps = módulo do giro sem offset */
  PowerChange update(float g, float gyroDps, uint32_t nowMs) {
    if (!started_) {
      started_ = true;
      lastMotionMs_ = nowMs;
      mean_ = g;
    }
    float d = g - mean_;
    mean_ += cfg_.varAlpha * d;
    var_ = (1.0f - cfg_.varAlpha) * (var_ + cfg_.varAlpha * d * d);

    bool motion = fabsf(g - 1.0f) > cfg_.accelThrG || sqrtf(var_) > cfg_.stdThrG || gyroDps > cfg_.gyroThrDps;
    if (motion) return markMotion(nowMs);
    if (state_ == PowerState::Active && nowMs - lastMotionMs_ >= cfg_.idleAfterMs) {
      state_ = PowerState::IdleSaving;
      return PowerChange::EnterIdle;
    }
    return PowerChange::None;
  }

  /* clique no botão (ou comando) acorda na hora e reinicia a contagem */
  PowerChange wake(uint32_t nowMs) {
    started_ = true;
    return markMotion(nowMs);
  }

  PowerState state() const { return state_; }
  bool idle() const { return state_ == PowerState::IdleSaving; }
  float stdG() const { return sqrtf(var_); }

 private:
  PowerChange markMotion(uint32_t nowMs) {
    lastMotionMs_ = nowMs;
    if (state_ == PowerState::IdleSaving) {
      state_ = PowerState::Active;
      return PowerChange::Wake;
    }
    return PowerChange::None;
  }

  PowerConfig cfg_;
  PowerState state_;
  bool started_;
  uint32_t lastMotionMs_;
  float mean_, var_;
};
