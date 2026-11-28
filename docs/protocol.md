# Protocolo de mensagens do EchoMap

Contrato único entre o **firmware** (`esp32-esp8266/no-principal`), o **servidor** (`applications/dashboard/server`) e o **simulador** (`applications/dashboard/tools/simulator.js`). O teste `applications/dashboard/tools/test-protocol.mjs` (parte do `npm test`) lê o código dos três e falha se um deles sair deste contrato: canais, campos da telemetria, comandos e ocorrências.

## Transporte

O mesmo JSON (uma mensagem por linha) segue por dois canais ao mesmo tempo:

| Canal | Como | Observação |
|---|---|---|
| Wi-Fi + MQTT | tópico `echomap/<deviceId>/<canal>`, TCP 1883 (broker embutido no servidor) | a placa acha o servidor sozinha por UDP na porta 47801 (`servidor auto`). Com `MQTT_USER`/`MQTT_PASS` definidos, o broker exige usuário e senha |
| Cabo USB (Serial 115200) | linha JSON com `"ch":"<canal>"` | o servidor acha a porta sozinho. Com os dois canais ativos, ele descarta as duplicatas (leituras: vale o MQTT; eventos: pelo par tipo + `t`) |

`deviceId` identifica cada pessoa (`node1`, `node2`...). `t` é o `millis()` da placa.

## Canais publicados pela placa

