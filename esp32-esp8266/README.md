# Firmware – EchoMap

| Pasta | Placa | O que faz |
|---|---|---|
| [`no-principal/`](no-principal/) | ESP32 (esp32dev) | Lê os sensores (distância, GPS e acelerômetro), aciona o RGB e os 2 motores de vibração, detecta queda e impacto e publica tudo por Serial e MQTT |

## Nó principal (`no-principal/`)

Projeto PlatformIO (`platformio.ini`, ambiente `esp32dev`, framework Arduino). Bibliotecas: `knolleary/PubSubClient` (MQTT) e `mikalhart/TinyGPSPlus` (GPS). O PlatformIO baixa as duas sozinho no primeiro build.

```
no-principal/
  include/config.h        pinos, Wi-Fi/MQTT, limiares e períodos das tasks
  include/imu_detector.h  detecção de queda e impacto (lógica pura, testável no PC)
  include/ttc_detector.h  quase colisão por tempo até o impacto (lógica pura, testável no PC)
  include/alert_fsm.h     pré-alerta "Estou bem" de queda/batida (lógica pura, testável no PC)
  include/power_manager.h economia de energia guiada pelo MPU (lógica pura, testável no PC)
  include/haptic_engine.h linguagem háptica: padrões -> motores de vibração (lógica pura, testável no PC)
  include/calibration.h   calibração assistida: Welford, passos e ruído do eco (lógica pura, testável no PC)
  include/click_classifier.h  gestos do botão: 1, 2 e 3 cliques (lógica pura, testável no PC)
  include/wifi_fingerprint.h  assinatura de Wi-Fi quando o GPS não pega (lógica pura, testável no PC)
  src/main.cpp            tasks FreeRTOS, sensores, atuadores e comunicação
  src/net.cpp             Wi-Fi, MQTT, portal, descoberta do servidor e comandos
  host_test/              testes da queda/impacto, TTC, pré-alerta, energia, háptica, calibração, cliques e Wi-Fi no PC
```

### Como gravar

1. VS Code com a extensão **PlatformIO IDE** → *File > Open Folder* → `esp32-esp8266/no-principal`.
2. Ajuste `include/config.h` (Wi-Fi, broker e, se precisar, pinos; veja abaixo).
3. Barra inferior: ✓ **Build**, → **Upload**, 🔌 **Serial Monitor** (115200).
4. **Deixe o dispositivo parado por 1 s depois de ligar:** o MPU-6050 se calibra nesse tempo, e essa posição vira a referência da inclinação.

### Componentes e pinos

Ligações completas em [`schematics/`](../schematics/).

| Componente | Pino(s) ESP32 |
|---|---|
| HC-SR04 esquerdo | TRIG 18 · ECHO 19 (divisor 1 kΩ / 2 kΩ) · VCC no VIN (5 V) |
| HC-SR04 direito | TRIG 25 · ECHO 33 (divisor 1 kΩ / 2 kΩ) · VCC no VIN (5 V) |
| Potenciômetro (limiar de alerta) | 35 |
| Botão | 4 (pull-up interno) |
| LED RGB catodo comum | R 21 · G 22 · B 23 |
| Módulo de vibração MV50 esquerdo / direito (pino IN) | 13 / 14 (LEDC canais 0 e 2, PWM de 20 kHz) · VCC no 5V |
| GPS NEO-6M (GY-GPS6MV2) | TX do GPS → 16 (RX2) · RX do GPS → 17 (TX2) · VCC 3V3 |
| MPU-6050 (GY-521) | SDA 26 · SCL 27 · VCC 3V3 · AD0 no GND (endereço 0x68) |

O I²C usa 26/27 porque os pinos padrão (21/22) já estão com o LED RGB. Para desligar um módulo que ainda não está montado, use `ENABLE_GPS 0` ou `ENABLE_IMU 0` no `config.h`.

### Tasks FreeRTOS

