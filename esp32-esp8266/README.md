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
| `TaskSensors` | 1 | 2 | 60 ms | lê os dois HC-SR04 em sequência (30 ms entre eles, contra eco cruzado), filtra (EMA) e gera `NEAR_MISS` |
| `TaskStatusLed` | 1 | 1 | 20 ms | cor e pulsação do RGB conforme o modo |
| `TaskBuzzer` | 1 | 1 | 20 ms | volume de cada buzzer conforme a distância do seu lado |
| `TaskButton` | 0 | 2 | interrupção | clique curto troca o modo; clique longo (1,5 s) gera `CRASH` |
| `TaskImu` | 0 | 3 | 10 ms | lê o MPU-6050 a 100 Hz, detecta `FALL` e `IMPACT` e calcula a inclinação |
| `TaskGps` | 0 | 1 | 20 ms | lê as sentenças NMEA do NEO-6M (TinyGPSPlus) |
| `TaskComms` | 0 | 1 | 200 ms | envia telemetria, IMU, posição (1×/s) e eventos por Serial e, com `ENABLE_MQTT 1`, por MQTT |

Sincronização: mutex do estado compartilhado, fila de eventos e semáforo binário do botão (liberado pela ISR). A `TaskImu` fica no núcleo 0 para não interromper o `pulseIn()` dos ultrassônicos no núcleo 1.

### Queda, impacto e equilíbrio (MPU-6050)

A cada 10 ms o firmware calcula o módulo da aceleração (parado ≈ 1 g):

| Evento | Quando dispara |
|---|---|
| `FALL` (queda) | queda livre (abaixo de 0,5 g por pelo menos 60 ms) seguida de impacto ≥ 2 g em até 1 s |
| `IMPACT` (batida) | pancada ≥ 3 g sem queda livre antes |

- O valor enviado é o **pico** do impacto: o firmware espera 100 ms depois de passar do limiar.
- Depois de um evento, ignora 3 s para não repetir a mesma pancada.
- A **inclinação** (`tilt`) é o ângulo entre a gravidade agora e a gravidade medida no boot. Ela mostra se a pessoa está inclinada ou deitada, seja qual for a posição em que o módulo foi preso.
- Todos os limiares ficam no `config.h`. O `IMPACT_G` é igual ao `thresholds.impactG` do dashboard.

A lógica está em `include/imu_detector.h` e é testada no PC, sem a placa, com 12 cenários simulados: parado, andando, queda, queda em superfície macia, batida, pancada leve, tropeço, pulo, impacto atrasado, duas batidas seguidas e inclinação.

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
{"t":5230,"mode":"RADAR","distL":87.2,"rawL":88.0,"distR":-1.0,"rawR":-1.0,"bzL":0.40,"bzR":0.00,"thr":120,"angle":0,"pot":0.55}
{"ax":0.02,"ay":-0.01,"az":0.99,"gx":0.3,"gy":-0.2,"gz":0.1,"gMax":1.01,"tilt":4,"t":5230}
{"lat":-8.059280,"lon":-34.872030,"acc":6.5,"hdop":1.30,"sats":8,"speed":0.12,"t":6000}
{"event":"NEAR_MISS","side":"L","value":42.1,"t":6110}
{"event":"FALL","value":3.52,"unit":"g","t":7420}
{"event":"IMPACT","value":4.10,"unit":"g","t":9050}
{"event":"CRASH","t":9020}
```

`-1` significa nada no alcance. `gMax` é o maior módulo da aceleração desde a mensagem anterior. Os valores de latitude e longitude acima são só um exemplo de formato.

### MQTT

Em `include/config.h`:

```c
#define ENABLE_MQTT 1
#define WIFI_SSID "SUA_REDE_WIFI"
#define WIFI_PASSWORD "SUA_SENHA_WIFI"
#define MQTT_BROKER_IP "192.168.0.10"   // IP do PC que roda applications/dashboard
```

| Tópico | Conteúdo |
|---|---|
| `echomap/node1/telemetry` | distâncias, buzzers, modo e limiar (5×/s) |
| `echomap/node1/imu` | aceleração, giro, pico e inclinação (5×/s) |
| `echomap/node1/location` | posição do GPS (1×/s, só com fix) |
| `echomap/node1/events` | `NEAR_MISS`, `CRASH`, `FALL`, `IMPACT` |

O PC e a ESP32 precisam estar na mesma rede. Não faça commit da senha real do Wi-Fi.

### Próxima etapa

- **Trocar os buzzers por motores de vibração** (alerta tátil, um de cada lado). A lógica de intensidade por distância continua a mesma: muda só o atuador e o circuito de acionamento.
- Assinar `echomap/<id>/cmd` para receber comandos do painel (ex.: vibrar ou tocar para localizar).
- Publicar `echomap/<id>/status` (bateria, RSSI, versão do firmware).
