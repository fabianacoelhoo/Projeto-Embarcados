/* Teste da deteccao de queda e impacto, rodando no PC (sem a placa).
 *
 *   g++ -std=c++17 -Wall -Wextra -I../include test_imu_detector.cpp -o test_imu && ./test_imu
 *
 * Cada cenario gera o modulo da aceleracao (em g) amostrado a cada 10 ms,
 * igual a TaskImu do firmware, com os mesmos limiares do config.h. */
#include <cstdio>
#include <functional>
#include <vector>

#include "config.h"
#include "imu_detector.h"

static const ImuDetectorConfig CFG = {FREEFALL_G, FREEFALL_MIN_MS, FALL_WINDOW_MS, FALL_IMPACT_G,
                                      IMPACT_G,   IMU_PEAK_WINDOW_MS, IMU_EVENT_COOLDOWN_MS};

struct Result {
  int falls = 0;
  int impacts = 0;
  float lastPeak = 0;
};

/* signal(t_ms) -> g; roda por durationMs com passo de IMU_PERIOD_MS */
static Result run(const std::function<float(uint32_t)> &signal, uint32_t durationMs) {
  ImuDetector det(CFG);
  Result r;
  for (uint32_t t = 0; t <= durationMs; t += IMU_PERIOD_MS) {
    float peak;
    ImuEvent e = det.update(signal(t), 5000 + t, peak);
    if (e == ImuEvent::Fall) { r.falls++; r.lastPeak = peak; }
    if (e == ImuEvent::Impact) { r.impacts++; r.lastPeak = peak; }
  }
  return r;
}

static int failures = 0;
static void expect(const char *name, const Result &r, int falls, int impacts, float minPeak = 0) {
  bool ok = r.falls == falls && r.impacts == impacts && r.lastPeak >= minPeak;
  printf("%s %-46s quedas=%d impactos=%d pico=%.2f g\n", ok ? "[OK]  " : "[FALHA]", name, r.falls, r.impacts, r.lastPeak);
  if (!ok) failures++;
}

int main() {
  /* parado: so a gravidade */
  expect("parado (1 g)", run([](uint32_t) { return 1.0f; }, 3000), 0, 0);

  /* andando/correndo: oscila entre 0,6 e 1,8 g */
  expect("andando (0,6-1,8 g)", run([](uint32_t t) { return 1.2f + 0.6f * sinf(t * 0.012f); }, 5000), 0, 0);

  /* queda: 300 ms em queda livre e impacto de 3,5 g com pico em 30 ms */
  expect("queda (queda livre + impacto 3,5 g)",
         run([](uint32_t t) {
           if (t < 1000) return 1.0f;
           if (t < 1300) return 0.2f;
           if (t < 1310) return 2.4f;
           if (t < 1330) return 3.5f;
           if (t < 1350) return 2.0f;
           return 1.0f;
         }, 3000), 1, 0, 3.4f);

  /* queda em cima de algo macio: impacto so de 2,2 g, ainda e queda */
  expect("queda com impacto fraco (2,2 g)",
         run([](uint32_t t) {
           if (t < 1000) return 1.0f;
           if (t < 1250) return 0.3f;
           if (t < 1290) return 2.2f;
           return 1.0f;
         }, 3000), 1, 0, 2.1f);

  /* batida sem queda: pico de 4 g por 30 ms */
  expect("batida (4 g, sem queda livre)",
         run([](uint32_t t) { return (t >= 1000 && t < 1030) ? 4.0f : 1.0f; }, 3000), 0, 1, 3.9f);

  /* pancada leve: 2,5 g sem queda livre nao e evento */
  expect("pancada leve (2,5 g)", run([](uint32_t t) { return (t >= 1000 && t < 1030) ? 2.5f : 1.0f; }, 3000), 0, 0);

  /* tropeco: queda livre curta demais (40 ms) e 2,5 g: nao e queda */
  expect("tropeco (40 ms sem peso + 2,5 g)",
         run([](uint32_t t) {
           if (t >= 1000 && t < 1040) return 0.3f;
           if (t >= 1040 && t < 1070) return 2.5f;
           return 1.0f;
         }, 3000), 0, 0);

  /* pulo: queda livre longa mas aterrissagem suave (1,6 g) */
  expect("pulo com aterrissagem suave (1,6 g)",
         run([](uint32_t t) {
           if (t >= 1000 && t < 1300) return 0.2f;
           if (t >= 1300 && t < 1400) return 1.6f;
           return 1.0f;
         }, 3000), 0, 0);

  /* impacto chega tarde demais (1,5 s depois da queda livre): conta so como batida */
  expect("impacto 1,5 s depois da queda livre",
         run([](uint32_t t) {
           if (t >= 1000 && t < 1200) return 0.2f;
           if (t >= 2700 && t < 2730) return 3.5f;
           return 1.0f;
         }, 4000), 0, 1);

  /* duas pancadas seguidas (0,5 s): um evento so por causa do cooldown */
  expect("duas batidas em 0,5 s (cooldown)",
         run([](uint32_t t) {
           if (t >= 1000 && t < 1030) return 4.0f;
           if (t >= 1500 && t < 1530) return 4.0f;
           return 1.0f;
         }, 3000), 0, 1);

  /* duas pancadas separadas por 5 s: dois eventos */
  expect("duas batidas em 5 s",
         run([](uint32_t t) {
           if (t >= 1000 && t < 1030) return 4.0f;
           if (t >= 6000 && t < 6030) return 4.0f;
           return 1.0f;
         }, 8000), 0, 2);

  /* inclinacao */
  const float upright[3] = {0, 0, 1};
  float t0 = tiltFromReferenceDeg(upright, 0, 0, 1);
  float t90 = tiltFromReferenceDeg(upright, 1, 0, 0);
  float t45 = tiltFromReferenceDeg(upright, 0.7071f, 0, 0.7071f);
  bool tiltOk = fabsf(t0) < 0.5f && fabsf(t90 - 90) < 0.5f && fabsf(t45 - 45) < 0.5f;
  printf("%s %-46s 0=%.1f 45=%.1f 90=%.1f graus\n", tiltOk ? "[OK]  " : "[FALHA]", "inclinacao", t0, t45, t90);
  if (!tiltOk) failures++;

  printf(failures ? "\n%d cenario(s) falharam\n" : "\nTodos os cenarios passaram\n", failures);
  return failures ? 1 : 0;
}
