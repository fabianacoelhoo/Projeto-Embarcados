#pragma once
/* Gestos do botão: 1, 2 ou 3 cliques curtos (o clique longo, SOS, é tratado à parte e na hora).
 *
 *   1 clique  -> troca o modo (só depois de gapMs sem outro clique, para não confundir com 2 ou 3)
 *   2 cliques -> âncora rápida (zona segura dinâmica no ponto atual)
 *   3 cliques -> portal de Wi-Fi (sai no terceiro clique, sem esperar)
 *
 * Cada clique precisa vir até gapMs depois do anterior. Durante o pré-alerta "Estou bem", o firmware
 * cancela no primeiro clique sem passar por aqui (a pessoa não pode esperar a classificação).
 *
 * C++ puro (sem Arduino/FreeRTOS), testado no PC em host_test/test_click_classifier.cpp. */
#include <stdint.h>

enum class ClickGesture : uint8_t { None = 0, Single = 1, Double = 2, Triple = 3 };

class ClickClassifier {
 public:
  explicit ClickClassifier(uint32_t gapMs) : gapMs_(gapMs), count_(0), lastMs_(0) {}

  /* um clique curto terminou (botão solto); devolve Triple na hora do terceiro */
  ClickGesture click(uint32_t nowMs) {
    if (count_ > 0 && nowMs - lastMs_ > gapMs_) count_ = 0; /* o anterior já tinha vencido sem tick() */
    count_++;
    lastMs_ = nowMs;
    if (count_ >= 3) {
      count_ = 0;
      return ClickGesture::Triple;
    }
    return ClickGesture::None;
  }

  /* chamar periodicamente: fecha 1 ou 2 cliques quando passa gapMs sem outro */
  ClickGesture tick(uint32_t nowMs) {
    if (count_ == 0 || nowMs - lastMs_ <= gapMs_) return ClickGesture::None;
    ClickGesture g = count_ == 1 ? ClickGesture::Single : ClickGesture::Double;
    count_ = 0;
    return g;
  }

  /* clique longo ou pré-alerta: descarta o que estava contando */
  void reset() { count_ = 0; }
  uint8_t pending() const { return count_; }

 private:
  uint32_t gapMs_;
  uint8_t count_;
  uint32_t lastMs_;
};
