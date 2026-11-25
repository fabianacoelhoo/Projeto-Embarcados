# EchoMap — Dashboard dos responsáveis

Recebe os dados do nó principal EchoMap (ESP32) via **MQTT** (Wi-Fi) ou **Serial** (USB), guarda o histórico em SQLite e mostra tudo em tempo real num painel web para os responsáveis.

O painel segue o protótipo de 7 telas (`docs/prototipo/`): **Início** (cada dependente com a figura do eco, equilíbrio, local e pendências), **Ao vivo** (distâncias, buzzers, gráfico e "Tocar buzzer"), **Ocorrências** com **detalhe do alerta** (leituras no momento e linha do tempo), **Mapa** (posição, trajeto e zonas seguras), **Movimento** (equilíbrio e aceleração) e **Dispositivo** (nome, conexão, sinal, latência e Wi-Fi). No computador a navegação fica na lateral; no celular, em abas embaixo. A fonte é a Atkinson Hyperlegible (feita para leitores com baixa visão), servida localmente pelo `npm install`.

## Como rodar

Requer Node.js 22.13 ou mais novo (usa o SQLite que já vem no Node).

```bash
cd applications/dashboard
npm install
npm start            # dashboard em http://localhost:3000, broker MQTT em :1883
```

Para testar sem a placa, use outro terminal:

```bash
npm run simulate       # só os 2 ultrassônicos
npm run simulate:all   # + GPS e acelerômetro (mesmo formato do firmware) e bateria
npm run simulate:all -- --discover   # acha o servidor pelo anúncio na rede, como a placa com "auto"
```

O simulador responde a ping, "tocar buzzer", portal, rede Wi-Fi, teste dos sensores e troca de servidor, como o firmware 1.4.

### Abrir em outro aparelho (senha do painel)

No próprio computador (`localhost`) o painel abre direto. Em outro aparelho da rede (`http://<IP-do-PC>:3000`, celular ou outro PC) ele mostra a tela **Entrar no painel** e pede a senha:

- ela aparece no terminal ao iniciar (linha `[SENHA]`) e em **Dispositivo → Este painel**, só quando o painel é aberto no próprio computador;
- é gerada na primeira vez (8 letras e números, ex.: `k7mq-3xpa`) e fica em `data/auth.json` (fora do Git); para escolher outra, preencha `auth.password` no `config.json`; trocar a senha desconecta os aparelhos que já tinham entrado;
- a sessão dura 30 dias (cookie `HttpOnly`); depois de 5 senhas erradas, aquele aparelho espera 30 s;
- `"auth": { "enabled": false }` desliga a senha (por exemplo, numa rede só sua).

O broker MQTT também foi fechado: só o próprio servidor publica em `echomap/<id>/cmd`. Um cliente qualquer da rede que tente mandar um comando para a placa é desconectado.

## Ligando a ESP32

### Opção A — Wi-Fi / MQTT (recomendado)

