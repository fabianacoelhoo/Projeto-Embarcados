# Firmware – EchoMap

| Pasta | Placa | O que faz |
|---|---|---|
| [`no-principal/`](no-principal/) | ESP32 DevKit V1 | Lê os sensores, aciona RGB e buzzers, gera eventos e publica telemetria (Serial e MQTT) |

## Nó principal (`no-principal/`)

Projeto PlatformIO (`platformio.ini`, ambiente `esp32dev`, framework Arduino, biblioteca `knolleary/PubSubClient`).

```
no-principal/
  include/config.h   pinos, Wi-Fi/MQTT, limiares e períodos das tasks
  src/main.cpp       tasks FreeRTOS, leitura dos sensores, atuadores e comunicação
  backup/            versão anterior (1 HC-SR04 + IR + anel de LEDs), só para referência
```

### Como gravar

1. VS Code com a extensão **PlatformIO IDE** → *File > Open Folder* → `esp32-esp8266/no-principal`.
2. Ajuste `include/config.h` (pinos, Wi-Fi e broker; veja abaixo).
3. Barra inferior: ✓ **Build**, → **Upload**, 🔌 **Serial Monitor** (115200).

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

### Tasks FreeRTOS

| Task | Núcleo | Período | Função |
|---|---|---|---|
| `TaskSensors` | 1 | 60 ms | lê os dois HC-SR04 em sequência (30 ms entre eles, contra eco cruzado), filtra (EMA) e gera `NEAR_MISS` |
| `TaskStatusLed` | 1 | 20 ms | cor e pulsação do RGB conforme o modo |
| `TaskBuzzer` | 1 | 20 ms | volume de cada buzzer conforme a distância do seu lado |
| `TaskButton` | 0 | interrupção | clique curto troca o modo; clique longo (1,5 s) gera `CRASH` |
| `TaskComms` | 0 | 200 ms | envia telemetria e eventos pela Serial e, com `ENABLE_MQTT 1`, pelo MQTT |

Sincronização: mutex do estado compartilhado, fila de eventos e semáforo binário do botão (liberado pela ISR).

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
{"event":"NEAR_MISS","side":"L","value":42.1,"t":6110}
{"event":"CRASH","t":9020}
```

`-1` significa nada no alcance. Com MQTT ligado, a telemetria vai para `echomap/node1/telemetry` e os eventos para `echomap/node1/events`.

### MQTT

Em `include/config.h`:

```c
#define ENABLE_MQTT 1
#define WIFI_SSID "SUA_REDE_WIFI"
#define WIFI_PASSWORD "SUA_SENHA_WIFI"
#define MQTT_BROKER_IP "192.168.0.10"   // IP do PC que roda applications/dashboard
```

O PC e a ESP32 precisam estar na mesma rede. Não faça commit da senha real do Wi-Fi.

### Próxima etapa

- GPS NEO-6M publicando em `echomap/<id>/location`.
- MPU-6050 publicando em `echomap/<id>/imu` e gerando `FALL`. Atenção: os pinos 21/22 (I²C padrão) já estão com o LED RGB.
- Assinar `echomap/<id>/cmd` para receber comandos do painel (ex.: tocar o buzzer).
- Publicar `echomap/<id>/status` (bateria, RSSI, versão do firmware).
