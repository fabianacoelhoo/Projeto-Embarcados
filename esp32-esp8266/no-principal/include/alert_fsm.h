#pragma once
/* Pré-alerta "Estou bem" para queda e batida.
 *
 *   IDLE --trigger--> PRE_ALERT --(1 clique em até preAlertMs)--> CANCELLED_BY_USER
 *                         |
 *                         +--(tempo acabou)--> CONFIRMED_ALERT
 *
 * Depois de CONFIRMED_ALERT ou CANCELLED_BY_USER, o próximo trigger começa outro pré-alerta.
 * Eventos que chegam durante o pré-alerta entram no mesmo alerta: a causa sobe para a mais
 * grave (queda > batida), fica o maior pico, e o prazo NÃO é estendido (o alerta não pode
 * ser adiado para sempre por pancadas seguidas).
 *
 * C++ puro (sem Arduino/FreeRTOS), testado no PC em host_test/test_alert_fsm.cpp.
 * Quem usa protege as chamadas com um mutex: TaskImu dispara e avança o tempo, TaskButton cancela. */
#include <stdint.h>

enum class AlertState : uint8_t { Idle = 0, PreAlert = 1, Confirmed = 2, Cancelled = 3 };
enum class AlertCause : uint8_t { None = 0, Impact = 1, Fall = 2 }; /* ordem = gravidade */
enum class AlertAction : uint8_t { None = 0, Confirm = 1, Dismiss = 2 };

struct PendingAlert {
  AlertCause cause;
  float value;      /* maior pico (g) */
  float tilt;       /* inclinação que confirmou a queda; -1 se não houver */
  uint32_t t;       /* millis() do primeiro evento */
  uint8_t count;    /* quantos eventos entraram neste alerta */
};

class AlertFsm {
 public:
  explicit AlertFsm(uint32_t preAlertMs) : preAlertMs_(preAlertMs), state_(AlertState::Idle), startMs_(0) {
    clearPending();
  }

  /* queda/batida confirmada pelo detector; devolve true se abriu um pré-alerta novo */
  bool trigger(AlertCause cause, float value, float tilt, uint32_t nowMs) {
    if (state_ == AlertState::PreAlert) {
      if (cause > pending_.cause) {
        pending_.cause = cause;
        pending_.tilt = tilt;
      }
      if (value > pending_.value) pending_.value = value;
      if (pending_.count < 255) pending_.count++;
      return false;
    }
    state_ = AlertState::PreAlert;
    startMs_ = nowMs;
    pending_.cause = cause;
    pending_.value = value;
    pending_.tilt = tilt;
    pending_.t = nowMs;
    pending_.count = 1;
    return true;
  }

  /* clique curto: só tem efeito durante o pré-alerta */
  AlertAction cancel(uint32_t nowMs) {
    if (state_ != AlertState::PreAlert) return AlertAction::None;
    if (nowMs - startMs_ >= preAlertMs_) return tick(nowMs); /* chegou tarde: o tempo já tinha acabado */
    state_ = AlertState::Cancelled;
    return AlertAction::Dismiss;
  }

  /* chamar periodicamente; devolve Confirm uma única vez quando o prazo acaba */
  AlertAction tick(uint32_t nowMs) {
    if (state_ != AlertState::PreAlert) return AlertAction::None;
    if (nowMs - startMs_ < preAlertMs_) return AlertAction::None;
    state_ = AlertState::Confirmed;
    return AlertAction::Confirm;
  }

  AlertState state() const { return state_; }
  bool inPreAlert() const { return state_ == AlertState::PreAlert; }
  const PendingAlert &pending() const { return pending_; }

  /* 0..1 do prazo já passado (para o aviso local acelerar) */
  float progress(uint32_t nowMs) const {
    if (state_ != AlertState::PreAlert) return 0.0f;
    float p = (float)(nowMs - startMs_) / (float)preAlertMs_;
    return p > 1.0f ? 1.0f : p;
  }

 private:
  void clearPending() {
    pending_.cause = AlertCause::None;
    pending_.value = 0;
    pending_.tilt = -1.0f;
    pending_.t = 0;
    pending_.count = 0;
  }

  uint32_t preAlertMs_;
  AlertState state_;
  uint32_t startMs_;
  PendingAlert pending_;
};
