/* Teste da calibração assistida, rodando no PC (sem a placa).
 *
 *   g++ -std=c++11 -Wall -Wextra -I../include test_calibration.cpp -o test_cal && ./test_cal
 *
 * Gera 30 s de caminhada: aceleração a 200 Hz (IMU_PERIOD_MS) e ultrassônicos a ~10 Hz. */
#include <cmath>
#include <cstdio>
#include <functional>
#include <string>

#include "config.h"
#include "calibration.h"

static const CalibConfig CFG = {CAL_STEP_MIN_G,     CAL_STEP_REFRACTORY_MS, CAL_IMPACT_FACTOR, CAL_MIN_IMPACT_G,
                                CAL_MAX_IMPACT_G,   CAL_HYST_K,             CAL_HYST_MIN_CM,   CAL_HYST_MAX_CM,
                                CAL_MIN_STEPS,      CAL_MIN_ECHO_SAMPLES,   CAL_MAX_ECHO_JUMP_CM};
static const uint32_t DURATION = 30000;

static int failures = 0, passed = 0;
static void check(bool ok, const char *name) {
  printf("%s %s\n", ok ? "ok  " : "FALHOU", name);
  if (ok) passed++; else failures++;
}
static bool near(float a, float b, float tol) { return std::fabs(a - b) <= tol; }

/* ruído determinístico */
static float noise(uint32_t i, float amp) { return amp * std::sin(i * 2.399f) * std::cos(i * 0.731f); }

using Sig = std::function<float(uint32_t t)>;
/* passos de pico `peak` g a cada `periodMs`, cada um com 80 ms acima de 1 g */
static Sig walk(float peak, uint32_t periodMs) {
  return [=](uint32_t t) {
    uint32_t ph = t % periodMs;
    if (ph < 80) return 1.0f + (peak - 1.0f) * std::sin(3.14159f * ph / 80.0f);
    return 0.95f;
  };
}

static CalibResult run(const Sig &accel, const Sig &echoL, const Sig &echoR, float impactNow = IMPACT_G,
                       float hystNow = BUZZER_HYST_CM, uint32_t duration = DURATION) {
  Calibrator c(CFG);
  c.start(1000, duration);
  for (uint32_t t = 0; t <= duration + 100; t += IMU_PERIOD_MS) {
    uint32_t now = 1000 + t;
    c.addAccel(accel(t), now);
    if (t % 100 == 0) {
      c.addEcho(0, echoL(t));
      c.addEcho(1, echoR(t));
    }
    if (c.due(now)) return c.finish(impactNow, hystNow);
  }
  return c.finish(impactNow, hystNow);
}

int main() {
  /* Welford: média e desvio padrão iguais aos da fórmula direta */
  {
    Welford w;
    w.reset();
    const float xs[] = {1.2f, 1.4f, 1.3f, 1.5f, 1.1f};
    for (float x : xs) w.add(x);
    check(near((float)w.mean, 1.3f, 1e-5f) && near(w.stdDev(), 0.158114f, 1e-4f) && near(w.maxV, 1.5f, 1e-6f),
          "Welford: media 1,3, desvio 0,158 e maximo 1,5");
  }

  /* caminhada normal: passos de 1,45 g a cada 520 ms, corredor com paredes a 80/95 cm e eco com +-1,5 cm */
  {
    Sig echoL = [](uint32_t t) { return 80.0f + 10.0f * std::sin(t / 4000.0f) + noise(t / 100, 1.5f); };
    Sig echoR = [](uint32_t t) { return (t / 100) % 23 == 7 ? -1.0f : 95.0f + noise(t / 100 + 5, 1.0f); };
    CalibResult r = run(walk(1.45f, 520), echoL, echoR);
    check(r.status == CalibStatus::Done && r.steps >= 55 && r.steps <= 59, "30 s andando: ~57 passos contados");
    check(near(r.stepMax, 1.45f, 0.02f) && near(r.stepMean, 1.45f, 0.02f) && r.stepStd < 0.02f, "pico do passo: media e maximo 1,45 g");
    check(near(r.impactAfter, CAL_MIN_IMPACT_G, 0.001f), "limiar de batida = max(piso 2,5 g; 1,45 x 1,6 = 2,32) = 2,5 g");
    check(r.noiseL > 0.5f && r.noiseL < 2.5f && r.noiseR > 0.3f && r.noiseR < 2.0f,
          "ruido do eco medido pelas diferencas (a parede chegando perto nao conta)");
    check(r.hystAfter >= CAL_HYST_MIN_CM && r.hystAfter <= 8.0f, "histerese = 3 x ruido, dentro de 5..30 cm");
  }

  /* passada forte: pico 1,9 g -> 1,9 x 1,6 = 3,04 g */
  {
    Sig none = [](uint32_t) { return -1.0f; };
    CalibResult r = run(walk(1.9f, 600), none, none);
    check(r.status == CalibStatus::Done && near(r.impactAfter, 3.04f, 0.05f), "passada forte (1,9 g): limiar 3,04 g");
    check(std::string(r.reason) == "sem_eco" && r.hystAfter == r.hystBefore && r.noiseL < 0,
          "corredor sem eco: histerese fica como estava");
  }

  /* correu durante a calibração: pico 3,5 g -> 5,6 g, limitado ao teto */
  {
    Sig none = [](uint32_t) { return -1.0f; };
    CalibResult r = run(walk(3.5f, 350), none, none);
    check(near(r.impactAfter, CAL_MAX_IMPACT_G, 0.001f), "correu (3,5 g): limiar limitado ao teto");
  }

  /* ficou parado: falha e nada muda */
  {
    Sig still = [](uint32_t t) { return 1.0f + noise(t, 0.02f); };
    Sig wall = [](uint32_t t) { return 60.0f + noise(t / 100, 0.5f); };
    CalibResult r = run(still, wall, wall, 3.0f, 10.0f);
    check(r.status == CalibStatus::Failed && r.steps < CAL_MIN_STEPS && r.impactAfter == 3.0f && r.hystAfter == 10.0f,
          "parado 30 s: calibracao falha (poucos passos) e os limiares nao mudam");
  }

  /* eco muito ruidoso: histerese vai ao teto */
  {
    Sig jumpy = [](uint32_t t) { return 70.0f + noise(t / 100, 14.0f); };
    CalibResult r = run(walk(1.4f, 500), jumpy, jumpy);
    check(r.hystAfter >= 15.0f && r.hystAfter <= CAL_HYST_MAX_CM, "eco muito instavel: histerese alta (15 a 30 cm)");
  }

  /* pulsos rápidos demais (vibração) não contam como passos */
  {
    Calibrator c(CFG);
    c.start(0, 2000);
    for (uint32_t t = 0; t < 2000; t += IMU_PERIOD_MS) c.addAccel((t % 40) < 10 ? 1.3f : 1.0f, t);
    check(c.steps() <= 2000 / CAL_STEP_REFRACTORY_MS + 1, "vibracao de 25 Hz: no maximo 1 passo a cada 250 ms");
  }

  /* progresso e cancelamento */
  {
    Calibrator c(CFG);
    c.start(5000, 30000);
    bool mid = near(c.progress(20000), 0.5f, 0.001f);
    c.cancel();
    check(mid && !c.running() && !c.due(40000) && c.progress(20000) == 0.0f, "progresso 0..1 e cancelamento");
  }

  printf("\n%d de %d verificacoes passaram\n", passed, passed + failures);
  if (failures) return 1;
  printf("Todos os cenarios passaram\n");
  return 0;
}
