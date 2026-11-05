# EchoMap — Dashboard dos responsáveis

Recebe os dados do nó principal EchoMap (ESP32) via **MQTT** (Wi-Fi) ou **Serial** (USB), guarda o histórico em SQLite e mostra tudo em tempo real num dashboard web. A ideia é que ele sirva de base para as funções de controle parental (localização, queda, impacto, zonas seguras).

## Como rodar

Requer Node.js 22.13 ou mais novo (usa o SQLite que já vem no Node).

```bash
cd dashboard
npm install
npm start            # dashboard em http://localhost:3000, broker MQTT em :1883
```

Para testar sem a placa, use outro terminal:

```bash
npm run simulate       # só os 2 ultrassônicos, igual ao firmware atual
npm run simulate:all   # + GPS, acelerômetro (queda/impacto) e bateria
```

## Ligando a ESP32

### Opção A — Wi-Fi / MQTT (recomendado)

O servidor já inclui um broker MQTT, então não é preciso instalar o Mosquitto. No `config.h` do firmware:

```c
#define ENABLE_MQTT 1
#define MQTT_BROKER_IP "192.168.0.10"   // IP do PC (o servidor mostra os IPs ao iniciar)
#define MQTT_BROKER_PORT 1883
#define MQTT_TOPIC_TELEMETRY "echomap/node1/telemetry"
#define MQTT_TOPIC_EVENTS    "echomap/node1/events"
```

- O PC e a ESP32 precisam estar na mesma rede.
- Na primeira execução, o Windows Firewall pergunta se o Node pode aceitar conexões: libere para **redes privadas**. Se não perguntar, abra a porta TCP 1883.
- O segundo nível do tópico (`node1`) é o **ID do dispositivo**. Cada criança ou pulseira pode ter o seu.

### Opção B — Cabo USB (Serial)

Em `config.json`, ponha `"serial": { "enabled": true, "path": "COM3", ... }`, ou rode `SERIAL_PORT=COM3 npm start`. Feche o Serial Monitor do Arduino/PlatformIO antes, porque só um programa pode abrir a porta por vez. As linhas que não são JSON (como `[WiFi] Conectado`) aparecem no console do servidor.

## Contrato de dados (para os próximos sensores)

Tópico: `echomap/<deviceId>/<canal>`, com payload JSON.

| Canal | Exemplo de payload | Uso no painel |
|---|---|---|
| `telemetry` | `{"t":123,"mode":"RADAR","distL":87.2,"rawL":88,"distR":-1,"rawR":-1,"bzL":0.4,"bzR":0,"thr":120,"angle":0,"pot":0.55}` | figura, cartões e gráfico (já existe no firmware) |
| `events` | `{"event":"NEAR_MISS","side":"L","value":25.1,"t":123}` | ocorrências e alertas |
| `location` | `{"lat":-23.55,"lon":-46.63,"acc":8,"sats":9}` | mapa, trajeto e zonas seguras |
| `imu` | `{"ax":0.01,"ay":-0.02,"az":1.0}` (em g) | aceleração; o servidor cria `IMPACT` acima de `impactG` |
| `status` | `{"battery":64,"rssi":-60,"fw":"1.0"}` | bateria; o servidor cria `LOW_BATTERY` |

Tipos de evento que o painel já conhece: `NEAR_MISS`, `CRASH`, `SOS`, `FALL`, `IMPACT`, `GEOFENCE_EXIT/ENTER`, `LOW_BATTERY`, `DEVICE_OFFLINE/ONLINE`. Um tipo novo também é aceito: ele aparece com gravidade "info" até ser cadastrado em `server/hub.js` (`SEVERITY`).

Regras que o servidor já aplica:
- **Dispositivo sem sinal**: nenhuma mensagem por `offlineAfterMs`.
- **Zona segura**: saída ou entrada nos círculos de `safeZones` em `config.json`.
- **Impacto**: módulo da aceleração ≥ `thresholds.impactG`.
- **Bateria baixa**: ≤ `thresholds.lowBatteryPct`.

Para que a faixa de "quase colisão" do painel bata com o firmware, use em `thresholds.nearMissCm` o mesmo valor de `NEAR_MISS_CM` do `config.h`.

## API

- `GET /api/state`: dispositivos, últimas ocorrências e configuração
- `GET /api/devices/:id/readings?kind=proximity|location|imu|status&minutes=10`
- `PATCH /api/devices/:id` com `{"name":"Ana"}`
- `GET /api/events?deviceId=node1&limit=100` e `POST /api/events/:id/ack`
- `POST /api/devices/:id/command`: publica em `echomap/<id>/cmd` (o firmware ainda não assina esse tópico; é o ponto de partida para comandos como "tocar buzzer para localizar")
- WebSocket `/ws`: envia `reading`, `event`, `eventUpdated` e `device` em tempo real

## Estrutura

```
server/
  index.js        HTTP + API + WebSocket
  hub.js          normalização dos dados, eventos e regras (geofence, impacto, bateria, offline)
  db.js           SQLite (devices, readings, events)
  sources/mqtt.js broker embutido ou broker externo (MQTT_URL=mqtt://...)
  sources/serial.js leitura da USB
public/           dashboard (HTML/CSS/JS, sem build)
tools/simulator.js simula a ESP32
```

As leituras de alta frequência (5 Hz) são gravadas no banco no máximo 1 vez por segundo (`persistEveryMs`) e apagadas depois de `retentionDays`. Ocorrências nunca são apagadas.
