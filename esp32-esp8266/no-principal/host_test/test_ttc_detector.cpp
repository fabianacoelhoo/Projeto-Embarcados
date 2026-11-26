/* Teste do detector de colisão por TTC, rodando no PC (sem a placa).
 *
 *   g++ -std=c++11 -Wall -Wextra -I../include test_ttc_detector.cpp -o test_ttc && ./test_ttc
 *
 * Cada cenário gera leituras de um HC-SR04 a cada PERIOD_MS (o ciclo da TaskSensors: período +
 * intervalo entre os dois lados + o próprio eco, ~100 ms) com os limiares do config.h. */
#include <cmath>
#include <cstdio>
#include <functional>

#include "config.h"
#include "ttc_detector.h"

static const TtcConfig CFG = {TTC_V_MIN_CM_S, TTC_CRITICAL_S,      TTC_MAX_DIST_CM, TTC_CLOSE_CM,
                              TTC_CLOSE_SAMPLES, TTC_STATIC_MAX_CM, TTC_COOLDOWN_MS, TTC_CONFIRM_SAMPLES,
                              TTC_MAX_GAP_MS,  TTC_DROPOUT_RESET};
static const uint32_t PERIOD_MS = 100;

static int failures = 0;
static int passed = 0;
static void check(bool ok, const char *name) {
  printf("%s %s\n", ok ? "ok  " : "FALHOU", name);
  if (ok) passed++; else failures++;
}

struct Run {
  int reports = 0;
  int critical = 0;
  int staticSamples = 0;
  float maxV = 0;
  uint32_t firstReportMs = 0;
  TtcReason lastReason = TtcReason::None;
};

/* ruído determinístico (sem rand, para o teste dar sempre o mesmo resultado) */
static float noise(uint32_t i, float amp) {
  return amp * std::sin(i * 2.399f) * std::cos(i * 0.731f);
}

using Signal = std::function<float(uint32_t i, uint32_t tMs)>;
static Run run(TtcDetector &det, const Signal &sig, uint32_t samples, uint32_t t0 = 10000) {
  Run r;
  for (uint32_t i = 0; i < samples; i++) {
    uint32_t t = t0 + i * PERIOD_MS;
    TtcResult x = det.update(sig(i, t - t0), t);
    if (x.velocityCmS > r.maxV) r.maxV = x.velocityCmS;
    if (x.level == TtcLevel::Critical) r.critical++;
    if (x.level == TtcLevel::Static) r.staticSamples++;
    if (x.report) {
      if (!r.reports) r.firstReportMs = t - t0;
      r.reports++;
      r.lastReason = x.reason;
    }
  }
  return r;
}

