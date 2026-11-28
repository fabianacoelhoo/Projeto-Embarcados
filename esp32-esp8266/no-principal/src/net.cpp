#include <Arduino.h>
#include "config.h"
#include "net.h"

#if ENABLE_MQTT
#include "wifi_fingerprint.h"
#include <DNSServer.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiUdp.h>

/*----------------------------------------------------- configuracao (NVS) */
struct NetConfig {
  char ssid[33];
  char pass[65];
  char host[40]; /* "auto" = descobre o servidor sozinho; ou IP fixo */
  uint16_t port;
  char id[24];
};

static NetConfig cfg;   /* em uso (salva na flash) */
static NetConfig trial; /* em teste: so vira cfg se conectar */
static const char *CH_NAMES[CH_COUNT] = {"telemetry", "events", "location", "imu", "status", "pong", "diag", "calib", "wifi"};
static char topics[CH_COUNT][64];
static char cmdTopic[64];
static char clientId[40];
static char apName[33];

static void copyStr(char *dst, size_t len, const char *src) {
  strncpy(dst, src ? src : "", len - 1);
  dst[len - 1] = '\0';
}

static bool isPlaceholder(const char *s) { return s[0] == '\0' || strcmp(s, "SUA_REDE_WIFI") == 0; }
static bool configured() { return cfg.ssid[0] != '\0'; }
static bool isAuto(const char *host) { return host[0] == '\0' || strcmp(host, "auto") == 0; }
static bool brokerAuto() { return isAuto(cfg.host); }
static char serverRequest[40] = "";   /* troca de servidor pedida pelo painel, aplicada no netService */
static void setServer(const char *host);

/* Prioridade das credenciais:
   1. o que foi salvo na flash (NVS) pelo painel, pelo portal ou pela Serial;
   2. o secrets.h, so quando a NVS esta vazia (padrao gravado junto com o firmware).
   Se a rede escolhida nao conectar em NET_PORTAL_AFTER_FAIL_MS (15 s), o portal abre sozinho
   e a Serial continua aceitando comandos: o EchoMap nunca fica preso numa rede errada. */
static void loadConfig() {
  copyStr(cfg.ssid, sizeof(cfg.ssid), isPlaceholder(WIFI_SSID) ? "" : WIFI_SSID);
  copyStr(cfg.pass, sizeof(cfg.pass), isPlaceholder(WIFI_SSID) ? "" : WIFI_PASSWORD);
  copyStr(cfg.host, sizeof(cfg.host), MQTT_BROKER_IP);
  cfg.port = MQTT_BROKER_PORT;
  copyStr(cfg.id, sizeof(cfg.id), DEVICE_ID);

  Preferences p;
  if (p.begin("echomap", true)) {
    if (p.isKey("ssid")) p.getString("ssid", cfg.ssid, sizeof(cfg.ssid));
    if (p.isKey("pass")) p.getString("pass", cfg.pass, sizeof(cfg.pass));
    if (p.isKey("host")) p.getString("host", cfg.host, sizeof(cfg.host));
    if (p.isKey("port")) cfg.port = p.getUShort("port", cfg.port);
    if (p.isKey("id")) p.getString("id", cfg.id, sizeof(cfg.id));
    p.end();
  }
  if (cfg.id[0] == '\0') copyStr(cfg.id, sizeof(cfg.id), DEVICE_ID);
}

static void saveConfig() {
  Preferences p;
  if (!p.begin("echomap", false)) return;
  p.putString("ssid", cfg.ssid);
  p.putString("pass", cfg.pass);
  p.putString("host", cfg.host);
  p.putUShort("port", cfg.port);
  p.putString("id", cfg.id);
  p.end();
}

/*----------------------------------------------------- estado */
static WiFiClient tcp;
static PubSubClient mqtt(tcp);
static WiFiUDP udp;
static WebServer *web = nullptr;
static DNSServer *dns = nullptr;
static NetCommandHandler cmdHandler = nullptr;

static bool wifiWasUp = false;
static uint32_t lastWifiAttempt = 0;
static uint32_t wifiDownSince = 0;
static uint32_t lastMqttAttempt = 0;
static uint8_t mqttFails = 0;
static bool udpListening = false;
static bool brokerKnown = false;
static IPAddress brokerIp;
static uint16_t brokerPort = MQTT_BROKER_PORT;
static uint32_t lastDiscoveryLog = 0;

static bool portal = false;
static bool portalAuto = false; /* aberto sozinho por falha de rede: fecha sozinho se a rede voltar */
static volatile bool portalRequested = false;
static volatile bool statusRequested = false; /* status sai na hora (comando "status" ou mudanca de rede) */
static bool forgetRequested = false;
static bool testStartRequested = false; /* o teste comeca no netService, fora do callback do MQTT */
static uint32_t portalLastActivity = 0;
static uint32_t portalCloseAt = 0;
static uint32_t restartAt = 0;

/* teste de rede nova */
enum TestState : uint8_t { TEST_IDLE, TEST_RUNNING, TEST_OK, TEST_FAIL };
static TestState testState = TEST_IDLE;
static uint32_t testStart = 0;
static uint32_t testDoneAt = 0;
static bool testSawDown = false; /* so aceita "conectado" depois de ver a desconexao da rede antiga */
static char testMsg[120] = "";
static volatile uint8_t discReason = 0; /* motivo da ultima desconexao (evento do Wi-Fi) */
static char lastErr[8] = "";            /* "senha", "rede", "tempo", "falha" */

/* eventos que nao chegaram ao servidor (reenviados ao reconectar; o servidor descarta duplicatas pelo "t") */
static char pending[PENDING_EVENTS_MAX][112];
static uint8_t pendingHead = 0, pendingCount = 0;