| Task | Núcleo | Prioridade | Período | Função |
|---|---|---|---|---|
| `TaskSensors` | 1 | 2 | 60 ms | lê os dois HC-SR04 em sequência (30 ms entre eles, contra eco cruzado), filtra (EMA), calcula o TTC de cada lado e gera `NEAR_MISS` só no crítico |
| `TaskStatusLed` | 1 | 1 | 20 ms | cor e pulsação do RGB conforme o modo |
| `TaskHaptic` | 1 | 1 | 10 ms | sequenciador da linguagem háptica: padrões pedidos por fila + fundo de cada lado (obstáculo parado/aproximando), escritos no PWM dos dois motores |
| `TaskButton` | 0 | 2 | interrupção (+ 20 ms) | gestos: 1 clique troca o modo, 2 cliques = âncora rápida, 3 cliques = portal, clique longo (1,5 s) = `CRASH`; no pré-alerta, 1 clique = "Estou bem" na hora |
| `TaskImu` | 0 | 3 | 5 ms | lê o MPU a 200 Hz, detecta queda e batida, abre o pré-alerta de 5 s e calcula a inclinação |
| `TaskGps` | 0 | 1 | 20 ms | lê as sentenças NMEA do NEO-6M (TinyGPSPlus) |
| `TaskComms` | 0 | 1 | 20 ms | rede (Wi-Fi, MQTT, portal), comandos e alertas a cada 20 ms; telemetria e IMU a cada 200 ms, posição 1×/s, status a cada 5 s |

Sincronização: mutex do estado compartilhado, fila de eventos e semáforo binário do botão (liberado pela ISR). A `TaskImu` fica no núcleo 0 para não interromper o `pulseIn()` dos ultrassônicos no núcleo 1.

### Queda, impacto e equilíbrio (MPU-6050)

A cada 5 ms (200 Hz, filtro interno de ~184 Hz para não achatar o pico das pancadas) o firmware calcula o módulo da aceleração (parado ≈ 1 g). No boot ele procura o módulo em 0x68 e 0x69 e mostra na Serial o chip encontrado (placas "ITG/MPU" podem ser MPU-6050, 6500 ou 9250; todas funcionam). Se nada responder, a Serial lista o que existe no barramento I2C. Com `IMU_DEBUG 1` no `config.h`, a Serial mostra a aceleração mínima e máxima a cada 0,5 s, útil para ajustar os limiares.

| Evento | Quando dispara |
|---|---|
| `FALL` (queda) | queda livre (abaixo de 0,5 g por pelo menos 60 ms) seguida de impacto ≥ 2 g em até 1 s **e**, 2 s depois, inclinação média ≥ 45° (ficou caído) |
| `IMPACT` (batida) | pancada ≥ 3 g sem queda livre antes, ou ≥ 5 g mesmo continuando de pé (bateu correndo) |
| pulo (só no log) | queda livre + impacto, mas continuou de pé: pulo, corrida, degrau. Não gera alerta |

- **Por que confirmar pela postura:** pulo, corrida e degrau também têm uma fase "sem peso" seguida de pisada forte. Sem a confirmação, 10 s de corrida geravam 3 quedas falsas no teste. O alerta de queda sai 2 s depois do impacto.
- **Normalização:** no boot o firmware mede a gravidade parado e divide as leituras por ela, então um módulo que lê 0,96 g ou 1,06 g parado se comporta igual a um ideal.
- **Módulo no pulso:** a inclinação do pulso muda o tempo todo; nesse caso use `FALL_TILT_DEG 0` (desliga a confirmação) no `config.h`.

- O valor enviado é o **pico** do impacto: o firmware espera 100 ms depois de passar do limiar.
- Depois de um evento, ignora 3 s para não repetir a mesma pancada.
- A **inclinação** (`tilt`) é o ângulo entre a gravidade agora e a gravidade medida no boot. Ela mostra se a pessoa está inclinada ou deitada, seja qual for a posição em que o módulo foi preso.
- Todos os limiares ficam no `config.h`. O `IMPACT_G` é igual ao `thresholds.impactG` do dashboard.

