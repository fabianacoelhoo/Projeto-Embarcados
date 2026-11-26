/* Teste do pré-alerta "Estou bem", rodando no PC (sem a placa).
 *
 *   g++ -std=c++11 -Wall -Wextra -I../include test_alert_fsm.cpp -o test_fsm && ./test_fsm */
#include <cstdio>

#include "config.h"
#include "alert_fsm.h"

static int failures = 0;
static int passed = 0;
static void check(bool ok, const char *name) {
  printf("%s %s\n", ok ? "ok  " : "FALHOU", name);
  if (ok) passed++; else failures++;
}

/* avança o tempo de 5 em 5 ms (como a TaskImu) e conta as ações */
struct Count { int confirms = 0; int dismisses = 0; };
static Count advance(AlertFsm &fsm, uint32_t from, uint32_t to) {
  Count c;
  for (uint32_t t = from; t <= to; t += 5) {
    AlertAction a = fsm.tick(t);
    if (a == AlertAction::Confirm) c.confirms++;
    if (a == AlertAction::Dismiss) c.dismisses++;
  }
  return c;
}

int main() {
  /* 1. cancelado dentro dos 5 s */
  {
    AlertFsm fsm(PRE_ALERT_MS);
    bool opened = fsm.trigger(AlertCause::Fall, 3.5f, 70.0f, 1000);
    Count before = advance(fsm, 1000, 4000);
    AlertAction a = fsm.cancel(4000);
    Count after = advance(fsm, 4005, 12000);
    check(opened && fsm.state() == AlertState::Cancelled, "queda + clique aos 3 s: CANCELLED_BY_USER");
    check(a == AlertAction::Dismiss && fsm.pending().cause == AlertCause::Fall, "cancelamento manda DISMISSED com a causa queda");
    check(before.confirms == 0 && after.confirms == 0, "cancelado: o alerta nunca sai");
  }

  /* 2. sem clique: confirma uma única vez, quando o prazo acaba */
  {
    AlertFsm fsm(PRE_ALERT_MS);
    fsm.trigger(AlertCause::Impact, 4.1f, -1.0f, 2000);
    Count early = advance(fsm, 2000, 2000 + PRE_ALERT_MS - 5);
    Count late = advance(fsm, 2000 + PRE_ALERT_MS, 20000);
    check(early.confirms == 0, "batida: nada sai antes de 5 s");
    check(late.confirms == 1 && fsm.state() == AlertState::Confirmed, "batida sem clique: CONFIRMED_ALERT exatamente uma vez");
    check(fsm.cancel(9000) == AlertAction::None, "clique depois de confirmado nao faz nada");
  }

  /* 3. clique na hora exata em que o prazo acabou: confirma (não cancela tarde) */
  {
    AlertFsm fsm(PRE_ALERT_MS);
    fsm.trigger(AlertCause::Fall, 3.0f, 60.0f, 0);
    check(fsm.cancel(PRE_ALERT_MS) == AlertAction::Confirm, "clique aos 5,000 s: ja era alerta");
  }

  /* 4. vários eventos durante o pré-alerta: um só alerta, causa mais grave, maior pico, prazo mantido */
  {
    AlertFsm fsm(PRE_ALERT_MS);
    fsm.trigger(AlertCause::Impact, 3.2f, -1.0f, 1000);
    bool reopened = fsm.trigger(AlertCause::Fall, 2.6f, 80.0f, 2500);
    fsm.trigger(AlertCause::Impact, 5.4f, -1.0f, 4000);
    Count c = advance(fsm, 1000, 1000 + PRE_ALERT_MS + 2000);
    const PendingAlert &p = fsm.pending();
    check(!reopened && c.confirms == 1, "3 eventos em 5 s: um unico alerta");
    check(p.cause == AlertCause::Fall && p.value > 5.3f && p.count == 3, "alerta junta: causa queda, pico 5,4 g, 3 eventos");
    check(p.tilt > 79.0f && p.t == 1000, "guarda a inclinacao da queda e o tempo do primeiro evento");
  }
  {
    AlertFsm fsm(PRE_ALERT_MS);
    fsm.trigger(AlertCause::Impact, 3.2f, -1.0f, 0);
    Count c1 = advance(fsm, 0, PRE_ALERT_MS - 100);
    fsm.trigger(AlertCause::Impact, 3.3f, -1.0f, PRE_ALERT_MS - 100); /* pancada no fim: não adia */
    Count c2 = advance(fsm, PRE_ALERT_MS - 95, PRE_ALERT_MS);
    check(c1.confirms == 0 && c2.confirms == 1, "pancada no fim do pre-alerta nao adia o alerta");
  }

  /* 5. depois de cancelar, um evento novo abre outro pré-alerta */
  {
    AlertFsm fsm(PRE_ALERT_MS);
    fsm.trigger(AlertCause::Fall, 3.0f, 60.0f, 0);
    fsm.cancel(1000);
    bool opened = fsm.trigger(AlertCause::Impact, 3.5f, -1.0f, 8000);
    Count c = advance(fsm, 8000, 8000 + PRE_ALERT_MS);
    check(opened && c.confirms == 1 && fsm.pending().cause == AlertCause::Impact, "novo evento depois do cancelamento: novo pre-alerta");
    check(fsm.cancel(20000) == AlertAction::None && fsm.state() == AlertState::Confirmed, "clique sem pre-alerta: nada acontece");
  }

  /* 6. progresso (o aviso local acelera) */
  {
    AlertFsm fsm(PRE_ALERT_MS);
    fsm.trigger(AlertCause::Fall, 3.0f, 60.0f, 1000);
    float half = fsm.progress(1000 + PRE_ALERT_MS / 2);
    check(half > 0.49f && half < 0.51f && fsm.progress(0 + 999999) == 1.0f, "progresso vai de 0 a 1 no pre-alerta");
  }

  printf("\n%d de %d verificacoes passaram\n", passed, passed + failures);
  if (failures) return 1;
  printf("Todos os cenarios passaram\n");
  return 0;
}