O servidor já inclui um broker MQTT, então não é preciso instalar o Mosquitto. Para conectar a placa ao Wi-Fi (pelo painel, pelo celular ou pela Serial), siga o [README principal](../../README.md#conectar-o-echomap-ao-wi-fi).

No painel, **Dispositivo → Wi-Fi do EchoMap** manda a rede para a placa pelo Wi-Fi ou pelo cabo USB (com `npm start -- --serial COM5`) e mostra o resultado do teste; o mesmo bloco tem o QR code da rede do portal (`EchoMap-<id>`, senha em `portal.password` no `config.json`). Durante a troca de rede pedida pelo painel, a queda de conexão não gera alerta de "sem sinal".

O servidor se anuncia na rede (UDP 47801) e a placa com servidor `auto` acha o IP do PC sozinha, mesmo que ele mude.

- O PC e a ESP32 precisam estar na mesma rede (2,4 GHz).
- Na primeira execução, o Windows Firewall pergunta se o Node pode aceitar conexões: libere para **redes privadas**. Se não perguntar, abra a porta TCP 1883.
- O segundo nível do tópico (`node1`) é o **ID do dispositivo**. Cada criança ou pulseira pode ter o seu.

### Opção B — Cabo USB (Serial), detectado sozinho

Basta ligar o cabo com o `npm start` rodando. A cada 2 s o servidor lista as portas e reconhece os conversores das placas ESP32 (CP210x `10C4`, CH340/CH9102 `1A86`, FTDI `0403`, PL2303 `067B`, USB nativo `303A`); portas Bluetooth ficam de fora. Uma placa só: conecta. Mais de uma: escolha a porta em **Dispositivo → Wi-Fi do EchoMap**. Tirou o cabo: volta a procurar.

- **Porta em uso** (Serial Monitor ou upload do PlatformIO): o painel avisa e o servidor tenta de novo a cada 5 s.
- **Liberar a porta**: solta a COM por 3 minutos para gravar o firmware, sem parar o servidor.
- `npm start -- --serial COM5` (ou `serial.path` no `config.json`) fixa uma porta; `--sem-usb` (ou `serial.auto: false`) desliga a detecção.
- O ID da placa vem do próprio status (`id`). As linhas que não são JSON (`[NET] ...`) aparecem no console e na tela Dispositivo, em **Mensagens da placa**. Pelo mesmo cabo o painel manda comandos (ex.: a rede Wi-Fi).
- Testes sem placa: `npm test` (senha do painel e zonas; detecção, hot-plug, várias placas, porta ocupada, liberar a porta e leitura da rede do PC).

## Contrato de dados (para os próximos sensores)

Tópico: `echomap/<deviceId>/<canal>`, com payload JSON.

| Canal | Exemplo de payload | Uso no painel |
|---|---|---|
| `telemetry` | `{"t":123,"mode":"RADAR","distL":87.2,"rawL":88,"distR":-1,"rawR":-1,"bzL":0.4,"bzR":0,"thr":120,"angle":0,"pot":0.55,"near":50}` | figura, cartões e gráfico. `near` é o `NEAR_MISS_CM` do firmware |
| `events` | `{"event":"NEAR_MISS","side":"L","value":25.1,"t":123}` | ocorrências e alertas |
| `location` | `{"lat":-23.55,"lon":-46.63,"acc":8,"hdop":1.3,"sats":9,"speed":0.1}` | mapa, trajeto e zonas seguras |
| `imu` | `{"ax":0.01,"ay":-0.02,"az":1.0,"gx":0.3,"gy":-0.2,"gz":0.1,"gMax":1.02,"tilt":4}` (g, °/s, °) | aceleração, pico e inclinação. Se vier `gMax` (firmware com MPU-6050), a placa detecta `FALL`/`IMPACT` sozinha; sem `gMax`, o servidor cria `IMPACT` acima de `impactG` |
| `status` | `{"fw":"1.2.0","up":120,"heap":201000,"rssi":-60,"ip":"192.168.0.42","ssid":"Casa","ch":6,"broker":"192.168.0.10:1883","auto":true,"q":0,"portal":false,"lowlat":1}` (+ `battery` quando houver sensor) | tela Dispositivo: sinal, rede, servidor, fila de alertas (a cada 5 s); com `battery`, o servidor cria `LOW_BATTERY` |
| `pong` | `{"pong":17,"t":5230}` | resposta ao ping do servidor: latência de ida e volta |
| `diag` | `{"diag":{"L":{"trig":18,"echo":19,"echoOk":true,"cm":62.4,"mv":-1,...},"R":{...,"mv":40}}}` | teste dos ultrassônicos (botão **Testar sensores** em Ao vivo): o painel explica o defeito de cada lado |
| `cmd` (servidor → placa) | `{"cmd":"ping","id":17}`, `{"cmd":"locate"}`, `{"cmd":"portal"}`, `{"cmd":"wifi","ssid":"Casa","pass":"..."}`, `{"cmd":"diag"}` | latência, tocar buzzer por 4 s, abrir o portal, testar e salvar uma rede, testar os ultrassônicos. No `status`, `ap` é a rede do portal, `wtest` (`running`/`ok`/`fail`) e `wtry` o teste em andamento e `werr` o motivo da última falha (`senha`, `rede`, `tempo`) |

Tipos de evento que o painel já conhece: `NEAR_MISS`, `CRASH`, `SOS`, `FALL`, `IMPACT`, `GEOFENCE_EXIT/ENTER`, `LOW_BATTERY`, `DEVICE_OFFLINE/ONLINE`. Um tipo novo também é aceito: ele aparece com gravidade "info" até ser cadastrado em `server/hub.js` (`SEVERITY`).

Regras que o servidor já aplica:
- **Dispositivo sem sinal**: nenhuma mensagem por `offlineAfterMs`, ou na hora em que a conexão MQTT da placa cai.
- **Latência**: a cada `pingEveryMs` (5 s) o servidor manda um ping para cada placa online pelo Wi-Fi e mede a ida e volta.
- **Zona segura**: saída ou entrada nos círculos cadastrados na aba **Mapa** (clique no mapa para o centro, dê nome e raio de 20 a 5.000 m; **Remover** apaga). As zonas ficam em `data/zones.json`; na primeira vez o arquivo nasce com as `safeZones` do `config.json` (hoje a zona **Casa**, -8.109656, -34.906301, raio de 100 m). Mudar as zonas não gera alerta falso: a próxima posição vale como a primeira.
- **Impacto**: módulo da aceleração ≥ `thresholds.impactG`.
- **Bateria baixa**: ≤ `thresholds.lowBatteryPct`.

A faixa de "quase colisão" do painel usa o `near` que a placa manda na telemetria, então sempre bate com o `NEAR_MISS_CM` do `config.h`. O `thresholds.nearMissCm` só vale para fontes que não mandam `near`.

Se a placa estiver no USB e no Wi-Fi ao mesmo tempo, o servidor usa as leituras do MQTT e descarta eventos repetidos (mesmo tipo e mesmo `t` da placa).

## API

- `GET /api/state`: dispositivos, últimas ocorrências e configuração
- `GET /api/devices/:id/readings?kind=proximity|location|imu|status|net&minutes=10` (ou `&from=ms&to=ms`, até 1 h)
- `PATCH /api/devices/:id` com `{"name":"Ana"}`
- `GET /api/events?deviceId=node1&limit=100` e `POST /api/events/:id/ack`
- `POST /api/devices/:id/command` com `{"cmd":"locate"}` (tocar buzzer), `{"cmd":"portal"}` (abrir o portal), `{"cmd":"diag"}` (testar os ultrassônicos), `{"cmd":"wifi","ssid":"...","pass":"..."}` (validado: rede até 32 caracteres, senha vazia ou de 8 a 63) ou `{"cmd":"server","host":"auto"}` (onde a placa procura o servidor: `auto` ou um IPv4); vai pelo MQTT e pelo cabo USB (pelo cabo, `server` vira a linha `servidor auto`, que o firmware 1.3 já entende); outros comandos são recusados
- `GET /api/zones`, `POST /api/zones` com `{"name":"Escola","lat":-8.11,"lon":-34.9,"radiusM":200}`, `PATCH /api/zones/:id` e `DELETE /api/zones/:id`; cada mudança vai para o WebSocket como `zones`
- `POST /api/login` com `{"password":"..."}` e `POST /api/logout` (só importam fora do localhost; sem sessão, a API responde 401 e as páginas levam para `/login.html`)
- `GET /api/serial` (estado do cabo: `searching`, `choose`, `connecting`, `connected`, `busy`, `paused`, portas encontradas), `POST /api/serial/connect` com `{"path":"COM5"}`, `POST /api/serial/auto` (volta à detecção automática), `POST /api/serial/release` com `{"minutes":3}` (solta a porta para gravar)
- `GET /api/host-wifi`: rede Wi-Fi deste computador (`ssid`, `channel`, `band` `2.4`/`5`), via `netsh` (Windows), `nmcli` (Linux) ou `networksetup` (macOS)
- `POST /api/host-wifi/password` com `{"ssid":"..."}`: senha salva no perfil do Windows (`netsh wlan show profile ... key=clear`); só responde para quem abre o painel no próprio PC (localhost)
- WebSocket `/ws` (mesma regra de senha): envia `reading`, `event`, `eventUpdated`, `device`, `serial` (estado do cabo), `log` (mensagens da placa pelo cabo) e `zones` em tempo real

## Estrutura

```
server/
  index.js        HTTP + API + WebSocket
  hub.js          normalização dos dados, eventos, regras (geofence, impacto, bateria, offline) e latência
  discovery.js    anúncio UDP para a placa achar o servidor sozinha
  db.js           SQLite (devices, readings, events)
  sources/mqtt.js broker embutido ou broker externo (MQTT_URL=mqtt://...)
  sources/serial.js cabo USB: detecção automática, hot-plug, escolha de porta, liberar porta
  hostwifi.js     rede Wi-Fi do computador (e senha salva, só no Windows e só localhost)
  auth.js         senha do painel para outros aparelhos (cookie assinado, bloqueio após 5 erros)
  zones.js        zonas seguras editáveis (data/zones.json)
public/           dashboard (HTML/CSS/JS, sem build) e login.html
tools/simulator.js simula a ESP32
tools/test-*.mjs  testes sem placa (npm test)
```

**Latência:** sockets sem algoritmo de Nagle (MQTT e HTTP), WebSocket sem compressão por mensagem e a tela redesenha no máximo uma vez por quadro. No firmware, o Wi-Fi fica sem modo de economia (`NET_LOW_LATENCY`) e a rede é atendida a cada 20 ms.

As leituras de alta frequência (5 Hz) são gravadas no banco no máximo 1 vez por segundo (`persistEveryMs`) e apagadas depois de `retentionDays`. Ocorrências nunca são apagadas.