A lógica está em `include/imu_detector.h` e é testada no PC, sem a placa, com 17 cenários simulados: parado, andando, queda, queda em superfície macia, queda de lado, batida, pancada leve, tropeço, pulo suave, pulo com aterrissagem forte, corrida, degrau, bateu correndo, impacto atrasado, duas batidas seguidas e inclinação.

### Pré-alerta "Estou bem" (firmware 1.5)

Queda ou batida confirmada pelo detector **não vai direto ao painel**: abre um pré-alerta de 5 s (`PRE_ALERT_MS`).

| Estado | O que acontece |
|---|---|
| `PRE_ALERT` | LED âmbar piscando cada vez mais rápido e pulsos de vibração nos dois lados que aceleram (1 a cada 800 ms até 1 a cada 250 ms). A Serial avisa `[ALERTA] Queda detectada...` |
| `CANCELLED_BY_USER` | **1 clique curto** no botão dentro dos 5 s: o aviso para, LED verde + dois toques curtos de vibração, e o painel recebe `DISMISSED` (gravidade "info", sem alarme), com a causa (`FALL` ou `IMPACT`) |
| `CONFIRMED_ALERT` | sem clique em 5 s: o `FALL`/`IMPACT` sai normalmente, com o horário do primeiro evento |

- Durante o pré-alerta o clique curto **só cancela**, na hora (sem esperar a janela dos 2/3 cliques): não troca o modo nem conta para os gestos. O clique longo continua mandando `CRASH` na hora.
- Várias pancadas durante os 5 s viram **um** alerta: a causa sobe para a mais grave (queda > batida), fica o maior pico e o prazo não é estendido.
- Se o MPU parar de responder no meio do pré-alerta, o alerta sai mesmo assim no fim dos 5 s.
- Lógica em `include/alert_fsm.h` (`IDLE → PRE_ALERT → CONFIRMED_ALERT | CANCELLED_BY_USER`).

### Economia de energia (firmware 1.6)

`include/power_manager.h`, chamado pela `TaskImu` a cada amostra (200 Hz):

| Estado | Quando | O que muda |
|---|---|---|
| `ACTIVE` | qualquer movimento: \|g − 1\| > 0,06 g, desvio padrão recente de g > 0,03 g (balanço contínuo) ou giro > 12 °/s; ou um clique no botão | ultrassônicos no ritmo normal (~10 leituras/s), Wi-Fi sem modem-sleep (`NET_LOW_LATENCY`) |
| `IDLE_SAVING` | parado por 120 s (`POWER_IDLE_AFTER_MS`) | ultrassônicos a 1 leitura/s (`SENSOR_IDLE_PERIOD_MS`), Wi-Fi em modem-sleep (`WiFi.setSleep(true)` = `WIFI_PS_MIN_MODEM`; o MQTT continua conectado), status com `"pwr":"idle"` |

Acordar é imediato: a primeira amostra com movimento (5 ms) acorda, e a `TaskSensors` sai da espera de 1 s por notificação, sem esperar o ciclo. O MPU-6050 não tem o pino INT ligado no esquema, então a detecção é por leitura (a `TaskImu` já roda a 200 Hz). A Serial mostra `[ENERGIA] ...` em cada troca.

### Linguagem háptica (firmware 1.6)

`include/haptic_engine.h` separa **o que** tocar (padrão com significado) de **como** tocar (PWM em cada motor de vibração). A `TaskHaptic` recebe pedidos por fila, sem `delay()`, e escreve a intensidade 0..1 nos motores a cada 10 ms.

