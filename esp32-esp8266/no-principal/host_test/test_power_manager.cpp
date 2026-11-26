/* Teste da economia de energia guiada pelo MPU, rodando no PC (sem a placa).
 *
 *   g++ -std=c++11 -Wall -Wextra -I../include test_power_manager.cpp -o test_pwr && ./test_pwr
 *
 * Amostras a cada IMU_PERIOD_MS (200 Hz), como a TaskImu. O tempo para entrar em economia é
 * reduzido para 3 s (no firmware é POWER_IDLE_AFTER_MS = 120 s). */
#include <cmath>
#include <cstdio>
#include <functional>

#include "config.h"
#include "power_manager.h"

static const uint32_t IDLE_MS = 3000;
static const PowerConfig CFG = {POWER_MOTION_G, POWER_MOTION_STD_G, POWER_MOTION_GYRO_DPS, POWER_VAR_ALPHA, IDLE_MS};

static int failures = 0, passed = 0;
static void check(bool ok, const char *name) {
  printf("%s %s\n", ok ? "ok  " : "FALHOU", name);
  if (ok) passed++; else failures++;
}

struct Run {
  int enterIdle = 0;
  int wakes = 0;
  uint32_t idleAt = 0;   /* ms (relativo) da primeira entrada em economia */
  uint32_t wakeAt = 0;   /* ms (relativo) do primeiro acordar */
};
/* g(t), gyro(t) em ms relativos */
using Sig = std::function<float(uint32_t)>;
static Run run(PowerManager &pm, const Sig &g, const Sig &gyro, uint32_t ms, uint32_t t0) {
  Run r;
  for (uint32_t t = 0; t <= ms; t += IMU_PERIOD_MS) {
    PowerChange c = pm.update(g(t), gyro(t), t0 + t);
    if (c == PowerChange::EnterIdle && !r.enterIdle++) r.idleAt = t;
    if (c == PowerChange::Wake && !r.wakes++) r.wakeAt = t;
  }
  return r;
}
/* parado na mesa: ruído do sensor (~0,01 g, ~0,8 graus/s) */
static float still(uint32_t t) { return 1.0f + 0.008f * std::sin(t * 0.37f); }
static float gyroNoise(uint32_t t) { return 0.8f + 0.5f * std::sin(t * 0.11f); }

int main() {
  {
    PowerManager pm(CFG);
    Run r = run(pm, still, gyroNoise, 6000, 1000);
    check(r.enterIdle == 1 && r.idleAt >= IDLE_MS && r.idleAt <= IDLE_MS + 50, "parado: entra em economia depois do tempo configurado (uma vez)");
    check(pm.idle(), "continua em economia enquanto parado");
  }
  {
    /* andando: passos de ~1,3 g a cada 500 ms */
    PowerManager pm(CFG);
    Sig walk = [](uint32_t t) { return (t % 500) < 80 ? 1.3f : 0.95f; };
    Run r = run(pm, walk, gyroNoise, 10000, 1000);
    check(r.enterIdle == 0 && !pm.idle(), "andando por 10 s: nunca entra em economia");
  }
  {
    /* em economia, um passo acorda na mesma amostra */
    PowerManager pm(CFG);
    run(pm, still, gyroNoise, 4000, 0);
    Sig step = [](uint32_t t) { return t >= 1000 ? 1.25f : still(t); };
    Run r = run(pm, step, gyroNoise, 1200, 4005);
    check(r.wakes == 1 && r.wakeAt == 1000, "movimento acorda na primeira amostra (< 5 ms, bem abaixo de 50 ms)");
  }
  {
    /* girar o corpo sem mudar a aceleração também acorda */
    PowerManager pm(CFG);
    run(pm, still, gyroNoise, 4000, 0);
    Sig turn = [](uint32_t t) { return t >= 500 ? 40.0f : gyroNoise(t); };
    Run r = run(pm, still, turn, 600, 4005);
    check(r.wakes == 1 && r.wakeAt == 500, "giro de 40 graus/s acorda");
  }
  {
    /* clique no botão acorda e reinicia a contagem */
    PowerManager pm(CFG);
    run(pm, still, gyroNoise, 4000, 0);
    PowerChange c = pm.wake(4005);
    Run r = run(pm, still, gyroNoise, 2000, 4010);
    check(c == PowerChange::Wake && r.enterIdle == 0 && !pm.idle(), "clique acorda; volta a economizar so depois de mais 3 s parado");
    Run r2 = run(pm, still, gyroNoise, 2000, 6015);
    check(r2.enterIdle == 1, "parado de novo: volta para economia");
  }
  {
    /* tremor leve (balanço no ônibus): pequeno demais para o limiar de 1 g, mas o desvio padrão pega */
    PowerManager pm(CFG);
    Sig sway = [](uint32_t t) { return 1.0f + 0.05f * std::sin(t * 0.02f); };
    Run r = run(pm, sway, gyroNoise, 8000, 1000);
    check(r.enterIdle == 0, "balanco continuo de +-0,05 g: conta como movimento");
  }

  printf("\n%d de %d verificacoes passaram\n", passed, passed + failures);
  if (failures) return 1;
  printf("Todos os cenarios passaram\n");
  return 0;
}
