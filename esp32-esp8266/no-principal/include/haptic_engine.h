#pragma once
/* Linguagem háptica: separa O QUE tocar (padrão com significado) de COMO tocar (buzzer ou motor).
 *
 * O motor devolve, a cada tick(), a intensidade 0..1 de cada lado. Quem chama escreve isso no atuador
 * (buzzer PWM com tom fixo, ou motor de vibração ERM/LRA por PWM). Nada aqui bloqueia nem usa delay().
 *
 * Duas camadas por lado:
 *  - primeiro plano: padrões de uma vez (aproximação rápida, pré-alerta, batimento, confirmação, localizar),
 *    com prioridade; um padrão mais importante substitui o que estiver tocando, um menos importante é ignorado;
 *  - fundo (ambiente): repetição contínua conforme o obstáculo daquele lado (parado ou aproximando),
 *    que só toca quando o primeiro plano está livre. Mudar a distância não reinicia o pulso no meio.
 *
 * C++ puro (sem Arduino/FreeRTOS), testado no PC em host_test/test_haptic_engine.cpp. */
#include <stdint.h>

enum class HapticPattern : uint8_t {
  None = 0,
  StaticObstacle = 1, /* pulso curto e espaçado: obstáculo parado do lado (60 ms / 700 ms) */
  Proximity = 2,      /* fundo: aproximando; pulsos mais rápidos e fortes quanto mais perto */
  FastApproach = 3,   /* TTC crítico: dupla rápida (80 / 60 / 80 ms) */
  PreAlert = 4,       /* "Estou bem": batidas que aceleram e crescem durante o pré-alerta */
  Heartbeat = 5,      /* pulso longo e suave (200 ms): está tudo funcionando */
  Confirm = 6,        /* confirmação curta: alerta cancelado, âncora criada, calibração concluída */
  Locate = 7,         /* "tocar buzzer" do painel: forte e alternado por alguns segundos */
};

enum HapticSide : uint8_t { HAPTIC_LEFT = 1, HAPTIC_RIGHT = 2, HAPTIC_BOTH = 3 };

struct HapticStep {
  uint16_t onMs;
  uint16_t offMs;
  uint8_t level; /* 0..255 */
};

struct HapticOutput {
  float left;
  float right;
};

struct HapticConfig {
  uint32_t preAlertMs; /* duração do padrão de pré-alerta (= PRE_ALERT_MS) */
  uint32_t locateMs;   /* duração do "localizar" (= LOCATE_MS) */
};

class HapticEngine {
 public:
  static const uint8_t MAX_STEPS = 24;

  explicit HapticEngine(const HapticConfig &cfg) : cfg_(cfg) {
    for (uint8_t i = 0; i < 2; i++) {
      fg_[i].pattern = HapticPattern::None;
      fg_[i].n = 0;
      fg_[i].start = 0;
      amb_[i].pattern = HapticPattern::None;
      amb_[i].closeness = 0;
      amb_[i].cycleStart = 0;
      amb_[i].cycleOn = 0;
      amb_[i].cycleLen = 0;
      amb_[i].cycleLevel = 0;
    }
  }

  /* prioridade: quanto maior, mais importante (pré-alerta não é interrompido por nada) */
  static uint8_t priority(HapticPattern p) {
    switch (p) {
      case HapticPattern::PreAlert: return 6;
      case HapticPattern::FastApproach: return 5;
      case HapticPattern::Confirm: return 4;
      case HapticPattern::Locate: return 3;
      case HapticPattern::StaticObstacle: return 2; /* só como teste do painel (primeiro plano) */
      case HapticPattern::Proximity: return 2;
      case HapticPattern::Heartbeat: return 1;
      default: return 0;
    }
  }

  /* toca um padrão de uma vez; devolve true se começou em pelo menos um lado */
  bool play(HapticPattern p, uint8_t sides, uint32_t nowMs) {
    if (p == HapticPattern::None) return false;
    bool started = false;
    for (uint8_t i = 0; i < 2; i++) {
      if (!(sides & (1 << i))) continue;
      Fg &f = fg_[i];
      if (active(f, nowMs) && priority(f.pattern) > priority(p)) continue;
      f.pattern = p;
      f.start = nowMs;
      f.n = build(p, f.steps);
      started = true;
    }
    return started;
  }

  /* para o padrão (se for esse que está tocando); HapticPattern::None para qualquer um */
  void stop(HapticPattern p, uint8_t sides = HAPTIC_BOTH) {
    for (uint8_t i = 0; i < 2; i++) {
      if (!(sides & (1 << i))) continue;
      if (p == HapticPattern::None || fg_[i].pattern == p) fg_[i].pattern = HapticPattern::None;
    }
  }

  /* fundo de um lado: None, StaticObstacle ou Proximity (closeness 0..1 = longe..colado) */
  void setAmbient(uint8_t side, HapticPattern p, float closeness) {
    uint8_t i = side == HAPTIC_RIGHT ? 1 : 0;
    if (p != HapticPattern::StaticObstacle && p != HapticPattern::Proximity) p = HapticPattern::None;
    amb_[i].pattern = p;
    amb_[i].closeness = closeness < 0 ? 0 : (closeness > 1 ? 1 : closeness);
  }