| Padrão | Forma | Quando |
|---|---|---|
| `PATTERN_STATIC_OBSTACLE` | 60 ms ligado / 700 ms desligado, suave, só no lado do obstáculo | obstáculo parado (fundo contínuo) |
| proximidade | 70 ms ligado, pausa de 600 a 80 ms, mais forte quanto mais perto | algo se aproximando (fundo contínuo) |
| `PATTERN_FAST_APPROACH` | 80 / 60 / 80 ms, força total, no lado | `NEAR_MISS` por TTC |
| `PATTERN_PRE_ALERT` | batidas que aceleram (800 → 250 ms) e crescem por 5 s | pré-alerta "Estou bem" |
| `PATTERN_HEARTBEAT` | um pulso de 200 ms, suave | a cada 10 min com Wi-Fi e servidor ok, ou pelo painel |
| `PATTERN_CONFIRM` | dois toques de 50 ms | alerta cancelado (e, nas próximas fases, âncora e calibração) |
| localizar | 150 / 150 ms por 4 s | "Vibrar para localizar" no painel |

Prioridade: pré-alerta > aproximação rápida > confirmação > localizar > batimento; o fundo só toca quando nada está tocando naquele lado. **Motores:** dois módulos MV50 nos GPIO 13 (esquerdo) e 14 (direito). O PWM vai a 20 kHz (`MOTOR_PWM_HZ`, fora do audível) e a intensidade 0..1 vira 35–100% de duty (`MOTOR_MIN_DUTY`: abaixo disso o motor não gira).

### Calibração assistida (firmware 1.7)

O limiar de batida de fábrica (3 g) serve para a média; quem pisa mais forte pode gerar batidas falsas, e quem pisa leve pode perder batidas de verdade. A calibração mede o passo de quem usa:

1. **Iniciar calibração (30 s)** na tela Dispositivo, `{"cmd":"calibrate_start","duration_s":30}` (MQTT ou Serial) ou `calibrar` na Serial (`calibrar 20` muda a duração, de 10 a 120 s).
2. O LED pisca em azul rápido, os motores dão a confirmação, e a pessoa anda em linha reta num corredor livre, no passo normal. A cada 1 s sai `{"calib":"running","elapsed":12,"duration":30,"steps":21}` no canal `echomap/<id>/calib`.
3. A coleta não guarda amostras (Welford: média e desvio em memória constante):
   - **passos**: cada pico de \|a\| acima de 1,15 g, com no mínimo 250 ms entre passos; média, desvio padrão e maior pico;
   - **eco**: ruído de cada ultrassônico pela diferença entre leituras seguidas (std/√2), que mede o tremor do eco e não a parede chegando perto.
4. No fim:
   - **limiar de batida** = max(2,5 g; maior passo × 1,6), limitado a 4,5 g (se a pessoa correr na calibração, o limiar não sobe a ponto de esconder batidas);
   - **histerese dos ultrassônicos** = 3 × ruído do eco, entre 5 e 30 cm. Ela define até onde o aviso de obstáculo parado continua ligado (liga a 120 cm, desliga só depois de 120 cm + histerese);
   - com menos de 10 passos a calibração **falha** e nada muda; sem eco suficiente, só a histerese fica como estava.
5. Os valores são aplicados na hora (sem reiniciar), gravados na NVS (`echomap_cfg`: `impactG`, `hystCm`) e lidos no boot. O resultado sai como `{"calib":"done","type":"calibration_result",...}` com antes/depois.

`calibrar parar` (ou `calibrate_stop`) cancela sem mudar nada; `calibrar padrao` (ou `calibrate_reset`) volta para `IMPACT_G` e `ALERT_HYST_CM` e limpa a NVS. O status traz os limiares em uso (`impG`, `hyst`) e `cal` durante a calibração. Parâmetros: `CAL_*` no `config.h`.

### Assinatura de Wi-Fi quando o GPS não pega (firmware 1.8)

