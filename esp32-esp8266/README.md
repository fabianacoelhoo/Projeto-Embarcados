# Firmware – EchoMap

| Pasta | Placa | O que faz |
|---|---|---|
| [`no-principal/`](no-principal/) | ESP32 (esp32dev) | Lê os sensores (distância, GPS e acelerômetro), aciona RGB e buzzers, detecta queda e impacto e publica tudo por Serial e MQTT |

## Nó principal (`no-principal/`)

Projeto PlatformIO (`platformio.ini`, ambiente `esp32dev`, framework Arduino). Bibliotecas: `knolleary/PubSubClient` (MQTT) e `mikalhart/TinyGPSPlus` (GPS). O PlatformIO baixa as duas sozinho no primeiro build.

```
no-principal/
  include/config.h        pinos, Wi-Fi/MQTT, limiares e períodos das tasks
  include/imu_detector.h  detecção de queda e impacto (lógica pura, testável no PC)
  src/main.cpp            tasks FreeRTOS, sensores, atuadores e comunicação
  host_test/              teste da detecção de queda/impacto rodando no PC
  backup/                 versão anterior (1 HC-SR04 + IR + anel de LEDs), só para referência
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
| Buzzer passivo esquerdo / direito | 13 / 14 (LEDC canais 0 e 2) |
| GPS NEO-6M (GY-NEO6MV2) | TX do GPS → 16 (RX2) · RX do GPS → 17 (TX2) · VCC 3V3 |
| MPU-6050 (GY-521) | SDA 26 · SCL 27 · VCC 3V3 · AD0 no GND (endereço 0x68) |

O I²C usa 26/27 porque os pinos padrão (21/22) já estão com o LED RGB. Para desligar um módulo que ainda não está montado, use `ENABLE_GPS 0` ou `ENABLE_IMU 0` no `config.h`.

### Tasks FreeRTOS

| Task | Núcleo | Prioridade | Período | Função |
|---|---|---|---|---|
| `TaskSensors` | 1 | 2 | 60 ms | lê os dois HC-SR04 em sequência (30 ms entre eles, contra eco cruzado), filtra (EMA) e gera `NEAR_MISS` (confirmado em 2 leituras, no máximo 1 a cada 10 s por lado) |
| `TaskStatusLed` | 1 | 1 | 20 ms | cor e pulsação do RGB conforme o modo |
| `TaskBuzzer` | 1 | 1 | 20 ms | volume de cada buzzer conforme a distância do seu lado |
| `TaskButton` | 0 | 2 | interrupção | clique curto troca o modo; clique longo (1,5 s) gera `CRASH` |
| `TaskImu` | 0 | 3 | 5 ms | lê o MPU a 200 Hz, detecta `FALL` e `IMPACT` e calcula a inclinação |
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

```bash
cd esp32-esp8266/no-principal/host_test
g++ -std=c++17 -Wall -Wextra -I../include test_imu_detector.cpp -o test_imu && ./test_imu
```

### GPS (NEO-6M)

A `TaskGps` decodifica o NMEA. Uma vez por segundo, se houver posição válida e recente (menos de 3 s), o firmware publica latitude, longitude, satélites, HDOP, velocidade e uma estimativa de precisão em metros (HDOP × 5 m). Sem posição, a cada 5 s a Serial diz o motivo:
- `Nenhum dado do módulo`: confira a fiação do TX do GPS → GPIO 16;
- `Sem posição ainda`: o GPS precisa de céu aberto, e o primeiro fix pode levar alguns minutos.

### Modos (clique curto no botão)

| Modo | RGB | Potenciômetro |
|---|---|---|
| RADAR | verde → amarelo → vermelho conforme a proximidade | limiar de detecção (20–200 cm) |
| SIM360 | azul / magenta | ângulo simulado (0–360°) |
| SELFTEST | cicla R, G, B e branco | — |

Os buzzers começam a apitar a 120 cm (volume baixo) e chegam ao volume máximo a 30 cm, cada um respondendo ao sensor do seu lado.

### Saída (JSON, uma linha por mensagem)

```json
{"t":5230,"mode":"RADAR","distL":87.2,"rawL":88.0,"distR":-1.0,"rawR":-1.0,"bzL":0.40,"bzR":0.00,"thr":120,"angle":0,"pot":0.55,"near":50}
{"fw":"1.1.0","up":5,"heap":201344,"rssi":-61,"t":5000}
{"ax":0.02,"ay":-0.01,"az":0.99,"gx":0.3,"gy":-0.2,"gz":0.1,"gMax":1.01,"tilt":4,"t":5230}
{"lat":-8.059280,"lon":-34.872030,"acc":6.5,"hdop":1.30,"sats":8,"speed":0.12,"t":6000}
{"event":"NEAR_MISS","side":"L","value":42.1,"t":6110}
{"event":"FALL","value":3.52,"unit":"g","t":7420}
{"event":"IMPACT","value":4.10,"unit":"g","t":9050}
{"event":"CRASH","t":9020}
```

`-1` significa nada no alcance (só depois de 3 leituras perdidas seguidas; uma perda isolada mantém o último valor). `NEAR_MISS` precisa de 2 leituras seguidas abaixo de 50 cm (`NEAR_MISS_CONFIRM_SAMPLES`, filtra eco espúrio), tem histerese de 10 cm (só rearma acima de 60 cm) e respeita 10 s entre dois alertas do mesmo lado (`NEAR_MISS_COOLDOWN_MS`): alguém parado perto, ou passando várias vezes, vira um alerta e não uma rajada. `near` é o limiar de quase colisão, usado pelo painel. `gMax` é o maior módulo da aceleração desde a mensagem anterior. Os valores de latitude e longitude acima são só um exemplo de formato.

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

**Portal:** abre com 3 cliques rápidos no botão (`TRIPLE_CLICK_MS`; como são 3 modos, o modo volta a ser o mesmo), segurando o botão por 2 s ao ligar, pelo painel, pela Serial, sozinho quando não há rede salva ou depois de 15 s sem conectar. LED azul pulsando. Fecha 30 s depois de uma rede nova dar certo, ou após 5 min sem uso.

**Servidor automático:** com servidor `auto` (padrão), a placa ouve o anúncio UDP que o dashboard manda na porta 47801 e usa o IP de quem anunciou. O último servidor achado fica salvo, então no próximo boot ela conecta direto; se ele não responder duas vezes, procura de novo. **Firmware 1.4:** com servidor fixo (um IP no `secrets.h` ou salvo antes), se o broker falhar 3 vezes e o painel se anunciar em outro IP, a placa passa para `auto` sozinha e grava isso na NVS. O `status` traz `mq` (`true` quando o MQTT está conectado), e o painel usa isso para mostrar quando a placa está no Wi-Fi mas não alcança o servidor.

**Latência:** `NET_LOW_LATENCY 1` desliga o modem-sleep do Wi-Fi (respostas em milissegundos em vez de 100–300 ms, com ~80 mA a mais); o socket MQTT não usa Nagle; a TaskComms atende rede, comandos e alertas a cada 20 ms. O servidor mede a ida e volta com ping a cada 5 s e mostra na tela Dispositivo.

**Comandos do painel** (`echomap/<id>/cmd`, ou JSON pela Serial): `ping` (latência), `locate` (buzzers apitam por 4 s), `portal` (abre o portal), `wifi` (testa e salva uma rede), `server` (`{"host":"auto"}` ou um IP: onde procurar o servidor), `diag` (teste dos ultrassônicos) e `forget` (esquece a rede).

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
| `echomap/node1/telemetry` | distâncias, buzzers, modo e limiar (5×/s) |
| `echomap/node1/imu` | aceleração, giro, pico e inclinação (5×/s) |
| `echomap/node1/location` | posição do GPS (1×/s, só com fix) |
| `echomap/node1/events` | `NEAR_MISS`, `CRASH`, `FALL`, `IMPACT` |
| `echomap/node1/status` | versão, tempo ligado, memória, sinal, IP, rede, canal, servidor, MQTT conectado (`mq`), fila de alertas (a cada 5 s) |
| `echomap/node1/pong` | resposta ao ping do servidor |
| `echomap/node1/cmd` | (placa assina) `ping`, `locate`, `portal`, `wifi`, `server`, `diag`, `forget`; só o servidor pode publicar aqui |

O PC e a ESP32 precisam estar na mesma rede, e o firewall do PC precisa liberar a porta TCP 1883.

### Próxima etapa

- **Trocar os buzzers por motores de vibração** (alerta tátil, um de cada lado). A lógica de intensidade por distância continua a mesma: muda só o atuador e o circuito de acionamento.
- Medir a bateria e incluir `battery` (%) no `status` (o painel já gera `LOW_BATTERY`).
