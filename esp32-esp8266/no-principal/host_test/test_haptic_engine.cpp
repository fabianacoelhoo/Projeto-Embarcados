/* Teste da linguagem háptica, rodando no PC (sem a placa).
 *
 *   g++ -std=c++11 -Wall -Wextra -I../include test_haptic_engine.cpp -o test_hap && ./test_hap
 *
 * A TaskHaptic chama tick() a cada HAPTIC_PERIOD_MS; aqui o tempo anda de 1 em 1 ms para medir
 * a duração exata de cada pulso. */
#include <cstdio>
#include <vector>

#include "config.h"
#include "haptic_engine.h"

static const HapticConfig CFG = {PRE_ALERT_MS, LOCATE_MS};

static int failures = 0, passed = 0;
static void check(bool ok, const char *name) {
  printf("%s %s\n", ok ? "ok  " : "FALHOU", name);
  if (ok) passed++; else failures++;
}

/* pulsos (início, duração, intensidade máxima) de um lado entre t0 e t1 */
struct Pulse { uint32_t start, len; float level; };
static std::vector<Pulse> pulses(HapticEngine &e, uint8_t side, uint32_t t0, uint32_t t1) {
  std::vector<Pulse> out;
  bool on = false;
  for (uint32_t t = t0; t < t1; t++) {
    HapticOutput o = e.tick(t);
    float v = side == HAPTIC_RIGHT ? o.right : o.left;
    if (v > 0 && !on) { out.push_back({t - t0, 0, v}); on = true; }
    if (v > 0) { out.back().len++; if (v > out.back().level) out.back().level = v; }
    if (v <= 0) on = false;
  }
  return out;
}

int main() {
  {
    HapticEngine e(CFG);
    e.setAmbient(HAPTIC_LEFT, HapticPattern::StaticObstacle, 0.5f);
    std::vector<Pulse> l = pulses(e, HAPTIC_LEFT, 0, 3040);
    std::vector<Pulse> r = pulses(e, HAPTIC_RIGHT, 3040, 6080);
    check(l.size() == 4 && l[0].len == 60 && l[1].start - l[0].start == 760, "obstaculo parado: 60 ms ligado / 700 ms desligado");
    check(l[0].level < 0.4f && r.empty(), "obstaculo parado: suave e so no lado dele");
  }
  {
    HapticEngine e(CFG);
    e.play(HapticPattern::FastApproach, HAPTIC_RIGHT, 100);
    std::vector<Pulse> p = pulses(e, HAPTIC_RIGHT, 100, 600);
    check(p.size() == 2 && p[0].len == 80 && p[1].start == 140 && p[1].len == 80 && p[0].level == 1.0f,
          "aproximacao rapida: 80 ms / 60 ms / 80 ms, forca total");
  }
  {
    /* prioridade: aproximação rápida passa por cima do fundo e depois o fundo volta */
    HapticEngine e(CFG);
    e.setAmbient(HAPTIC_LEFT, HapticPattern::StaticObstacle, 0);
    e.tick(0);
    e.play(HapticPattern::FastApproach, HAPTIC_LEFT, 200);
    std::vector<Pulse> p = pulses(e, HAPTIC_LEFT, 200, 1200);
    check(p.size() >= 3 && p[0].level == 1.0f && p[2].start >= 220 && p[2].level < 0.4f, "fundo pausa durante o padrao e volta depois");
  }
  {
    /* pré-alerta: acelera e cresce; nada de menor prioridade interrompe */
    HapticEngine e(CFG);
    e.play(HapticPattern::PreAlert, HAPTIC_BOTH, 0);
    bool heartbeat = e.play(HapticPattern::Heartbeat, HAPTIC_BOTH, 1000);
    bool fast = e.play(HapticPattern::FastApproach, HAPTIC_LEFT, 1500);
    std::vector<Pulse> p = pulses(e, HAPTIC_LEFT, 0, PRE_ALERT_MS + 500);
    uint32_t firstGap = p[1].start - p[0].start, lastGap = p.back().start - p[p.size() - 2].start;
    check(!heartbeat && !fast, "pre-alerta nao e interrompido por batimento nem por aproximacao");
    check(p.size() >= 8 && firstGap >= 700 && lastGap <= 350, "pre-alerta acelera (de ~800 ms para ~300 ms entre batidas)");
    check(p.back().level > p[0].level + 0.3f && p.back().start < PRE_ALERT_MS, "pre-alerta cresce e termina dentro dos 5 s");
  }
  {
    /* cancelar: para o pré-alerta e toca a confirmação */
    HapticEngine e(CFG);
    e.play(HapticPattern::PreAlert, HAPTIC_BOTH, 0);
    e.tick(1900);
    e.stop(HapticPattern::PreAlert);
    e.play(HapticPattern::Confirm, HAPTIC_BOTH, 2000);
    std::vector<Pulse> p = pulses(e, HAPTIC_RIGHT, 2000, 3000);
    check(p.size() == 2 && p[0].len == 50 && p[1].start == 110, "cancelado: confirmacao curta (2 toques de 50 ms)");
  }
  {
    HapticEngine e(CFG);
    e.play(HapticPattern::Heartbeat, HAPTIC_BOTH, 0);
    std::vector<Pulse> p = pulses(e, HAPTIC_LEFT, 0, 1000);
    check(p.size() == 1 && p[0].len == 200 && p[0].level < 0.5f, "batimento: um pulso longo (200 ms) e suave");
  }
  {
    /* fundo de aproximação: mais perto = pulsos mais frequentes e fortes, sem cortar o pulso no meio */
    HapticEngine e(CFG);
    e.setAmbient(HAPTIC_LEFT, HapticPattern::Proximity, 0.1f);
    std::vector<Pulse> far = pulses(e, HAPTIC_LEFT, 0, 3000);
    e.setAmbient(HAPTIC_LEFT, HapticPattern::Proximity, 0.95f);
    std::vector<Pulse> nearP = pulses(e, HAPTIC_LEFT, 3000, 6000);
    check(nearP.size() > far.size() * 2 && nearP.back().level > far.back().level, "aproximando: mais perto, mais rapido e mais forte");
    bool whole = true;
    for (size_t i = 0; i + 1 < nearP.size(); i++) if (nearP[i].len != 70) whole = false;
    check(whole, "pulsos do fundo sempre inteiros (70 ms) mesmo mudando a distancia");
  }
  {
    HapticEngine e(CFG);
    e.play(HapticPattern::Locate, HAPTIC_BOTH, 0);
    check(e.duration(HapticPattern::Locate) <= LOCATE_MS && e.duration(HapticPattern::Locate) >= LOCATE_MS - 300,
          "localizar dura o LOCATE_MS");
    check(e.playing(HAPTIC_LEFT, 100) == HapticPattern::Locate && e.playing(HAPTIC_LEFT, LOCATE_MS + 10) == HapticPattern::None,
          "padrao termina sozinho");
  }

  printf("\n%d de %d verificacoes passaram\n", passed, passed + failures);
  if (failures) return 1;
  printf("Todos os cenarios passaram\n");
  return 0;
}