| Canal | Frequência | Exemplo |
|---|---|---|
| `telemetry` | 5×/s | `{"t":5230,"mode":"RADAR","distL":87.2,"rawL":88.0,"distR":-1.0,"rawR":-1.0,"vibL":0.40,"vibR":0.00,"thr":120,"pot":0.55,"near":25}` |
| `events` | na hora | ver [Ocorrências](#ocorrências) |
| `location` | 1×/s, só com fix | `{"lat":-8.059280,"lon":-34.872030,"acc":6.5,"hdop":1.30,"sats":8,"speed":0.12,"t":6000}` |
| `imu` | 5×/s | `{"ax":0.02,"ay":-0.01,"az":0.99,"gx":0.3,"gy":-0.2,"gz":0.1,"gMax":1.01,"tilt":4,"t":5230}` |
| `status` | a cada 5 s e quando a energia muda | `{"fw":"2.0.0","up":120,"heap":201000,"pwr":"active","impG":3.00,"hyst":10.0,"cal":false,"id":"node1","rssi":-60,"ip":"192.168.0.42","ssid":"Casa","ch":6,"broker":"192.168.0.10:1883","auto":true,"mq":true,"q":0,"lowlat":1,"portal":false,"ap":"EchoMap-node1","t":7000}` |
| `pong` | resposta ao `ping` | `{"pong":17,"t":6000}` |
| `diag` | resposta ao `diag` | `{"diag":{"L":{"trig":18,"echo":19,"echoOk":true,"cm":62.4},"R":{...}},"t":...}` |
| `calib` | 1×/s durante a calibração e no fim | `{"calib":"running","elapsed":12,"duration":30,"steps":21}` · `{"calib":"done","type":"calibration_result","ok":true,...}` |
| `wifi` | sem GPS por 15 s (depois a cada 30 s) ou com `wifi_scan` | `{"type":"wifi_fingerprint","aps":[{"bssid":"EC:08:6B:12:34:56","rssi":-58,"ssid":"Casa"}],"t":...}` |

Campos da telemetria: `mode` (`RADAR` ou `SELFTEST`), `distL`/`distR` (cm filtrado; -1 = nada), `rawL`/`rawR` (cm bruto), `vibL`/`vibR` (intensidade 0..1 de cada motor de vibração), `thr` (limiar do potenciômetro, cm), `pot` (0..1), `near` (distância crítica do TTC, cm).

## Comandos (servidor → placa)

Tópico `echomap/<deviceId>/cmd` (só o servidor publica nele; o broker recusa qualquer outro cliente) ou a mesma linha JSON pela Serial. A API `POST /api/devices/:id/command` aceita apenas estes e valida os campos:

| Comando | Campos | Efeito |
|---|---|---|
| `ping` | `id` | a placa responde no canal `pong` (latência) |
| `locate` | — | vibração forte e alternada por 4 s |
| `haptic` | `pattern`: `static`, `proximity`, `approach`, `prealert`, `heartbeat`, `confirm`, `locate` | toca um padrão da linguagem háptica |
| `calibrate_start` | `duration_s` (10–120, padrão 30) | calibração assistida andando |
| `calibrate_stop` | — | cancela a calibração |
| `calibrate_reset` | — | volta os limiares de fábrica |
| `wifi_scan` | — | manda a assinatura de Wi-Fi agora |
| `portal` | — | abre o portal de configuração (rede `EchoMap-<id>`) |
| `wifi` | `ssid`, `pass` (8–63 ou vazia), `host` opcional | testa a rede nova por até 20 s e só salva se conectar |
| `server` | `host`: `auto` ou um IPv4 | onde procurar o servidor MQTT |
| `diag` | — | testa os dois HC-SR04 e responde no canal `diag` |

Só pela Serial (texto digitado no monitor): `wifi "rede" "senha"`, `servidor auto|<IP>`, `portal`, `rede` (estado da conexão), `status` (JSON), `esquecer`, `sensores`, `vibrar <padrão>`, `calibrar [segundos|parar|padrao]` e `escanear`. Em JSON pela Serial também valem `forget` e `netstatus`.

## Ocorrências

A placa manda no canal `events`; o servidor guarda no SQLite com uma gravidade e mostra no painel.

| Código | Origem | Gravidade | Exemplo / quando |
|---|---|---|---|
| `NEAR_MISS` | placa | warning | `{"event":"NEAR_MISS","side":"L","value":62.0,"reason":"ttc","ttc":0.8,"v":78,"t":6110}`: impacto em ≤ 1,5 s ou < 25 cm |
| `CRASH` | placa | critical | `{"event":"CRASH","t":9020}`: botão segurado 1,5 s (pedido de ajuda) |
| `SOS` | placa (versões antigas) | critical | mesmo significado de `CRASH` |
| `FALL` | placa | critical | `{"event":"FALL","value":3.52,"unit":"g","tilt":80,"t":7420}`: queda confirmada (passou o pré-alerta de 5 s) |
| `IMPACT` | placa | serious | `{"event":"IMPACT","value":4.10,"unit":"g","t":9050}`: batida confirmada |
| `DISMISSED` | placa | info | `{"event":"DISMISSED","cause":"FALL","value":3.52,"unit":"g","t":7420}`: "Estou bem" (1 clique no pré-alerta) |
| `ANCHOR_TOGGLE` | placa | — | `{"event":"ANCHOR_TOGGLE","type":"quick_anchor_toggle","lat":...,"lng":...,"t":...}`: 2 cliques; o servidor transforma em `ANCHOR_CREATED`, `ANCHOR_REMOVED` ou `ANCHOR_FAILED` |
| `ANCHOR_CREATED` | servidor | info | âncora rápida criada (zona segura de 100 m por 4 h) |
| `ANCHOR_REMOVED` | servidor | info | âncora desligada (2 cliques de novo ou painel) |
| `ANCHOR_EXPIRED` | servidor | info | âncora venceu |
| `ANCHOR_FAILED` | servidor | warning | 2 cliques sem nenhuma posição conhecida |
| `GEOFENCE_EXIT` | servidor | serious | saiu de todas as zonas seguras (ignorado dentro de um local conhecido pelo Wi-Fi) |
| `GEOFENCE_ENTER` | servidor | info | voltou para uma zona segura |
| `LOW_BATTERY` | servidor | warning | bateria abaixo de 20 % (quando a placa medir a bateria) |
| `DEVICE_OFFLINE` | servidor | serious | sem mensagens além de `offlineAfterMs` |
| `DEVICE_ONLINE` | servidor | info | voltou a falar |

Gravidades: `info` < `warning` < `serious` < `critical`.
