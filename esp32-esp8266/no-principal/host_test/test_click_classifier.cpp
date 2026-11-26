/* Teste dos gestos do botão (1, 2 e 3 cliques), rodando no PC (sem a placa).
 *
 *   g++ -std=c++11 -Wall -Wextra -I../include test_click_classifier.cpp -o test_click && ./test_click
 *
 * A TaskButton chama click() quando um clique curto termina e tick() a cada ~20 ms. */
#include <cstdio>
#include <vector>

#include "config.h"
#include "click_classifier.h"

static int failures = 0, passed = 0;
static void check(bool ok, const char *name) {
  printf("%s %s\n", ok ? "ok  " : "FALHOU", name);
  if (ok) passed++; else failures++;
}

struct Out { ClickGesture g; uint32_t at; };
/* cliques nos instantes dados; roda até `until` com tick a cada 20 ms */
static std::vector<Out> run(ClickClassifier &c, const std::vector<uint32_t> &clicks, uint32_t until) {
  std::vector<Out> out;
  size_t k = 0;
  for (uint32_t t = 0; t <= until; t += 1) {
    if (k < clicks.size() && clicks[k] == t) {
      ClickGesture g = c.click(t);
      if (g != ClickGesture::None) out.push_back({g, t});
      k++;
    }
    if (t % 20 == 0) {
      ClickGesture g = c.tick(t);
      if (g != ClickGesture::None) out.push_back({g, t});
    }
  }
  return out;
}

int main() {
  {
    ClickClassifier c(CLICK_GAP_MS);
    std::vector<Out> o = run(c, {100}, 2000);
    check(o.size() == 1 && o[0].g == ClickGesture::Single && o[0].at > 100 + CLICK_GAP_MS && o[0].at <= 120 + CLICK_GAP_MS,
          "1 clique: troca de modo logo depois da janela (~0,45 s)");
  }
  {
    ClickClassifier c(CLICK_GAP_MS);
    std::vector<Out> o = run(c, {100, 350}, 2000);
    check(o.size() == 1 && o[0].g == ClickGesture::Double, "2 cliques em 250 ms: ancora rapida (sem trocar o modo)");
  }
  {
    ClickClassifier c(CLICK_GAP_MS);
    std::vector<Out> o = run(c, {100, 380, 640}, 2000);
    check(o.size() == 1 && o[0].g == ClickGesture::Triple && o[0].at == 640, "3 cliques: portal na hora do terceiro clique");
  }
  {
    ClickClassifier c(CLICK_GAP_MS);
    std::vector<Out> o = run(c, {100, 100 + CLICK_GAP_MS + 100}, 3000);
    check(o.size() == 2 && o[0].g == ClickGesture::Single && o[1].g == ClickGesture::Single,
          "2 cliques com pausa longa: dois cliques simples (duas trocas de modo)");
  }
  {
    ClickClassifier c(CLICK_GAP_MS);
    std::vector<Out> o = run(c, {100, 300, 500, 700, 900}, 3000);
    check(o.size() == 2 && o[0].g == ClickGesture::Triple && o[1].g == ClickGesture::Double,
          "5 cliques seguidos: portal (3) e depois ancora (2)");
  }
  {
    ClickClassifier c(CLICK_GAP_MS);
    c.click(100);
    c.reset(); /* clique longo (SOS) ou pre-alerta no meio */
    std::vector<Out> o = run(c, {}, 2000);
    check(o.empty() && c.pending() == 0, "reset descarta o clique pendente (nada de troca de modo atrasada)");
  }
  {
    /* sem tick entre os cliques (TaskButton ocupada): o clique velho não soma com o novo */
    ClickClassifier c(CLICK_GAP_MS);
    c.click(0);
    ClickGesture g1 = c.click(2000);
    ClickGesture g2 = c.tick(2000 + CLICK_GAP_MS + 1);
    check(g1 == ClickGesture::None && g2 == ClickGesture::Single, "clique vencido sem tick nao vira duplo");
  }

  printf("\n%d de %d verificacoes passaram\n", passed, passed + failures);
  if (failures) return 1;
  printf("Todos os cenarios passaram\n");
  return 0;
}