Dentro de casa o NEO-6M costuma ficar sem posição. Quando o GPS fica **15 s** sem posição válida (ou com menos de 3 satélites), a `TaskComms` pede uma varredura de Wi-Fi a cada **30 s** (`include/wifi_fingerprint.h`, `WIFI_FP_*` no `config.h`):

- varredura **passiva e assíncrona** (`WiFi.scanNetworks(true, false, true, 120)`): o rádio passa pelos canais entre os pacotes da conexão atual, então o MQTT não cai;
- as **3 redes mais fortes** (sem repetir BSSID) vão no canal `echomap/<id>/wifi`: `{"type":"wifi_fingerprint","aps":[{"bssid":"EC:08:6B:12:34:56","rssi":-58,"ssid":"Casa"}],"t":...}`;
- o servidor compara com os locais cadastrados (aba Mapa) e mostra "Ambiente interno conhecido: Casa (Wi-Fi)".

`{"cmd":"wifi_scan"}` (botão **Escanear agora** no painel) ou `escanear` na Serial faz uma varredura na hora, mesmo com GPS bom, para cadastrar o local.

### Testes no PC (sem a placa)

```bash
cd esp32-esp8266/no-principal/host_test
g++ -std=c++11 -Wall -Wextra -I../include test_imu_detector.cpp -o test_imu && ./test_imu   # 17 cenários
g++ -std=c++11 -Wall -Wextra -I../include test_ttc_detector.cpp -o test_ttc && ./test_ttc   # 13 cenários
g++ -std=c++11 -Wall -Wextra -I../include test_alert_fsm.cpp -o test_fsm && ./test_fsm      # 14 verificações
g++ -std=c++11 -Wall -Wextra -I../include test_power_manager.cpp -o test_pwr && ./test_pwr  # 8 verificações
g++ -std=c++11 -Wall -Wextra -I../include test_haptic_engine.cpp -o test_hap && ./test_hap  # 13 verificações
g++ -std=c++11 -Wall -Wextra -I../include test_calibration.cpp -o test_cal && ./test_cal    # 13 verificações
g++ -std=c++11 -Wall -Wextra -I../include test_click_classifier.cpp -o test_click && ./test_click  # 7 verificações
g++ -std=c++11 -Wall -Wextra -I../include test_wifi_fingerprint.cpp -o test_wfp && ./test_wfp     # 10 verificações
```

### GPS (NEO-6M)

A `TaskGps` decodifica o NMEA. Uma vez por segundo, se houver posição válida e recente (menos de 3 s), o firmware publica latitude, longitude, satélites, HDOP, velocidade e uma estimativa de precisão em metros (HDOP × 5 m). Sem posição, a cada 5 s a Serial diz o motivo:
- `Nenhum dado do módulo`: confira a fiação do TX do GPS → GPIO 16;
- `Sem posição ainda`: o GPS precisa de céu aberto, e o primeiro fix pode levar alguns minutos.

### Gestos do botão (firmware 1.8)

| Gesto | O que faz |
|---|---|
| 1 clique | alterna radar ↔ autoteste (sai 0,45 s depois, para não confundir com 2 ou 3 cliques) |
| 2 cliques | **âncora rápida**: confirmação curta no corpo e `{"event":"ANCHOR_TOGGLE","type":"quick_anchor_toggle","lat":...,"lng":...}` (sem GPS, vai sem posição e o servidor usa a última). Se já houver âncora, o servidor desliga |
| 3 cliques | abre o portal de Wi-Fi (no terceiro clique) |
| segurar 1,5 s | SOS (`CRASH`), na hora |
| 1 clique no pré-alerta | "Estou bem" (cancela queda/batida), na hora |

Cada clique precisa vir até 0,45 s depois do anterior (`CLICK_GAP_MS`). Lógica em `include/click_classifier.h`.

### Modos (1 clique no botão alterna entre os dois)

