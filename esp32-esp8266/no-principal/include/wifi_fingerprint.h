#pragma once
/* "Assinatura de Wi-Fi" para quando o GPS não pega (ambiente interno).
 *
 *  - FingerprintScheduler: decide quando escanear. Só com o GPS ruim (sem posição válida, ou menos de
 *    minSats satélites) há mais de lostMs, e no máximo uma vez a cada everyMs. Um pedido manual
 *    (painel: "escanear agora") passa na frente.
 *  - topAps(): as k redes com sinal mais forte (sem repetir BSSID).
 *  - fingerprintJson(): {"type":"wifi_fingerprint","aps":[{"bssid":"AA:BB:..","rssi":-58,"ssid":"Casa"}],"t":...}
 *    com o nome da rede escapado para JSON.
 *
 * C++ puro (sem Arduino/FreeRTOS), testado no PC em host_test/test_wifi_fingerprint.cpp. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

struct ApInfo {
  char bssid[18]; /* "AA:BB:CC:DD:EE:FF" */
  int8_t rssi;
  char ssid[33];
};

struct FingerprintConfig {
  uint32_t lostMs;  /* GPS ruim há pelo menos isso (15 s) */
  uint32_t everyMs; /* intervalo entre varreduras (30 s) */
  uint8_t minSats;  /* menos satélites que isso conta como GPS ruim (3) */
};

class FingerprintScheduler {
 public:
  explicit FingerprintScheduler(const FingerprintConfig &cfg)
      : cfg_(cfg), badSince_(0), lastScan_(0), bad_(false), scanned_(false), forced_(false) {}

  /* gpsFix = posição válida e recente; devolve true quando deve escanear agora */
  bool shouldScan(uint32_t nowMs, bool gpsFix, uint32_t sats) {
    bool good = gpsFix && sats >= cfg_.minSats;
    if (forced_) {
      forced_ = false;
      markScan(nowMs);
      return true;
    }
    if (good) {
      bad_ = false;
      return false;
    }
    if (!bad_) {
      bad_ = true;
      badSince_ = nowMs;
    }
    if (nowMs - badSince_ < cfg_.lostMs) return false;
    if (scanned_ && nowMs - lastScan_ < cfg_.everyMs) return false;
    markScan(nowMs);
    return true;
  }

  void force() { forced_ = true; }

 private:
  void markScan(uint32_t nowMs) {
    scanned_ = true;
    lastScan_ = nowMs;
  }

  FingerprintConfig cfg_;
  uint32_t badSince_, lastScan_;
  bool bad_, scanned_, forced_;
};

/* as k mais fortes, em ordem de sinal; BSSID repetido (mesma rede vista 2x) conta uma vez */
inline uint8_t topAps(const ApInfo *in, uint8_t n, ApInfo *out, uint8_t k) {
  uint8_t m = 0;
  for (uint8_t i = 0; i < n; i++) {
    bool dup = false;
    for (uint8_t j = 0; j < m; j++) {
      if (strcmp(out[j].bssid, in[i].bssid) == 0) {
        dup = true;
        if (in[i].rssi > out[j].rssi) {
          out[j].rssi = in[i].rssi;
          for (uint8_t q = j; q > 0 && out[q].rssi > out[q - 1].rssi; q--) {
            ApInfo t = out[q];
            out[q] = out[q - 1];
            out[q - 1] = t;
          }
        }
        break;
      }
    }
    if (dup) continue;
    if (m < k) {
      out[m++] = in[i];
    } else if (in[i].rssi > out[m - 1].rssi) {
      out[m - 1] = in[i];
    } else {
      continue;
    }
    /* mantém ordenado do mais forte para o mais fraco */
    for (uint8_t j = m - 1; j > 0 && out[j].rssi > out[j - 1].rssi; j--) {
      ApInfo t = out[j];
      out[j] = out[j - 1];
      out[j - 1] = t;
    }
  }
  return m;
}

/* escreve s escapado para JSON (aspas, barra invertida, controles); devolve quantos bytes escreveu */
inline size_t jsonEscapeTo(char *out, size_t len, const char *s) {
  size_t n = 0;
  for (; *s && n + 7 < len; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { out[n++] = '\\'; out[n++] = (char)c; }
    else if (c < 0x20) n += (size_t)snprintf(out + n, len - n, "\\u%04x", c);
    else out[n++] = (char)c;
  }
  if (n < len) out[n] = '\0';
  return n;
}

/* monta o JSON da assinatura; devolve o tamanho (0 se não coube) */
inline int fingerprintJson(char *buf, size_t len, const ApInfo *aps, uint8_t n, unsigned long t) {
  int w = snprintf(buf, len, "{\"type\":\"wifi_fingerprint\",\"aps\":[");
  if (w < 0 || (size_t)w >= len) return 0;
  for (uint8_t i = 0; i < n; i++) {
    char ssid[100];
    jsonEscapeTo(ssid, sizeof(ssid), aps[i].ssid);
    int k = snprintf(buf + w, len - w, "%s{\"bssid\":\"%s\",\"rssi\":%d,\"ssid\":\"%s\"}", i ? "," : "", aps[i].bssid,
                     aps[i].rssi, ssid);
    if (k < 0 || (size_t)(w + k) >= len) return 0;
    w += k;
  }
  int k = snprintf(buf + w, len - w, "],\"t\":%lu}", t);
  if (k < 0 || (size_t)(w + k) >= len) return 0;
  return w + k;
}