static void queueEvent(const char *json) {
  uint8_t idx = (pendingHead + pendingCount) % PENDING_EVENTS_MAX;
  if (pendingCount == PENDING_EVENTS_MAX) {
    pendingHead = (pendingHead + 1) % PENDING_EVENTS_MAX; /* cheio: descarta o mais antigo */
  } else {
    pendingCount++;
  }
  copyStr(pending[idx], sizeof(pending[idx]), json);
}

static void flushEvents() {
  while (pendingCount > 0 && mqtt.connected()) {
    if (!mqtt.publish(topics[CH_EVENTS], pending[pendingHead])) break;
    pendingHead = (pendingHead + 1) % PENDING_EVENTS_MAX;
    pendingCount--;
  }
}

/*----------------------------------------------------- motivos de falha do Wi-Fi */
static void onWifiDisconnected(WiFiEvent_t event, WiFiEventInfo_t info) {
  (void)event;
  uint8_t r = info.wifi_sta_disconnected.reason;
  if (r != WIFI_REASON_ASSOC_LEAVE) discReason = r; /* ASSOC_LEAVE = nos mesmos pedimos para sair */
}

static const char *reasonCode(uint8_t r) {
  switch (r) {
    case 0: return "tempo";
    case WIFI_REASON_NO_AP_FOUND: return "rede";
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_AUTH_EXPIRE:
      return "senha";
    default: return "falha";
  }
}

static const char *errText(const char *code) {
  if (strcmp(code, "senha") == 0) return "senha incorreta";
  if (strcmp(code, "rede") == 0) return "rede nao encontrada (fora do alcance ou e de 5 GHz)";
  if (strcmp(code, "tempo") == 0) return "a rede nao respondeu a tempo";
  return "nao foi possivel conectar";
}

/*----------------------------------------------------- servidor (broker) */
static void rememberBroker() {
  Preferences p;
  if (!p.begin("echomap", false)) return;
  /* buffers fixos (sem String): roda a cada conexao MQTT, por horas */
  char ip[16], old[16] = "";
  snprintf(ip, sizeof(ip), "%u.%u.%u.%u", brokerIp[0], brokerIp[1], brokerIp[2], brokerIp[3]);
  p.getString("lastip", old, sizeof(old));
  if (strcmp(old, ip) != 0 || p.getUShort("lastport", 0) != brokerPort) {
    p.putString("lastip", ip);
    p.putUShort("lastport", brokerPort);
  }
  p.end();
}

static void applyBroker() {
  brokerKnown = false;
  mqttFails = 0;
  lastMqttAttempt = 0;
  brokerPort = cfg.port;
  if (!isAuto(cfg.host)) {
    brokerKnown = brokerIp.fromString(cfg.host);
    if (!brokerKnown) Serial.printf("[NET] Servidor \"%s\" nao e um IP valido. Use \"auto\" ou um IP.\n", cfg.host);
    return;
  }
  /* auto: comeca pelo ultimo servidor achado (conecta na hora); se nao responder, procura de novo */
  Preferences p;
  if (p.begin("echomap", true)) {
    char ip[16] = "";
    p.getString("lastip", ip, sizeof(ip));
    uint16_t port = p.getUShort("lastport", cfg.port);
    p.end();
    if (ip[0] && brokerIp.fromString(ip)) {
      brokerKnown = true;
      brokerPort = port;
    }
  }
}

/*----------------------------------------------------- portal de configuracao */
static void startPortal(const char *reason, bool automatic = false);
static void stopPortal();
static void markDirty() { statusRequested = true; }

/* le "campo":"texto" (com \" e \\) ou "campo":numero de um JSON simples, sem biblioteca */
static bool jsonField(const char *json, const char *key, char *out, size_t len) {
  char pat[24];
  snprintf(pat, sizeof(pat), "\"%s\":", key);
  const char *p = strstr(json, pat);
  if (!p) return false;
  p += strlen(pat);
  while (*p == ' ') p++;
  size_t n = 0;
  if (*p == '"') {
    for (p++; *p && *p != '"' && n + 1 < len; p++) {
      if (*p == '\\' && p[1]) p++;
      out[n++] = *p;
    }
  } else {
    while (*p && n + 1 < len && *p != ',' && *p != '}' && *p != ' ') out[n++] = *p++;
  }
  out[n] = '\0';
  return true;
}

/* comeca o teste de uma rede nova; so salva se conectar. Campos vazios mantem o atual. */
static bool tryWifi(const char *ssid, const char *pass, const char *host, const char *port, const char *id, const char *from) {
  if (!ssid || !ssid[0] || strlen(ssid) > 32) {
    copyStr(testMsg, sizeof(testMsg), "Nome de rede invalido.");
    testState = TEST_FAIL;
    testDoneAt = millis();
    return false;
  }
  if (pass && pass[0] && (strlen(pass) < 8 || strlen(pass) > 63)) {
    copyStr(testMsg, sizeof(testMsg), "A senha do Wi-Fi precisa ter de 8 a 63 caracteres.");
    testState = TEST_FAIL;
    testDoneAt = millis();
    return false;
  }
  trial = cfg;
  bool sameNet = strcmp(ssid, cfg.ssid) == 0;
  copyStr(trial.ssid, sizeof(trial.ssid), ssid);
  if ((pass && pass[0]) || !sameNet) copyStr(trial.pass, sizeof(trial.pass), pass ? pass : "");
  if (host && host[0]) copyStr(trial.host, sizeof(trial.host), host);
  if (port && port[0]) {
    long v = atol(port);
    if (v > 0 && v < 65536) trial.port = (uint16_t)v;
  }
  if (id && id[0]) copyStr(trial.id, sizeof(trial.id), id);

  testState = TEST_RUNNING;
  testStart = millis();
  testMsg[0] = '\0';
  testStartRequested = true;
  markDirty();
  Serial.printf("[NET] Testando a rede \"%s\" (pedido %s)...\n", trial.ssid, from);
  return true;
}