| Modo | RGB | Potenciômetro |
|---|---|---|
| RADAR | verde → amarelo → vermelho conforme a proximidade | limiar de detecção (20–200 cm) |
| SELFTEST | cicla R, G, B e branco | — |

Cada lado avisa só pelo seu sensor, com a linguagem háptica abaixo: obstáculo **parado** (parede, pessoa ao lado) dá um pulso curto e suave a cada 0,76 s; algo **se aproximando** dá pulsos que aceleram e ficam mais fortes de 120 cm até 30 cm; aproximação **crítica** (TTC) dá a dupla rápida.

Durante o pré-alerta, 1 clique curto é o "Estou bem" (ver acima), não troca de modo.

### Quase colisão por tempo até o impacto (TTC, firmware 1.5)

Cada ultrassônico tem um `TtcDetector` (`include/ttc_detector.h`):

1. Leitura inválida (0, timeout, fora de 2–400 cm) é ignorada; 3 falhas seguidas zeram a janela (o obstáculo sumiu).
2. Mediana das 3 últimas leituras válidas (descarta eco espúrio).
3. Janela das últimas 5 medianas: velocidade de aproximação `v = −Δd/Δt` pela reta de mínimos quadrados (cm/s).
4. `TTC = d / v` quando `v > 15 cm/s`.

| Situação | Resultado |
|---|---|
| TTC ≤ 1,5 s com d ≤ 150 cm (2 leituras seguidas) | `NEAR_MISS` com `"reason":"ttc"`, `ttc` (s) e `v` (cm/s) |
| leitura ≤ 25 cm em 3 leituras válidas seguidas | `NEAR_MISS` com `"reason":"close"` |
| 25–120 cm sem aproximação (\|v\| < 15 cm/s): andando ao lado de um muro | **sem ocorrência**; só a vibração suave daquele lado |
| mesmo lado de novo | no mínimo 3 s depois (`TTC_COOLDOWN_MS`), e o obstáculo precisa ainda estar perto ou se aproximando |

Todos os valores ficam no `config.h` (`TTC_*`). A telemetria manda `near` = 25 cm (`TTC_CLOSE_CM`), que o painel usa para a faixa crítica.

### Saída (JSON, uma linha por mensagem)

```json
{"t":5230,"mode":"RADAR","distL":87.2,"rawL":88.0,"distR":-1.0,"rawR":-1.0,"vibL":0.40,"vibR":0.00,"thr":120,"pot":0.55,"near":25}
{"fw":"1.1.0","up":5,"heap":201344,"rssi":-61,"t":5000}
{"ax":0.02,"ay":-0.01,"az":0.99,"gx":0.3,"gy":-0.2,"gz":0.1,"gMax":1.01,"tilt":4,"t":5230}
{"lat":-8.059280,"lon":-34.872030,"acc":6.5,"hdop":1.30,"sats":8,"speed":0.12,"t":6000}
{"event":"NEAR_MISS","side":"L","value":62.0,"reason":"ttc","ttc":0.80,"v":78,"t":6110}
{"event":"NEAR_MISS","side":"R","value":21.4,"reason":"close","t":6800}
{"event":"FALL","value":3.52,"unit":"g","tilt":72,"t":7420}
{"event":"DISMISSED","cause":"FALL","value":3.52,"unit":"g","t":7420}
{"event":"IMPACT","value":4.10,"unit":"g","t":9050}
{"event":"CRASH","t":9020}
```

`-1` significa nada no alcance (só depois de 3 leituras perdidas seguidas; uma perda isolada mantém o último valor). `NEAR_MISS` segue as regras de TTC acima. `DISMISSED` é uma queda/batida cancelada no botão. `near` é o limiar de quase colisão, usado pelo painel. `gMax` é o maior módulo da aceleração desde a mensagem anterior. Os valores de latitude e longitude acima são só um exemplo de formato.

### MQTT

Já vem ligado (`ENABLE_MQTT 1`); o código de rede fica em `src/net.cpp`.

