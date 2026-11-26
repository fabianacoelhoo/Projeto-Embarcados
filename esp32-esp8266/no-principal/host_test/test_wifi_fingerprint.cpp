/* Teste da assinatura de Wi-Fi (fallback interno do GPS), rodando no PC (sem a placa).
 *
 *   g++ -std=c++11 -Wall -Wextra -I../include test_wifi_fingerprint.cpp -o test_wfp && ./test_wfp */
#include <cstdio>
#include <cstring>
#include <string>

#include "config.h"
#include "wifi_fingerprint.h"

static const FingerprintConfig CFG = {WIFI_FP_GPS_LOST_MS, WIFI_FP_EVERY_MS, WIFI_FP_MIN_SATS};

static int failures = 0, passed = 0;
static void check(bool ok, const char *name) {
  printf("%s %s\n", ok ? "ok  " : "FALHOU", name);
  if (ok) passed++; else failures++;
}

static ApInfo ap(const char *bssid, int rssi, const char *ssid) {
  ApInfo a;
  snprintf(a.bssid, sizeof(a.bssid), "%s", bssid);
  a.rssi = (int8_t)rssi;
  snprintf(a.ssid, sizeof(a.ssid), "%s", ssid);
  return a;
}

/* quantas varreduras em [from, to) com o GPS como dado, passo de 1 s (ciclo de posição) */
static int scans(FingerprintScheduler &s, uint32_t from, uint32_t to, bool fix, uint32_t sats, uint32_t *first = nullptr) {
  int n = 0;
  for (uint32_t t = from; t < to; t += 1000) {
    if (s.shouldScan(t, fix, sats)) {
      if (!n && first) *first = t;
      n++;
    }
  }
  return n;
}

int main() {
  {
    FingerprintScheduler s(CFG);
    check(scans(s, 1000, 120000, true, 8) == 0, "GPS bom (8 satelites): nunca escaneia");
  }
  {
    FingerprintScheduler s(CFG);
    uint32_t first = 0;
    int n = scans(s, 1000, 121000, false, 0, &first);
    check(first == 1000 + WIFI_FP_GPS_LOST_MS, "sem GPS: primeira varredura depois de 15 s");
    check(n == 4, "sem GPS por 2 min: uma varredura a cada 30 s (4)");
  }
  {
    FingerprintScheduler s(CFG);
    int n = scans(s, 1000, 60000, true, 2);
    check(n == 2, "posicao com so 2 satelites conta como GPS ruim");
  }
  {
    FingerprintScheduler s(CFG);
    scans(s, 1000, 10000, false, 0);
    int n = scans(s, 10000, 60000, true, 6); /* GPS voltou antes dos 15 s */
    check(n == 0, "GPS voltou antes de 15 s: nao escaneia");
  }
  {
    FingerprintScheduler s(CFG);
    s.force();
    check(s.shouldScan(500, true, 9), "pedido manual (escanear agora) passa mesmo com GPS bom");
  }
  {
    ApInfo in[6] = {ap("AA:00:00:00:00:01", -80, "Vizinho"), ap("AA:00:00:00:00:02", -45, "Casa"),
                    ap("AA:00:00:00:00:03", -70, "Casa 5G"), ap("AA:00:00:00:00:02", -43, "Casa"),
                    ap("AA:00:00:00:00:04", -60, "CESAR"), ap("AA:00:00:00:00:05", -90, "Longe")};
    ApInfo out[3];
    uint8_t n = topAps(in, 6, out, 3);
    check(n == 3 && !strcmp(out[0].bssid, "AA:00:00:00:00:02") && out[0].rssi == -43 &&
              !strcmp(out[1].bssid, "AA:00:00:00:00:04") && !strcmp(out[2].bssid, "AA:00:00:00:00:03"),
          "top 3 por sinal, sem repetir BSSID (fica o sinal mais forte)");
    ApInfo two[3];
    check(topAps(in, 2, two, 3) == 2 && two[0].rssi == -45, "menos de 3 redes: devolve as que existem, ordenadas");
  }
  {
    ApInfo aps[2] = {ap("AA:BB:CC:DD:EE:FF", -58, "Rede \"Ana\"\\1"), ap("11:22:33:44:55:66", -71, "")};
    char buf[320];
    int len = fingerprintJson(buf, sizeof(buf), aps, 2, 12345);
    std::string s(buf);
    check(len > 0 && s == "{\"type\":\"wifi_fingerprint\",\"aps\":[{\"bssid\":\"AA:BB:CC:DD:EE:FF\",\"rssi\":-58,\"ssid\":\"Rede \\\"Ana\\\"\\\\1\"},"
                          "{\"bssid\":\"11:22:33:44:55:66\",\"rssi\":-71,\"ssid\":\"\"}],\"t\":12345}",
          "JSON da assinatura com aspas e barra escapadas");
    char tiny[40];
    check(fingerprintJson(tiny, sizeof(tiny), aps, 2, 1) == 0, "buffer pequeno: nao escreve JSON cortado");
  }

  printf("\n%d de %d verificacoes passaram\n", passed, passed + failures);
  if (failures) return 1;
  printf("Todos os cenarios passaram\n");
  return 0;
}