static void beginTest() {
  testStartRequested = false;
  testStart = millis();
  testSawDown = false;
  discReason = 0;
  if (mqtt.connected()) mqtt.disconnect();
  tcp.stop();
  WiFi.disconnect();
  WiFi.begin(trial.ssid, trial.pass);
}

static void forgetWifiNow() {
  Preferences p;
  if (p.begin("echomap", false)) {
    p.putString("ssid", "");
    p.putString("pass", "");
    p.end();
  }
  cfg.ssid[0] = cfg.pass[0] = '\0';
  if (mqtt.connected()) mqtt.disconnect();
  WiFi.disconnect();
  Serial.println("[NET] Rede esquecida.");
  startPortal("rede esquecida");
}

static void printNetStatus() {
  Serial.printf("[NET] Rede: %s | Wi-Fi: %s", configured() ? cfg.ssid : "(nenhuma)",
                WiFi.status() == WL_CONNECTED ? "conectado" : "desconectado");
  if (WiFi.status() == WL_CONNECTED) Serial.printf(" (IP %s, sinal %d dBm)", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  Serial.printf(" | Servidor: %s", mqtt.connected() ? brokerIp.toString().c_str() : (brokerAuto() ? "procurando (auto)" : cfg.host));
  Serial.printf(" | Portal: %s | ID: %s", portal ? apName : "fechado", cfg.id);
  if (lastErr[0]) Serial.printf(" | Ultimo erro: %s", errText(lastErr));
  Serial.println();
}

static void handleCommandJson(const char *json, bool fromMqtt) {
  char cmd[24];
  if (!jsonField(json, "cmd", cmd, sizeof(cmd))) return;

  if (strcmp(cmd, "ping") == 0) {
    /* responde na hora: o servidor mede o tempo de ida e volta */
    char id[16] = "0";
    jsonField(json, "id", id, sizeof(id));
    char out[64];
    snprintf(out, sizeof(out), "{\"pong\":%s,\"t\":%lu}", id, (unsigned long)millis());
    if (fromMqtt) mqtt.publish(topics[CH_PONG], out);
    else Serial.println(out);
  } else if (strcmp(cmd, "portal") == 0) {
    netRequestPortal();
  } else if (strcmp(cmd, "wifi") == 0) {
    char ssid[40] = "", pass[72] = "", host[40] = "", port[8] = "", id[24] = "";
    jsonField(json, "ssid", ssid, sizeof(ssid));
    jsonField(json, "pass", pass, sizeof(pass));
    jsonField(json, "host", host, sizeof(host));
    jsonField(json, "port", port, sizeof(port));
    jsonField(json, "id", id, sizeof(id));
    tryWifi(ssid, pass, host, port, id, fromMqtt ? "do painel pelo Wi-Fi" : "pela Serial/USB");
  } else if (strcmp(cmd, "server") == 0) {
    /* fica para o netService: trocar de servidor desconecta o MQTT, e isso nao pode ser dentro do callback */
    if (!jsonField(json, "host", serverRequest, sizeof(serverRequest)) || !serverRequest[0]) copyStr(serverRequest, sizeof(serverRequest), "auto");
  } else if (strcmp(cmd, "forget") == 0) {
    forgetRequested = true;
  } else if (strcmp(cmd, "netstatus") == 0 || strcmp(cmd, "status") == 0) {
    statusRequested = true;
  } else if (cmdHandler) {
    cmdHandler(cmd, json);
  }
}

static void onMqttMessage(char *topic, uint8_t *payload, unsigned int length) {
  (void)topic;
  /* copia antes de qualquer publish: o payload aponta para o buffer da PubSubClient */
  char json[256];
  size_t n = length < sizeof(json) - 1 ? length : sizeof(json) - 1;
  memcpy(json, payload, n);
  json[n] = '\0';
  handleCommandJson(json, true);
}

/* "wifi Minha Rede senha" ou wifi "Minha Rede" "senha com espaco" */
static int nextToken(const char *&p, char *out, size_t len) {
  while (*p == ' ') p++;
  size_t n = 0;
  if (*p == '"') {
    for (p++; *p && *p != '"' && n + 1 < len; p++) out[n++] = *p;
    if (*p == '"') p++;
  } else {
    while (*p && *p != ' ' && n + 1 < len) out[n++] = *p++;
  }
  out[n] = '\0';
  return (int)n;
}

void netHandleLine(const char *line) {
  while (*line == ' ') line++;
  if (!*line) return;
  if (*line == '{') {
    handleCommandJson(line, false);
    return;
  }
  if (strncmp(line, "wifi ", 5) == 0) {
    const char *p = line + 5;
    char ssid[40], pass[72];
    nextToken(p, ssid, sizeof(ssid));
    nextToken(p, pass, sizeof(pass));
    /* sem aspas e com 3+ palavras: tudo menos a ultima e o nome da rede */
    if (*line && strchr(line + 5, '"') == nullptr) {
      const char *last = strrchr(line + 5, ' ');
      if (last && last > line + 5 && (size_t)(last - (line + 5)) < sizeof(ssid)) {
        size_t sl = last - (line + 5);
        memcpy(ssid, line + 5, sl);
        ssid[sl] = '\0';
        copyStr(pass, sizeof(pass), last + 1);
      }
    }
    tryWifi(ssid, pass, "", "", "", "pela Serial");
  } else if (strcmp(line, "portal") == 0) {
    netRequestPortal();
  } else if (strcmp(line, "esquecer") == 0) {
    forgetRequested = true;
  } else if (strcmp(line, "status") == 0) {
    statusRequested = true; /* o main imprime o status completo em JSON (o painel le pelo USB) */
  } else if (strcmp(line, "rede") == 0) {
    printNetStatus();
  } else if (strncmp(line, "servidor ", 9) == 0) {
    setServer(line + 9);
  } else if (!(cmdHandler && cmdHandler(line, nullptr))) {
    Serial.println("[NET] Comandos: wifi \"rede\" \"senha\" | status (JSON) | rede | portal | esquecer | servidor auto|<IP> | sensores");
  }
}

static const char PORTAL_HTML[] PROGMEM = R"HTML(<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">%REFRESH%<title>EchoMap · Wi-Fi</title>
<style>
:root{--ink:#15201e;--mute:#66726f;--line:#dbe2df;--bg:#f3f5f4;--acc:#0e7c73;--bad:#c23434;--good:#1d8152}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
main{max-width:420px;margin:0 auto;padding:28px 20px 40px}h1{font-size:24px;margin:0 0 4px}p{margin:0 0 18px;color:var(--mute)}
label{display:block;font-size:14px;font-weight:700;margin:16px 0 6px}small{display:block;color:var(--mute);font-size:13px;margin-top:6px}
input{width:100%;font:inherit;padding:12px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink)}
button{width:100%;margin-top:22px;padding:14px;border:0;border-radius:10px;background:var(--acc);color:#fff;font:inherit;font-weight:700}
.row{display:flex;gap:10px}.row>div{flex:1}
.st{margin:0 0 18px;padding:14px;border-radius:10px;background:#fff;border:1px solid var(--line)}
.st.ok{border-color:var(--good);color:var(--good)}.st.bad{border-color:var(--bad);color:var(--bad)}.st b{color:var(--ink)}
.nets{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.nets button{width:auto;margin:0;padding:6px 12px;background:#fff;color:var(--ink);border:1px solid var(--line);font-weight:400;font-size:14px}
details{margin-top:18px}summary{cursor:pointer;color:var(--acc)}
</style></head><body><main>
<h1>Conectar o EchoMap</h1><p>Escolha a rede Wi-Fi da casa (2,4 GHz) e digite a senha.</p>
<div class="st %STCLASS%">%STATUS%</div>
<form method="post" action="/save">
<label for="ssid">Rede Wi-Fi</label><input id="ssid" name="ssid" value="%SSID%" autocomplete="off" autocapitalize="none" required>
<div class="nets" id="nets"></div><small id="scan">Procurando redes por perto...</small>
<label for="pass">Senha</label><input id="pass" name="pass" type="password" placeholder="%PASSHINT%">
<details><summary>Opções avançadas</summary>
<label for="host">Servidor</label><input id="host" name="host" value="%HOST%"><small><b>auto</b> encontra sozinho o computador do painel na mesma rede.</small>
<div class="row"><div><label for="port">Porta</label><input id="port" name="port" inputmode="numeric" value="%PORT%"></div>
<div><label for="id">ID do dispositivo</label><input id="id" name="id" value="%ID%" pattern="[A-Za-z0-9_-]{1,23}"></div></div>
</details>
<button type="submit">Testar e salvar</button></form>
<script>
function scan(){fetch('/scan').then(r=>r.json()).then(d=>{if(d.scanning){setTimeout(scan,1500);return}
const box=document.getElementById('nets');box.innerHTML='';d.nets.forEach(n=>{const b=document.createElement('button');b.type='button';
b.textContent=n.ssid+(n.rssi>-67?'':' (sinal fraco)');b.onclick=()=>{document.getElementById('ssid').value=n.ssid;document.getElementById('pass').focus()};box.appendChild(b)});
document.getElementById('scan').textContent=d.nets.length?'Toque numa rede para escolher.':'Nenhuma rede de 2,4 GHz encontrada por perto.';}).catch(()=>{})}
scan();
</script></main></body></html>)HTML";

static String htmlEscape(const char *s) {
  String o;
  for (; *s; s++) {
    if (*s == '<') o += "&lt;";
    else if (*s == '>') o += "&gt;";
    else if (*s == '"') o += "&quot;";
    else if (*s == '&') o += "&amp;";
    else o += *s;
  }
  return o;
}

static void handleRoot() {
  portalLastActivity = millis();
  String page = FPSTR(PORTAL_HTML);
  String status, cls, refresh;
  if (testState == TEST_RUNNING) {
    status = "Testando a rede <b>" + htmlEscape(trial.ssid) + "</b>... (até 20 s; esta página atualiza sozinha)";
    refresh = "<meta http-equiv=\"refresh\" content=\"3\">";
  } else if (testState == TEST_OK) {
    status = "Pronto! " + htmlEscape(testMsg) + " Pode voltar o celular para a sua rede.";
    cls = "ok";
  } else if (testState == TEST_FAIL) {
    status = "Não conectou: " + htmlEscape(testMsg) + " Confira e tente de novo.";
    cls = "bad";
  } else if (WiFi.status() == WL_CONNECTED) {
    status = "Conectado em <b>" + htmlEscape(WiFi.SSID().c_str()) + "</b>" + (mqtt.connected() ? ", painel encontrado." : ", procurando o painel.");
    cls = "ok";
  } else {
    status = configured() ? "Sem conexão com <b>" + htmlEscape(cfg.ssid) + "</b>" + (lastErr[0] ? String(": ") + errText(lastErr) + "." : String(".")) : String("Nenhuma rede configurada ainda.");
  }
  page.replace("%REFRESH%", refresh);
  page.replace("%STCLASS%", cls);
  page.replace("%STATUS%", status);
  page.replace("%SSID%", htmlEscape(testState == TEST_FAIL ? trial.ssid : cfg.ssid));
  page.replace("%PASSHINT%", cfg.pass[0] ? "deixe em branco para manter a atual" : "");
  page.replace("%HOST%", htmlEscape(cfg.host[0] ? cfg.host : "auto"));
  page.replace("%PORT%", String(cfg.port));
  page.replace("%ID%", htmlEscape(cfg.id));
  web->send(200, "text/html; charset=utf-8", page);
}

static void handleScan() {
  portalLastActivity = millis();
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_FAILED) {
    WiFi.scanNetworks(true);
    n = WIFI_SCAN_RUNNING;
  }
  if (n == WIFI_SCAN_RUNNING) {
    web->send(200, "application/json", "{\"scanning\":true}");
    return;
  }
  /* ordena pelo sinal e tira repetidas (o mesmo nome em varios roteadores) */
  int order[24];
  int count = 0;
  for (int i = 0; i < n && count < 24; i++) {
    String s = WiFi.SSID(i);
    if (s.length() == 0) continue;
    bool dup = false;
    for (int k = 0; k < count; k++) dup = dup || WiFi.SSID(order[k]) == s;
    if (!dup) order[count++] = i;
  }
  for (int a = 1; a < count; a++)
    for (int b = a; b > 0 && WiFi.RSSI(order[b]) > WiFi.RSSI(order[b - 1]); b--) {
      int t = order[b];
      order[b] = order[b - 1];
      order[b - 1] = t;
    }
  /* JSON num buffer fixo (sem concatenar String): ate 15 redes com o nome escapado */
  static char out[1600];
  char esc[72];
  size_t w = (size_t)snprintf(out, sizeof(out), "{\"nets\":[");
  for (int k = 0; k < count && k < 15 && w < sizeof(out); k++) {
    jsonEscapeTo(esc, sizeof(esc), WiFi.SSID(order[k]).c_str());
    w += (size_t)snprintf(out + w, sizeof(out) - w, "%s{\"ssid\":\"%s\",\"rssi\":%d}", k ? "," : "", esc, (int)WiFi.RSSI(order[k]));
  }
  if (w < sizeof(out)) snprintf(out + w, sizeof(out) - w, "]}");
  WiFi.scanDelete();
  web->send(200, "application/json", out);
}

static void handleSave() {
  portalLastActivity = millis();
  tryWifi(web->arg("ssid").c_str(), web->arg("pass").c_str(), web->arg("host").c_str(), web->arg("port").c_str(),
          web->arg("id").c_str(), "pelo portal");
  web->sendHeader("Location", "/", true);
  web->send(303, "text/plain", "");
}

static void handleCaptive() {
  /* qualquer endereco (testes de captive portal do Android/iOS/Windows) cai na pagina de configuracao */
  web->sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
  web->send(302, "text/plain", "");
}

static void startPortal(const char *reason, bool automatic) {
  if (portal) return;
  portal = true;
  portalAuto = automatic;
  markDirty();
  portalLastActivity = millis();
  portalCloseAt = 0;
  snprintf(apName, sizeof(apName), "EchoMap-%s", cfg.id);

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName, PORTAL_PASSWORD);
  dns = new DNSServer();
  dns->start(53, "*", WiFi.softAPIP());
  web = new WebServer(80);
  web->on("/", HTTP_GET, handleRoot);
  web->on("/scan", HTTP_GET, handleScan);
  web->on("/save", HTTP_POST, handleSave);
  web->onNotFound(handleCaptive);
  web->begin();
  WiFi.scanNetworks(true);

  Serial.printf("[NET] Portal aberto (%s): no celular, entre na rede \"%s\" (senha %s); a pagina abre sozinha "
                "(ou abra http://%s).\n",
                reason, apName, PORTAL_PASSWORD, WiFi.softAPIP().toString().c_str());
}

static void stopPortal() {
  if (!portal) return;
  web->stop();
  delete web;
  web = nullptr;
  dns->stop();
  delete dns;
  dns = nullptr;
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  portal = false;
  portalAuto = false;
  markDirty();
  Serial.println("[NET] Portal fechado.");
}

/*----------------------------------------------------- descoberta do servidor */
/* o painel anuncia {"echomap":1,"mqtt":1883,...} por broadcast UDP; o IP de quem
   mandou e o servidor. Sem digitar IP e sem quebrar quando o IP do PC muda. */
/* ouviu o anuncio do painel? devolve o IP e a porta MQTT de quem anunciou */
static bool hearAnnounce(IPAddress &ip, uint16_t &port) {
  if (!udpListening) udpListening = udp.begin(NET_DISCOVERY_PORT);
  int size = udp.parsePacket();
  if (size <= 0) return false;
  char buf[160];
  int n = udp.read((uint8_t *)buf, sizeof(buf) - 1);
  buf[n > 0 ? n : 0] = '\0';
  if (!strstr(buf, "\"echomap\"")) return false;
  char p[8];
  ip = udp.remoteIP();
  port = jsonField(buf, "mqtt", p, sizeof(p)) ? (uint16_t)atoi(p) : cfg.port;
  return true;
}

static void pollDiscovery() {
  IPAddress ip;
  uint16_t port;
  if (!hearAnnounce(ip, port)) {
    if (millis() - lastDiscoveryLog >= 10000) {
      lastDiscoveryLog = millis();
      Serial.println("[NET] Procurando o painel na rede (o npm start precisa estar rodando na mesma rede)...");
    }
    return;
  }
  brokerIp = ip;
  brokerPort = port;
  brokerKnown = true;
  lastMqttAttempt = 0;
  Serial.printf("[NET] Painel encontrado em %s:%u.\n", brokerIp.toString().c_str(), brokerPort);
}

/* troca o servidor (painel, Serial): "auto" ou um IP; salvo na flash */
static void setServer(const char *host) {
  copyStr(cfg.host, sizeof(cfg.host), host && host[0] ? host : "auto");
  saveConfig();
  applyBroker();
  if (mqtt.connected()) mqtt.disconnect();
  tcp.stop();
  markDirty();
  Serial.printf("[NET] Servidor agora: %s\n", cfg.host);
}

/*----------------------------------------------------- teste de rede nova */
static void serviceTest(uint32_t now) {
  bool up = WiFi.status() == WL_CONNECTED;
  if (!up) testSawDown = true;
  if (up && testSawDown && WiFi.SSID() == trial.ssid) {
    bool idChanged = strcmp(trial.id, cfg.id) != 0;
    cfg = trial;
    saveConfig();
    applyBroker();
    testState = TEST_OK;
    testDoneAt = now;
    lastErr[0] = '\0';
    wifiWasUp = false; /* deixa o fluxo normal anunciar e conectar no servidor */
    snprintf(testMsg, sizeof(testMsg), "Conectado em \"%s\" (IP %s).", cfg.ssid, WiFi.localIP().toString().c_str());
    Serial.printf("[NET] Rede nova ok e salva: %s\n", testMsg);
    markDirty();
    if (idChanged) restartAt = now + 3000; /* topicos novos: reinicia */
    if (portal) portalCloseAt = now + 30000; /* da tempo do celular ver o "Pronto!" */
    return;
  }
  bool failedFast = discReason != 0 && now - testStart > 2500;
  if (!failedFast && now - testStart < NET_TEST_TIMEOUT_MS) return;

  const char *code = reasonCode(discReason);
  copyStr(lastErr, sizeof(lastErr), code);
  snprintf(testMsg, sizeof(testMsg), "%s na rede \"%s\".", errText(code), trial.ssid);
  testMsg[0] = (char)toupper(testMsg[0]);
  testState = TEST_FAIL;
  testDoneAt = now;
  markDirty();
  Serial.printf("[NET] A rede nova nao conectou: %s Continuando com a anterior.\n", testMsg);
  WiFi.disconnect();
  lastWifiAttempt = wifiDownSince = now;
  if (configured()) {
    /* com o celular no portal, a volta para a rede anterior fica com o ciclo normal (sem trocar de canal agora) */
    if (!(portal && WiFi.softAPgetStationNum() > 0)) WiFi.begin(cfg.ssid, cfg.pass);
  } else if (!portal) {
    startPortal("rede nova nao conectou", true);
  }
}

/*----------------------------------------------------- API */
void netOnCommand(NetCommandHandler handler) { cmdHandler = handler; }
void netRequestPortal() { portalRequested = true; }
bool netPortalActive() { return portal; }
bool netTesting() { return testState == TEST_RUNNING; }
bool netTakeStatusRequest() {
  if (!statusRequested) return false;
  statusRequested = false;
  return true;
}
bool netMqttConnected() { return mqtt.connected(); }
const char *netDeviceId() { return cfg.id; }

void netBegin(bool forcePortal) {
  loadConfig();
  for (int i = 0; i < CH_COUNT; i++) snprintf(topics[i], sizeof(topics[i]), "%s/%s/%s", MQTT_TOPIC_PREFIX, cfg.id, CH_NAMES[i]);
  snprintf(cmdTopic, sizeof(cmdTopic), "%s/%s/cmd", MQTT_TOPIC_PREFIX, cfg.id);
  snprintf(clientId, sizeof(clientId), "echomap-%s-%06lX", cfg.id, (unsigned long)(ESP.getEfuseMac() & 0xFFFFFF));
  snprintf(apName, sizeof(apName), "EchoMap-%s", cfg.id);

  WiFi.persistent(false);     /* a configuracao fica no NVS do EchoMap, nao na do SDK */
  WiFi.setHostname(clientId); /* no core 2.0.x precisa vir antes do mode() */
  WiFi.mode(WIFI_STA);
  WiFi.onEvent(onWifiDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
#if NET_LOW_LATENCY
  /* o modem-sleep padrao atrasa pacotes em 100-300 ms; desligado, o radio responde na hora
     (custo: ~+80 mA). Para economizar bateria use NET_LOW_LATENCY 0. */
  WiFi.setSleep(false);
#endif

  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(768); /* status com nomes de rede longos */
  mqtt.setSocketTimeout(MQTT_SOCKET_TIMEOUT_S);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
  applyBroker();

  if (configured()) {
    WiFi.begin(cfg.ssid, cfg.pass);
    lastWifiAttempt = wifiDownSince = millis();
    Serial.printf("[NET] Conectando em \"%s\" (servidor: %s)...\n", cfg.ssid,
                  brokerAuto() ? (brokerKnown ? "auto, tentando o ultimo achado" : "auto") : cfg.host);
  }
  if (!configured() || forcePortal) startPortal(configured() ? "botao no boot" : "nenhuma rede configurada", !configured());
  Serial.println("[NET] Dica: para trocar de rede, digite aqui  wifi \"nome da rede\" \"senha\"  ou de 3 cliques no botao (abre o portal).");
}

static volatile bool powerSaveWanted = false;
static bool powerSaveApplied = false;
void netSetPowerSave(bool save) { powerSaveWanted = save; }
bool netJsonField(const char *json, const char *key, char *out, size_t len) { return jsonField(json, key, out, len); }

/*----------------------------------------------------- assinatura de Wi-Fi (GPS sem sinal) */
static volatile bool scanWanted = false;
static bool scanRunning = false;
static uint32_t scanStartedAt = 0;
static char scanJson[360];
static volatile bool scanReady = false;

void netRequestWifiScan() { scanWanted = true; }

int netTakeWifiScan(char *buf, size_t len) {
  if (!scanReady) return 0;
  size_t n = strlen(scanJson);
  scanReady = false;
  if (n + 1 > len) return 0;
  memcpy(buf, scanJson, n + 1);
  return (int)n;
}

/* varredura passiva e assincrona: o radio visita os canais entre os pacotes da conexao atual,
   entao o MQTT continua conectado; o resultado chega em alguns netService() depois */
static void serviceWifiScan(uint32_t now) {
  if (scanWanted && !scanRunning) {
    scanWanted = false;
    if (portal || testState == TEST_RUNNING) return; /* o radio esta ocupado com outra coisa */
    int16_t r = WiFi.scanNetworks(true, false, true, WIFI_FP_SCAN_MS_PER_CHAN);
    if (r == WIFI_SCAN_FAILED) {
      Serial.println("[WIFI-FP] A varredura nao comecou; tento na proxima.");
      return;
    }
    scanRunning = true;
    scanStartedAt = now;
  }
  if (!scanRunning) return;
  int16_t n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) {
    if (now - scanStartedAt > WIFI_FP_SCAN_TIMEOUT_MS) {
      WiFi.scanDelete();
      scanRunning = false;
    }
    return;
  }
  scanRunning = false;
  if (n < 0) {
    WiFi.scanDelete();
    return;
  }
  static ApInfo all[20];
  uint8_t m = 0;
  for (int16_t i = 0; i < n && m < 20; i++, m++) {
    snprintf(all[m].bssid, sizeof(all[m].bssid), "%s", WiFi.BSSIDstr(i).c_str());
    all[m].rssi = (int8_t)WiFi.RSSI(i);
    snprintf(all[m].ssid, sizeof(all[m].ssid), "%s", WiFi.SSID(i).c_str());
  }
  WiFi.scanDelete();
  ApInfo top[WIFI_FP_TOP];
  uint8_t k = topAps(all, m, top, WIFI_FP_TOP);
  if (fingerprintJson(scanJson, sizeof(scanJson), top, k, (unsigned long)now) > 0) scanReady = true;
}

void netService() {
  uint32_t now = millis();

  /* economia de energia pedida pela TaskImu: modem-sleep (WIFI_PS_MIN_MODEM via WiFi.setSleep(true)),
     que mantem a associacao e o keep-alive do MQTT; ao acordar, volta ao modo de baixa latencia */
  bool wantSave = powerSaveWanted;
  if (wantSave != powerSaveApplied) {
    powerSaveApplied = wantSave;
    WiFi.setSleep(wantSave || !NET_LOW_LATENCY);
    markDirty();
  }
  serviceWifiScan(now);

  if (portalRequested) {
    portalRequested = false;
    startPortal("pedido pelo botao, painel ou Serial");
  }
  if (forgetRequested) {
    forgetRequested = false;
    forgetWifiNow();
  }
  if (testStartRequested) beginTest();
  if (serverRequest[0]) {
    char h[40];
    copyStr(h, sizeof(h), serverRequest);
    serverRequest[0] = '\0';
    setServer(h);
  }
  if (portal) {
    dns->processNextRequest();
    web->handleClient();
    if (WiFi.softAPgetStationNum() > 0) portalLastActivity = now;
    if (portalCloseAt && (int32_t)(now - portalCloseAt) >= 0) stopPortal();
    else if (configured() && testState != TEST_RUNNING && now - portalLastActivity > PORTAL_TIMEOUT_MS) stopPortal();
  }
  if (restartAt && (int32_t)(now - restartAt) >= 0) ESP.restart();
  /* resultado do teste fica visivel por 1 min no painel e no portal */
  if ((testState == TEST_OK || testState == TEST_FAIL) && now - testDoneAt > 60000) testState = TEST_IDLE;

  if (testState == TEST_RUNNING) {
    serviceTest(millis()); /* o teste pode ter comecado agora mesmo, depois de "now" */
    return;
  }
  if (!configured()) return;

  if (WiFi.status() != WL_CONNECTED) {
    if (wifiWasUp) {
      wifiWasUp = false;
      wifiDownSince = now;
      udpListening = false;
      markDirty();
      Serial.println("[NET] Wi-Fi caiu. Tentando reconectar...");
    }
    /* com alguem no portal, nao troca de canal (derrubaria o celular conectado) */
    bool someoneInPortal = portal && WiFi.softAPgetStationNum() > 0;
    if (!someoneInPortal && now - lastWifiAttempt >= WIFI_RETRY_MS) {
      if (discReason) copyStr(lastErr, sizeof(lastErr), reasonCode(discReason));
      if (lastErr[0]) Serial.printf("[NET] Sem conexao com \"%s\": %s.\n", cfg.ssid, errText(lastErr));
      lastWifiAttempt = now;
      discReason = 0;
      WiFi.disconnect();
      WiFi.begin(cfg.ssid, cfg.pass);
    }
    if (!portal && now - wifiDownSince >= NET_PORTAL_AFTER_FAIL_MS) {
      Serial.printf("[NET] \"%s\" nao conectou em %u s%s%s. Abrindo o portal; a Serial continua aceitando comandos.\n", cfg.ssid,
                    (unsigned)(NET_PORTAL_AFTER_FAIL_MS / 1000), lastErr[0] ? ": " : "", lastErr[0] ? errText(lastErr) : "");
      startPortal("Wi-Fi nao conecta", true);
    }
    return;
  }

  if (!wifiWasUp) {
    wifiWasUp = true;
    lastErr[0] = '\0';
    lastMqttAttempt = 0;
    markDirty();
    /* o portal tinha aberto so porque a rede falhou: a rede voltou e ninguem esta nele, fecha */
    if (portal && portalAuto && WiFi.softAPgetStationNum() == 0) stopPortal();
    Serial.printf("[NET] Wi-Fi ok: \"%s\", IP %s, sinal %d dBm, canal %d.\n", cfg.ssid, WiFi.localIP().toString().c_str(),
                  WiFi.RSSI(), WiFi.channel());
  }

  if (mqtt.connected()) {
    mqtt.loop();
    if (pendingCount) flushEvents(); /* alerta que nao saiu numa tentativa sai na proxima volta, sem esperar reconectar */
    return;
  }

  if (brokerAuto() && !brokerKnown) {
    pollDiscovery();
    return;
  }
  if (!brokerKnown) return;

  /* IP fixo que nao responde (ex.: o PC mudou de rede): se o painel se anunciar em outro endereco,
     passa para "auto" sozinho, em vez de ficar preso no IP antigo */
  if (!brokerAuto() && mqttFails >= 3) {
    IPAddress ip;
    uint16_t port;
    if (hearAnnounce(ip, port) && (uint32_t)ip != (uint32_t)brokerIp) {
      Serial.printf("[NET] O servidor fixo %s nao responde; o painel se anunciou em %s. Passando para \"auto\".\n",
                    brokerIp.toString().c_str(), ip.toString().c_str());
      copyStr(cfg.host, sizeof(cfg.host), "auto");
      saveConfig();
      brokerIp = ip;
      brokerPort = port;
      mqttFails = 0;
      lastMqttAttempt = 0;
      markDirty();
    }
  }
  if (lastMqttAttempt != 0 && now - lastMqttAttempt < MQTT_RETRY_MS) return;
  lastMqttAttempt = now ? now : 1;

  /* TCP com tempo limite curto antes do connect() da PubSubClient (que reaproveita o socket) */
  if (!tcp.connected() && !tcp.connect(brokerIp, brokerPort, MQTT_CONNECT_TIMEOUT_MS)) {
    Serial.printf("[NET] Painel %s:%u nao respondeu.\n", brokerIp.toString().c_str(), brokerPort);
    ++mqttFails;
    if (brokerAuto() && mqttFails >= 2) brokerKnown = false; /* o PC pode ter trocado de IP: procura de novo */
    return;
  }
  tcp.setNoDelay(true); /* sem algoritmo de Nagle: cada mensagem pequena sai na hora */
  mqtt.setServer(brokerIp, brokerPort);
  if (mqtt.connect(clientId)) {
    mqttFails = 0;
    mqtt.subscribe(cmdTopic);
    if (brokerAuto()) rememberBroker(); /* no proximo boot conecta direto, sem esperar o anuncio */
    markDirty();
    Serial.printf("[NET] Conectado ao painel em %s:%u como %s.\n", brokerIp.toString().c_str(), brokerPort, cfg.id);
    flushEvents();
  } else {
    Serial.printf("[NET] O painel recusou a conexao (estado %d).\n", mqtt.state());
    tcp.stop();
    ++mqttFails;
    if (brokerAuto() && mqttFails >= 2) brokerKnown = false;
  }
}

bool netPublish(NetChannel ch, const char *json) {
  return mqtt.connected() && mqtt.publish(topics[ch], json);
}

void netPublishEvent(const char *json) {
  if (!configured() && testState != TEST_RUNNING) return;
  if (!netPublish(CH_EVENTS, json)) queueEvent(json);
}

/* texto vindo de fora (nome de rede) dentro de JSON: escapa aspas, barra e controles */
static void jsonEsc(char *out, size_t len, const char *in) {
  size_t n = 0;
  for (; *in && n + 7 < len; in++) {
    unsigned char c = (unsigned char)*in;
    if (c == '"' || c == '\\') { out[n++] = '\\'; out[n++] = (char)c; }
    else if (c < 0x20) n += snprintf(out + n, len - n, "\\u%04x", c);
    else out[n++] = (char)c;
  }
  out[n] = '\0';
}

int netStatusAppend(char *buf, size_t len) {
  int n = 0;
  char e1[72], e2[72];
  auto add = [&](int w) {
    if (w > 0 && (size_t)(n + w) < len) n += w;
    else buf[n] = '\0';
  };
  bool up = WiFi.status() == WL_CONNECTED;
  jsonEsc(e1, sizeof(e1), cfg.ssid);
  const char *wstate = testState == TEST_RUNNING ? "testing" : up ? "connected" : configured() ? "connecting" : "none";
  add(snprintf(buf + n, len - n, ",\"id\":\"%s\",\"wstate\":\"%s\",\"wcfg\":\"%s\"", cfg.id, wstate, e1));
  if (up) {
    add(snprintf(buf + n, len - n, ",\"rssi\":%d,\"ip\":\"%s\",\"ssid\":\"%s\",\"ch\":%d", WiFi.RSSI(),
                 WiFi.localIP().toString().c_str(), e1, WiFi.channel()));
  }
  add(snprintf(buf + n, len - n, ",\"broker\":\"%s:%u\",\"auto\":%s,\"mq\":%s,\"q\":%u,\"lowlat\":%d",
               brokerKnown ? brokerIp.toString().c_str() : "", brokerPort, brokerAuto() ? "true" : "false",
               netMqttConnected() ? "true" : "false", pendingCount, (NET_LOW_LATENCY && !powerSaveApplied) ? 1 : 0));
  add(snprintf(buf + n, len - n, ",\"portal\":%s,\"ap\":\"%s\"", portal ? "true" : "false", apName));
  if (lastErr[0]) add(snprintf(buf + n, len - n, ",\"werr\":\"%s\"", lastErr));
  if (testState != TEST_IDLE) {
    jsonEsc(e2, sizeof(e2), trial.ssid);
    add(snprintf(buf + n, len - n, ",\"wtest\":\"%s\",\"wtry\":\"%s\"",
                 testState == TEST_RUNNING ? "running" : testState == TEST_OK ? "ok" : "fail", e2));
  }
  return n;
}

#else /* ENABLE_MQTT 0: so Serial */

void netBegin(bool) {}
void netService() {}
bool netPublish(NetChannel, const char *) { return false; }
void netPublishEvent(const char *) {}
void netOnCommand(NetCommandHandler) {}
void netRequestPortal() {}
void netHandleLine(const char *) {}
bool netPortalActive() { return false; }
bool netTesting() { return false; }
bool netTakeStatusRequest() { return false; }
bool netMqttConnected() { return false; }
void netSetPowerSave(bool) {}
void netRequestWifiScan() {}
int netTakeWifiScan(char *, size_t) { return 0; }
bool netJsonField(const char *, const char *, char *, size_t) { return false; }
const char *netDeviceId() { return DEVICE_ID; }
int netStatusAppend(char *, size_t) { return 0; }

#endif