  HapticOutput tick(uint32_t nowMs) {
    HapticOutput o;
    o.left = level(0, nowMs);
    o.right = level(1, nowMs);
    return o;
  }

  HapticPattern playing(uint8_t side, uint32_t nowMs) const {
    const Fg &f = fg_[side == HAPTIC_RIGHT ? 1 : 0];
    return active(f, nowMs) ? f.pattern : HapticPattern::None;
  }

  /* duração total de um padrão de uma vez (ms) */
  uint32_t duration(HapticPattern p) const {
    HapticStep s[MAX_STEPS];
    uint8_t n = build(p, s);
    return total(s, n);
  }

  /* monta os passos de cada padrão */
  uint8_t build(HapticPattern p, HapticStep *s) const {
    uint8_t n = 0;
    switch (p) {
      case HapticPattern::StaticObstacle: /* teste pelo painel: 4 repetições */
        for (uint8_t i = 0; i < 4; i++) s[n++] = step(60, 700, 90);
        break;
      case HapticPattern::Proximity: /* teste pelo painel: acelerando de longe até colado */
        for (uint8_t i = 0; i < 8; i++) s[n++] = step(70, (uint16_t)(600 - i * 70), (uint8_t)(130 + i * 15));
        break;
      case HapticPattern::FastApproach:
        s[n++] = step(80, 60, 255);
        s[n++] = step(80, 0, 255);
        break;
      case HapticPattern::PreAlert: {
        /* batidas que aceleram (período 800 -> 250 ms) e crescem (50% -> 100%) até preAlertMs */
        uint32_t t = 0;
        while (n < MAX_STEPS && t < cfg_.preAlertMs) {
          float prog = (float)t / (float)cfg_.preAlertMs;
          uint16_t period = (uint16_t)(800 - prog * 550);
          if (t + period > cfg_.preAlertMs) period = (uint16_t)(cfg_.preAlertMs - t);
          uint16_t on = (uint16_t)(period * 2 / 5);
          s[n++] = step(on, (uint16_t)(period - on), (uint8_t)(128 + prog * 127));
          t += period;
        }
        break;
      }
      case HapticPattern::Heartbeat:
        s[n++] = step(200, 0, 100);
        break;
      case HapticPattern::Confirm:
        s[n++] = step(50, 60, 160);
        s[n++] = step(50, 0, 160);
        break;
      case HapticPattern::Locate: {
        uint32_t t = 0;
        while (n < MAX_STEPS && t + 300 <= cfg_.locateMs) {
          s[n++] = step(150, 150, 255);
          t += 300;
        }
        break;
      }
      default:
        break;
    }
    return n;
  }

 private:
  struct Fg {
    HapticPattern pattern;
    uint32_t start;
    HapticStep steps[MAX_STEPS];
    uint8_t n;
  };
  struct Amb {
    HapticPattern pattern;
    float closeness;
    uint32_t cycleStart; /* um ciclo (pulso + pausa) termina antes de mudar o ritmo */
    uint16_t cycleOn;
    uint16_t cycleLen;
    uint8_t cycleLevel;
  };

  static HapticStep step(uint16_t on, uint16_t off, uint8_t lvl) {
    HapticStep s;
    s.onMs = on;
    s.offMs = off;
    s.level = lvl;
    return s;
  }

  static uint32_t total(const HapticStep *s, uint8_t n) {
    uint32_t t = 0;
    for (uint8_t i = 0; i < n; i++) t += s[i].onMs + s[i].offMs;
    return t;
  }

  static bool active(const Fg &f, uint32_t nowMs) {
    return f.pattern != HapticPattern::None && nowMs - f.start < total(f.steps, f.n);
  }

  float level(uint8_t i, uint32_t nowMs) {
    Fg &f = fg_[i];
    if (f.pattern != HapticPattern::None) {
      uint32_t el = nowMs - f.start, t = 0;
      for (uint8_t k = 0; k < f.n; k++) {
        if (el < t + f.steps[k].onMs) return f.steps[k].level / 255.0f;
        t += f.steps[k].onMs + f.steps[k].offMs;
        if (el < t) return 0.0f;
      }
      f.pattern = HapticPattern::None; /* acabou: volta para o fundo */
      amb_[i].cycleLen = 0;            /* fundo recomeça com um pulso novo */
    }
    return ambient(i, nowMs);
  }

  float ambient(uint8_t i, uint32_t nowMs) {
    Amb &a = amb_[i];
    if (a.pattern == HapticPattern::None) {
      a.cycleLen = 0;
      return 0.0f;
    }
    if (a.cycleLen == 0 || nowMs - a.cycleStart >= a.cycleLen) {
      /* ciclo novo com o ritmo de agora */
      a.cycleStart = nowMs;
      if (a.pattern == HapticPattern::StaticObstacle) {
        a.cycleOn = 60;
        a.cycleLen = 760;
        a.cycleLevel = 90; /* suave */
      } else {
        a.cycleOn = 70;
        a.cycleLen = (uint16_t)(70 + 80 + (1.0f - a.closeness) * 520.0f);
        a.cycleLevel = (uint8_t)(128 + a.closeness * 127.0f);
      }
    }
    return nowMs - a.cycleStart < a.cycleOn ? a.cycleLevel / 255.0f : 0.0f;
  }

  HapticConfig cfg_;
  Fg fg_[2];
  Amb amb_[2];
};