int main() {
  /* 1. andando paralelo a uma parede a 40 cm: ruído de +-4 cm e falhas de eco de vez em quando */
  {
    TtcDetector det(CFG);
    Run r = run(det, [](uint32_t i, uint32_t) { return (i % 17 == 5) ? -1.0f : 40.0f + noise(i, 4.0f); }, 600);
    check(r.reports == 0 && r.critical == 0, "parede paralela a 40 cm por 60 s: nenhum critico");
    check(r.staticSamples > 500, "parede paralela: classificada como obstaculo estatico (so aviso local)");
  }

  /* 2. aproximação rápida: parado a 120 cm, depois 120 -> 60 cm em 0,5 s */
  {
    TtcDetector det(CFG);
    run(det, [](uint32_t i, uint32_t) { return 120.0f + noise(i, 1.0f); }, 20);
    Run r = run(det, [](uint32_t, uint32_t t) { return t >= 500 ? 60.0f : 120.0f - 120.0f * (t / 1000.0f); }, 8,
                12000);
    check(r.reports == 1 && r.lastReason == TtcReason::Ttc, "120 -> 60 cm em 0,5 s: critico por TTC");
    check(r.reports == 1 && r.firstReportMs <= 600, "aproximacao rapida: dispara ate 100 ms depois de chegar a 60 cm");
  }

  /* 3. falha de leitura (0 ou timeout) e volta a 50 cm: sem pico falso de velocidade */
  {
    TtcDetector det(CFG);
    run(det, [](uint32_t, uint32_t) { return 50.0f; }, 10);
    Run r = run(det, [](uint32_t i, uint32_t) {
      if (i == 3) return 0.0f;     /* pulseIn devolveu 0 */
      if (i == 4) return -1.0f;    /* timeout */
      if (i == 9) return 400.5f;   /* fora da faixa */
      if (i == 12) return 260.0f;  /* eco espúrio isolado (válido, mas absurdo) */
      return 50.0f;
    }, 30, 11000);
    check(r.reports == 0 && r.maxV < TTC_V_MIN_CM_S, "falhas e eco espurio a 50 cm: velocidade fica abaixo de 15 cm/s");
  }

  /* 3b. sumiu por 1 s (janela zerada) e voltou já a 50 cm: não calcula velocidade com a leitura antiga */
  {
    TtcDetector det(CFG);
    run(det, [](uint32_t, uint32_t) { return 140.0f; }, 10);
    Run r = run(det, [](uint32_t i, uint32_t) { return i < 10 ? -1.0f : 50.0f; }, 30, 11000);
    check(r.reports == 0 && r.maxV < TTC_V_MIN_CM_S, "140 cm, 1 s sem eco, volta a 50 cm: sem critico falso");
  }

  /* 4. perto demais e parado: <= 25 cm por 3 leituras seguidas */
  {
    TtcDetector det(CFG);
    Run r = run(det, [](uint32_t i, uint32_t) { return i < 2 ? 22.0f : (i == 2 ? -1.0f : 22.0f); }, 6);
    check(r.reports == 1 && r.lastReason == TtcReason::Close, "22 cm parado: critico depois de 3 leituras validas seguidas");
  }
  {
    TtcDetector det(CFG);
    Run r = run(det, [](uint32_t i, uint32_t) { return (i % 2) ? 22.0f : 30.0f; }, 40);
    check(r.reports == 0, "alternando 22/30 cm: nunca 3 seguidas, nenhum critico");
  }

  /* 5. cooldown por lado, independente */
  {
    TtcDetector left(CFG), right(CFG);
    Signal close = [](uint32_t, uint32_t) { return 20.0f; };
    Signal far = [](uint32_t, uint32_t) { return 200.0f; };
    Run l = run(left, close, 60);   /* 6 s colado no lado esquerdo */
    Run r1 = run(right, far, 20);
    Run r2 = run(right, close, 5, 12000);
    check(l.reports == 2, "6 s parado a 20 cm: 2 ocorrencias (uma a cada 3 s)");
    check(r1.reports == 0 && r2.reports == 1, "lado direito tem cooldown proprio: dispara mesmo com o esquerdo em cooldown");

    TtcDetector again(CFG);
    run(again, close, 4);                                          /* dispara em t=200 ms */
    Run back = run(again, far, 10, 10400);                         /* afastou */
    Run soon = run(again, close, 5, 11400);                        /* voltou 1,2 s depois: ainda em cooldown */
    Run later = run(again, close, 5, 13400);                       /* 3,2 s depois do primeiro */
    check(back.reports == 0 && soon.reports == 0 && later.reports == 1, "voltou antes de 3 s: espera o cooldown; depois dispara");
  }

  /* 6. afastando rápido: velocidade negativa nunca vira critico */
  {
    TtcDetector det(CFG);
    Run r = run(det, [](uint32_t, uint32_t t) { return 40.0f + 150.0f * (t / 1000.0f); }, 10);
    check(r.reports == 0, "afastando a 150 cm/s: nenhum critico");
  }

  /* 7. aproximação lenta (8 cm/s) de 100 para 60 cm: parado para o detector, só aviso local */
  {
    TtcDetector det(CFG);
    Run r = run(det, [](uint32_t, uint32_t t) { return 100.0f - 8.0f * (t / 1000.0f); }, 50);
    check(r.reports == 0, "aproximacao lenta (8 cm/s): sem ocorrencia");
  }

  printf("\n%d de %d cenarios passaram\n", passed, passed + failures);
  if (failures) return 1;
  printf("Todos os cenarios passaram\n");
  return 0;
}