O passo a passo para o usuário está no [README principal](../README.md#conectar-o-echomap-ao-wi-fi). Por dentro:

**Três jeitos de passar a rede**, todos pelo mesmo caminho (`tryWifi` em `net.cpp`):
- painel: comando `{"cmd":"wifi","ssid":"...","pass":"..."}` pelo MQTT ou pelo cabo USB (o servidor escreve o JSON na Serial);
- portal: rede `EchoMap-<id>` (senha `echomap123`), página em `192.168.4.1` com a lista de redes ordenada pelo sinal;
- Serial: `wifi "rede" "senha"`, `status` (JSON completo), `rede`, `portal`, `servidor auto|<IP>`, `esquecer`, `sensores`.

O mesmo canal troca o servidor: `servidor auto` na Serial, ou `{"cmd":"server","host":"auto"}` pelo MQTT (botão **Encontrar o servidor automaticamente** no painel).

### Teste dos ultrassônicos (`sensores`)

Digite `sensores` na Serial ou clique em **Testar sensores** (painel, tela Ao vivo), com os dois sensores apontados para uma parede a 30–100 cm. Para cada lado o firmware pausa a leitura normal e verifica:
- se o pino ECHO fica em nível baixo quando parado (preso em alto = divisor ligado errado);
- se o eco volta ao disparar o TRIG (3 tentativas) e a que distância;
- se o eco apareceu no pino do **outro** lado (fios de ECHO trocados entre os sensores);
- no lado direito (GPIO 33, que tem ADC1), **a tensão que chega do divisor**: cerca de 3,3 V é o certo; cerca de 1,7 V indica resistores invertidos; perto de 0 V indica que nada chega (sensor sem 5 V/GND, TRIG solto ou ECHO sem chegar ao divisor).

O resultado sai na Serial (linhas `[DIAG]`) e em `echomap/<id>/diag`, e o painel explica o que fazer em cada caso.

**Prioridade:** o que foi salvo na NVS (painel, portal, Serial) vale mais que o `secrets.h`, que só é usado enquanto nada foi salvo. Se a rede em uso não conectar em 15 s (`NET_PORTAL_AFTER_FAIL_MS`), o portal abre sozinho e a Serial segue aceitando comandos; se a rede voltar e ninguém estiver no portal, ele fecha.

**Status na hora:** além do envio a cada 5 s, o status sai imediatamente quando a rede muda (queda, teste, portal) ou quando alguém digita `status`. Ele inclui `id`, `wstate` (`connected`, `connecting`, `testing`, `none`), `wcfg` (rede que está tentando), `werr` e o teste em andamento; os nomes de rede vão escapados no JSON.

**Teste antes de salvar:** a rede nova só vai para a flash (NVS) se conectar em até 20 s (`NET_TEST_TIMEOUT_MS`). Se falhar, a placa volta para a rede anterior e guarda o motivo, lido do evento de desconexão do Wi-Fi: senha incorreta, rede não encontrada (fora do alcance ou 5 GHz), sem resposta. O motivo aparece na Serial, no portal e no painel (`werr`/`wtest` no status). Durante o teste o LED pisca em ciano.

**Portal:** abre com 3 cliques rápidos no botão (cada um até `CLICK_GAP_MS` depois do anterior; o modo não muda), segurando o botão por 2 s ao ligar, pelo painel, pela Serial, sozinho quando não há rede salva ou depois de 15 s sem conectar. LED azul pulsando. Fecha 30 s depois de uma rede nova dar certo, ou após 5 min sem uso.

**Servidor automático:** com servidor `auto` (padrão), a placa ouve o anúncio UDP que o dashboard manda na porta 47801 e usa o IP de quem anunciou. O último servidor achado fica salvo, então no próximo boot ela conecta direto; se ele não responder duas vezes, procura de novo. **Firmware 1.4:** com servidor fixo (um IP no `secrets.h` ou salvo antes), se o broker falhar 3 vezes e o painel se anunciar em outro IP, a placa passa para `auto` sozinha e grava isso na NVS. O `status` traz `mq` (`true` quando o MQTT está conectado), e o painel usa isso para mostrar quando a placa está no Wi-Fi mas não alcança o servidor.

**Latência:** `NET_LOW_LATENCY 1` desliga o modem-sleep do Wi-Fi (respostas em milissegundos em vez de 100–300 ms, com ~80 mA a mais); o socket MQTT não usa Nagle; a TaskComms atende rede, comandos e alertas a cada 20 ms. O servidor mede a ida e volta com ping a cada 5 s e mostra na tela Dispositivo.

**Comandos do painel** (`echomap/<id>/cmd`, ou JSON pela Serial): `ping` (latência), `locate` (padrão "localizar" por 4 s), `haptic` (`{"pattern":"approach"}`: toca um padrão da linguagem háptica), `calibrate_start` (`{"duration_s":30}`), `calibrate_stop`, `calibrate_reset`, `wifi_scan` (varredura de Wi-Fi agora), `portal` (abre o portal), `wifi` (testa e salva uma rede), `server` (`{"host":"auto"}` ou um IP: onde procurar o servidor), `diag` (teste dos ultrassônicos) e `forget` (esquece a rede). Na Serial também: `vibrar <padrão>`, `calibrar` / `calibrar parar` / `calibrar padrao` e `escanear`.

O `include/secrets.h` (fora do git, modelo em `include/secrets.example.h`) é opcional: serve só como padrão gravado no firmware. O que for salvo pelo painel, pelo portal ou pela Serial tem prioridade:

```c
#define WIFI_SSID "nome-da-rede"
#define WIFI_PASSWORD "senha"
#define MQTT_BROKER_IP "auto"   // recomendado; um IP fixo quebra quando o PC muda de rede
```

- Sem rede configurada, a placa abre o portal e continua mandando tudo pela Serial.
- A conexão nunca trava as tasks: Wi-Fi tenta de novo a cada 10 s, o broker a cada 5 s (TCP com limite de 0,8 s).
- Eventos que não chegaram ao broker ficam guardados (até 8) e são reenviados ao reconectar.

| Tópico | Conteúdo |
|---|---|
| `echomap/node1/telemetry` | distâncias, intensidade de cada motor (`vibL`/`vibR`), modo e limiar (5×/s) |
| `echomap/node1/imu` | aceleração, giro, pico e inclinação (5×/s) |
| `echomap/node1/location` | posição do GPS (1×/s, só com fix) |
| `echomap/node1/events` | `NEAR_MISS`, `CRASH`, `FALL`, `IMPACT`, `DISMISSED`, `ANCHOR_TOGGLE` (2 cliques) |
| `echomap/node1/status` | versão, tempo ligado, memória, energia (`pwr`: `active`/`idle`), limiares em uso (`impG`, `hyst`), calibrando (`cal`), sinal, IP, rede, canal, servidor, MQTT conectado (`mq`), fila de alertas (a cada 5 s, e na hora quando a energia muda) |
| `echomap/node1/pong` | resposta ao ping do servidor |
| `echomap/node1/calib` | progresso e resultado da calibração assistida |
| `echomap/node1/wifi` | assinatura de Wi-Fi (3 redes mais fortes) quando o GPS não pega |
| `echomap/node1/cmd` | (placa assina) `ping`, `locate`, `haptic`, `calibrate_start`, `calibrate_stop`, `calibrate_reset`, `portal`, `wifi`, `server`, `diag`, `forget`; só o servidor pode publicar aqui |

O PC e a ESP32 precisam estar na mesma rede, e o firewall do PC precisa liberar a porta TCP 1883.

### Próxima etapa

- Medir a bateria e incluir `battery` (%) no `status` (o painel já gera `LOW_BATTERY`).
