# EchoMap — Dashboard dos responsáveis

Recebe os dados do nó principal EchoMap (ESP32) via **MQTT** (Wi-Fi) ou **Serial** (USB), guarda o histórico em SQLite e mostra tudo em tempo real num painel web para os responsáveis.

O painel segue o protótipo de 7 telas (`docs/prototipo/`): **Início** (cada dependente com a figura do eco, equilíbrio, local e pendências; ao lado, o último local com coordenadas e as ocorrências recentes), **Ao vivo** (figura do eco, distância de cada lado com a aproximação estimada pelo painel em cm/s e o tempo até o contato, intensidade de cada motor de vibração, equilíbrio, aceleração, gráfico e "Vibrar para localizar"), **Ocorrências** (resumo por categoria e linha do tempo por dia, separando críticas, aproximações e descartadas no "Estou bem"; 50 por vez, com "Mostrar mais"; o filtro fica na URL, ex.: `#/ocorrencias/aproximacao`, `criticas`, `descartadas`, `pendentes` ou `todas`) com **detalhe do alerta** (leituras no momento e linha do tempo), **Mapa** (o mapa ocupa a área útil inteira; posição, zonas seguras, âncora rápida, mapa de calor e locais por Wi-Fi ficam em painéis flutuantes), **Movimento** (equilíbrio, eixos do MPU-6050 e aceleração) e **Dispositivo** (conexão, Wi-Fi com QR Code, energia, calibração assistida de 30 s, teste dos sensores, os 7 avisos da linguagem háptica com um botão "Tocar" cada, nome e dados deste painel). No computador a navegação fica na lateral; no celular, em abas embaixo.

**Barra de status** (fixa no topo, em todas as telas): dispositivo selecionado, canal ativo (Wi-Fi/MQTT, USB ou offline), latência em ms, modo de energia (Ativo/Economia), fonte da localização (GPS com satélites ou ambiente interno por Wi-Fi) e a última leitura; o botão ao lado troca entre tema claro e escuro. No celular os valores aparecem abreviados.

**Visual:** todos os valores de cor, tipo, espaço e raio ficam em `public/tokens.css` (tema claro e escuro); o `style.css` só usa essas variáveis. A cor tem papel fixo: azul-cobalto para ação, esmeralda para conectado/saudável, âmbar para atenção/aproximação/economia e coral para crítico/offline. Os lados do eco não são estados: esquerda em cobalto claro, direita em tinta neutra. Ícones são SVG de traço 1,75 (estilo Lucide), sem emoji. Fontes: Plus Jakarta Sans na interface e JetBrains Mono nos números (cm, ms, g, coordenadas, satélites, horários e mensagens da placa, com `tabular-nums` para não tremerem), servidas localmente pelo `npm install` (`/vendor/fonts/sans` e `/vendor/fonts/mono`). Alvos de toque têm pelo menos 44 px no celular e o texto passa de 4,5:1 de contraste nos dois temas.

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

O simulador responde a ping, "vibrar para localizar", portal, rede Wi-Fi, teste dos sensores e troca de servidor, e gera os eventos como o firmware 1.5: `NEAR_MISS` pelo mesmo detector de TTC (`tools/ttc.mjs`, cópia do `ttc_detector.h`) e queda/batida só depois dos 5 s do pré-alerta, às vezes cancelada (`DISMISSED`). `--cancelar 0.5` muda a fração cancelada (padrão 0,4). `--economia` alterna 40 s ativo / 40 s em economia de energia. `--interno` desliga o GPS e manda a assinatura de Wi-Fi (a rede `EC:08:6B:12:34:56`) a cada 30 s; `--ancora` faz os "2 cliques" 10 s depois de conectar. Também responde aos comandos `haptic` e de calibração (progresso a cada 1 s e resultado no fim). A posição simulada fica em volta da zona Casa.

### Abrir em outro aparelho (senha do painel)

No próprio computador (`localhost`) o painel abre direto. Em outro aparelho da rede (`http://<IP-do-PC>:3000`, celular ou outro PC) ele mostra a tela **Entrar no painel** e pede a senha:

- sem `.env`, ela é gerada na primeira vez (8 letras e números, ex.: `k7mq-3xpa`), fica em `data/auth.json` (fora do Git) e aparece no terminal (linha `[SENHA]`) e em **Dispositivo → Este painel**, só no próprio computador; a senha gerada não diferencia maiúsculas;
- para escolher a sua, preencha `DASHBOARD_PASS` (e, se quiser, `DASHBOARD_USER`) no `.env` (ou `auth.password` no `config.json`); essa senha diferencia maiúsculas e nunca é impressa no terminal; trocar a senha desconecta os aparelhos que já tinham entrado;
- a senha é guardada como hash scrypt e comparada em tempo constante; `DASHBOARD_TRUST_LOCALHOST=0` pede login também no próprio PC;
- a sessão dura 30 dias (cookie `HttpOnly`); depois de 5 senhas erradas, aquele aparelho espera 30 s;
- `"auth": { "enabled": false }` desliga a senha (por exemplo, numa rede só sua).

O broker MQTT também foi fechado: só o próprio servidor publica em `echomap/<id>/cmd`. Um cliente qualquer da rede que tente mandar um comando para a placa é desconectado. Com `MQTT_USER` e `MQTT_PASS` no `.env`, o broker só aceita quem tiver essas credenciais (a placa recebe as mesmas em `secrets.h`, e o simulador lê o `.env` sozinho).

### Variáveis do `.env`

Copie `.env.example` para `.env` (fica fora do Git). Tudo é opcional.

| Variável | Para quê |
|---|---|
| `DASHBOARD_USER`, `DASHBOARD_PASS` | login do painel em outro aparelho |
| `SESSION_SECRET` | segredo que assina o cookie de sessão |
| `DASHBOARD_TRUST_LOCALHOST` | `0` pede login também no próprio PC |
| `MQTT_USER`, `MQTT_PASS` | autenticação no broker MQTT embutido (ou no externo, com `MQTT_URL`) |
| `EMAIL_ENABLED`, `EMAIL_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `AWS_REGION`, `EMAIL_FROM`, `ALERT_EMAIL_TO`, `EMAIL_COOLDOWN_S`, `PANEL_URL` | alertas por e-mail (abaixo) |
| `RETENTION_DAYS` | dias de telemetria bruta guardada (padrão 30) |

### Alertas por e-mail

Disparam para queda confirmada (`FALL` depois dos 5 s do "Estou bem"), `SOS`/`IMPACT` e `GEOFENCE_EXIT`; nunca para alerta descartado nem para quase colisão. Um e-mail por dispositivo e tipo a cada `EMAIL_COOLDOWN_S` (180 s), em fila assíncrona com novas tentativas após 5 s e 30 s; cada envio, falha ou bloqueio fica em `alert_notifications`.

Gmail, por exemplo (precisa de verificação em duas etapas e uma senha de app em myaccount.google.com/apppasswords):

```
EMAIL_ENABLED=1
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=voce@gmail.com
SMTP_PASS=abcdefghijklmnop
EMAIL_FROM=voce@gmail.com
ALERT_EMAIL_TO=responsavel@exemplo.com
```

Amazon SES: `EMAIL_PROVIDER=ses`, `AWS_REGION=us-east-1`, `SMTP_PORT=465` e as credenciais SMTP do SES em `SMTP_USER`/`SMTP_PASS`. `EMAIL_PROVIDER=mock` só registra no banco. Reinicie `npm start` (o terminal mostra a linha `[EMAIL]`) e use **Dispositivo → Alertas por e-mail → Enviar e-mail de teste**.

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
- Testes sem placa: `npm test` (senha do painel e zonas; TTC do simulador e eventos `NEAR_MISS`/`DISMISSED` no servidor; migração do banco e histórico de calibração; mapa de calor, locais por Wi-Fi e âncora rápida; detecção, hot-plug, várias placas, porta ocupada, liberar a porta e leitura da rede do PC).

## Contrato de dados (para os próximos sensores)

Tópico: `echomap/<deviceId>/<canal>`, com payload JSON.

| Canal | Exemplo de payload | Uso no painel |
|---|---|---|
| `telemetry` | `{"t":123,"mode":"RADAR","distL":87.2,"rawL":88,"distR":-1,"rawR":-1,"vibL":0.4,"vibR":0,"thr":120,"pot":0.55,"near":50}` | figura, cartões e gráfico. `near` é o `NEAR_MISS_CM` do firmware |
| `events` | `{"event":"NEAR_MISS","side":"L","value":25.1,"t":123}` | ocorrências e alertas |
| `location` | `{"lat":-23.55,"lon":-46.63,"acc":8,"hdop":1.3,"sats":9,"speed":0.1}` | mapa, trajeto e zonas seguras |
| `imu` | `{"ax":0.01,"ay":-0.02,"az":1.0,"gx":0.3,"gy":-0.2,"gz":0.1,"gMax":1.02,"tilt":4}` (g, °/s, °) | aceleração, pico e inclinação. Se vier `gMax` (firmware com MPU-6050), a placa detecta `FALL`/`IMPACT` sozinha; sem `gMax`, o servidor cria `IMPACT` acima de `impactG` |
| `status` | `{"fw":"1.7.0","up":120,"heap":201000,"pwr":"active","impG":2.5,"hyst":5.4,"cal":false,"mq":true,"rssi":-60,"ip":"192.168.0.42","ssid":"Casa","ch":6,"broker":"192.168.0.10:1883","auto":true,"q":0,"portal":false,"lowlat":1}` (+ `battery` quando houver sensor) | tela Dispositivo e barra de status: energia (`pwr` `active`/`idle`, Ativo/Economia), atuador (`act`), limiares em uso (`impG`, `hyst`) e calibração em andamento (`cal`), sinal, rede, servidor, fila de alertas (a cada 5 s); com `battery`, o servidor cria `LOW_BATTERY` |
| `calib` | `{"calib":"running","elapsed":12,"duration":30,"steps":21}` e, no fim, `{"calib":"done","type":"calibration_result","ok":true,"steps":57,"stepMax":1.5,"impactBefore":3,"impactAfter":2.5,"hystBefore":10,"hystAfter":5.4,...}` (também `failed`, `reset`, `cancelled`) | barra de progresso e antes/depois na tela Dispositivo; resultados vão para `calibrations` |
| `pong` | `{"pong":17,"t":5230}` | resposta ao ping do servidor: latência de ida e volta |
| `diag` | `{"diag":{"L":{"trig":18,"echo":19,"echoOk":true,"cm":62.4,"mv":-1,...},"R":{...,"mv":40}}}` | teste dos ultrassônicos (botão **Testar sensores** em Ao vivo): o painel explica o defeito de cada lado |
| `cmd` (servidor → placa) | `{"cmd":"ping","id":17}`, `{"cmd":"locate"}`, `{"cmd":"portal"}`, `{"cmd":"wifi","ssid":"Casa","pass":"..."}`, `{"cmd":"diag"}` | latência, vibrar forte por 4 s (localizar), abrir o portal, testar e salvar uma rede, testar os ultrassônicos. No `status`, `ap` é a rede do portal, `wtest` (`running`/`ok`/`fail`) e `wtry` o teste em andamento e `werr` o motivo da última falha (`senha`, `rede`, `tempo`) |

Tipos de evento que o painel já conhece: `NEAR_MISS`, `CRASH`, `SOS`, `FALL`, `IMPACT`, `DISMISSED`, `GEOFENCE_EXIT/ENTER`, `ANCHOR_CREATED/REMOVED/EXPIRED/FAILED`, `LOW_BATTERY`, `DEVICE_OFFLINE/ONLINE`. O `ANCHOR_TOGGLE` da placa não vira ocorrência: o servidor transforma no resultado (criada, removida ou sem posição).

- `NEAR_MISS` (firmware 1.5) traz `reason`: `"ttc"` (aproximação rápida, com `ttc` em segundos e `v` em cm/s) ou `"close"` (a menos de 25 cm). Obstáculo parado não gera mais ocorrência.
- `DISMISSED` é uma queda ou batida que a pessoa cancelou no botão nos 5 s do pré-alerta ("Estou bem"), com `cause` (`FALL`/`IMPACT`). Gravidade "info": não toca alarme nem fica pendente; aparece em **Ocorrências → Descartadas** e na lista da tela Movimento. Um tipo novo também é aceito: ele aparece com gravidade "info" até ser cadastrado em `server/hub.js` (`SEVERITY`).

Regras que o servidor já aplica:
- **Dispositivo sem sinal**: nenhuma mensagem por `offlineAfterMs`, ou na hora em que a conexão MQTT da placa cai.
- **Latência**: a cada `pingEveryMs` (5 s) o servidor manda um ping para cada placa online pelo Wi-Fi e mede a ida e volta.
- **Zona segura**: saída ou entrada nos círculos cadastrados na aba **Mapa** (clique no mapa para o centro, dê nome e raio de 20 a 5.000 m; **Remover** apaga). As zonas ficam no SQLite (tabela `safe_zones`, `type` = `fixed`); na primeira vez a tabela é preenchida com o `data/zones.json` da versão anterior (que vira `zones.json.importado`) ou, sem ele, com as `safeZones` do `config.json` (a zona **Casa**, -8.109656, -34.906301, raio de 100 m). Mudar as zonas não gera alerta falso: a próxima posição vale como a primeira.
- **Âncora rápida** (zona segura dinâmica, `type` = `dynamic`, uma por dispositivo): 2 cliques no botão do dispositivo ou **Criar âncora aqui** na aba Mapa criam um círculo de 100 m na posição atual por 4 h (`anchor` no `config.json`); 2 cliques de novo ou **Remover âncora** desligam. Sem posição no evento, usa a última posição do dispositivo (até 10 min); sem nenhuma, registra `ANCHOR_FAILED`. A cada 60 s as âncoras vencidas saem e viram `ANCHOR_EXPIRED` na linha do tempo. No mapa ficam tracejadas na cor do eco, com "expira em 3h 42m".
- **Ambiente interno por Wi-Fi**: quando chega uma assinatura de Wi-Fi (firmware 1.8) e o GPS está sem posição há mais de 15 s, o servidor procura os BSSIDs em `known_wifi_places`. Se uma rede cadastrada aparece com sinal acima do mínimo, a posição vira a do local (`source: "wifi_indoor"`, `placeName`), o topo do painel e a aba Mapa mostram "Ambiente interno conhecido: Casa (Wi-Fi)" e, se o local conta como zona segura, um GPS ruim de dentro de casa não gera "saiu da zona segura". O local vale por 90 s depois da última assinatura.
- **Impacto**: módulo da aceleração ≥ `thresholds.impactG`.
- **Bateria baixa**: ≤ `thresholds.lowBatteryPct`.

A faixa de "quase colisão" do painel usa o `near` que a placa manda na telemetria, então sempre bate com o `NEAR_MISS_CM` do `config.h`. O `thresholds.nearMissCm` só vale para fontes que não mandam `near`.

Se a placa estiver no USB e no Wi-Fi ao mesmo tempo, o servidor usa as leituras do MQTT e descarta eventos repetidos (mesmo tipo e mesmo `t` da placa).

## API

- `GET /api/state`: dispositivos, últimas ocorrências e configuração
- `GET /api/devices/:id/readings?kind=proximity|location|imu|status|net&minutes=10` (ou `&from=ms&to=ms`, até 1 h)
- `PATCH /api/devices/:id` com `{"name":"Ana"}`
- `GET /api/events?deviceId=node1&limit=100` e `POST /api/events/:id/ack`
- `POST /api/devices/:id/command` com `{"cmd":"locate"}` (vibrar para localizar), `{"cmd":"portal"}` (abrir o portal), `{"cmd":"diag"}` (testar os ultrassônicos), `{"cmd":"wifi","ssid":"...","pass":"..."}` (validado: rede até 32 caracteres, senha vazia ou de 8 a 63) ou `{"cmd":"server","host":"auto"}` (onde a placa procura o servidor: `auto` ou um IPv4); vai pelo MQTT e pelo cabo USB (pelo cabo, `server` vira a linha `servidor auto`, que o firmware 1.3 já entende); outros comandos são recusados
- `POST /api/devices/:id/command` também aceita `{"cmd":"haptic","pattern":"approach"}` (padrões: `static`, `proximity`, `approach`, `prealert`, `heartbeat`, `confirm`, `locate`), firmware 1.6
- `POST /api/devices/:id/command` com `{"cmd":"calibrate_start","duration_s":30}` (10 a 120 s), `{"cmd":"calibrate_stop"}` ou `{"cmd":"calibrate_reset"}` (padrões de fábrica), firmware 1.7
- `GET /api/devices/:id/calibrations?limit=20`: histórico de calibrações (feitas, que falharam e restaurações), mais recente primeiro, com antes/depois de cada limiar
- `GET /api/hotspots?min_score=0&limit=500&from=<iso|ms>&to=<iso|ms>`: áreas críticas (células geohash de ~19 × 38 m) com `risk_score` 0 a 100, contagem, críticas (impacto ou TTC ≤ 1 s), distância média e lado; `GET /api/hotspots/export?format=geojson|csv` baixa o mesmo como arquivo; cada mudança vai para o WebSocket como `hotspot`
- `GET /api/email/status`: provedor, se está ligado e os últimos envios; `POST /api/email/test` manda um e-mail de teste (precisa de login fora do localhost)
- `GET /api/heatmap?from=<iso|ms>&to=<iso|ms>&min_severity=info|warning|serious|critical&types=NEAR_MISS&deviceId=node1`: pontos `[lat, lng, intensidade]` das quase colisões (posição do próprio evento, ou o GPS mais próximo até 5 s antes/depois); intensidade maior para TTC menor, e ocorrências a ~5 m somam. Devolve também `total`, `matched`, `unmatched` e `max`
- `POST /api/safe-zones/anchor` com `{"deviceId":"node1","radiusM":100,"hours":4}` (sem `lat`/`lng` usa a posição atual) e `DELETE /api/safe-zones/anchor?deviceId=node1`
- `GET /api/wifi-places`, `POST /api/wifi-places` com `{"name":"Casa","bssid":"EC:08:6B:12:34:56","minRssi":-75,"lat":-8.109656,"lng":-34.906301,"isSafeZone":true}` e `DELETE /api/wifi-places/:id`; cada mudança vai para o WebSocket como `wifiPlaces`
- `POST /api/devices/:id/command` com `{"cmd":"wifi_scan"}`: varredura de Wi-Fi agora (firmware 1.8)
- `GET /api/zones`, `POST /api/zones` com `{"name":"Escola","lat":-8.11,"lon":-34.9,"radiusM":200}`, `PATCH /api/zones/:id` e `DELETE /api/zones/:id`; cada mudança vai para o WebSocket como `zones`
- `GET /api/login-info` (`{"userRequired":true|false}`, sem login), `POST /api/login` com `{"password":"..."}` (e `"user"` quando `DASHBOARD_USER` estiver definido) e `POST /api/logout` (só importam fora do localhost; sem sessão, a API responde 401 e as páginas levam para `/login.html`)
- `GET /api/serial` (estado do cabo: `searching`, `choose`, `connecting`, `connected`, `busy`, `paused`, portas encontradas), `POST /api/serial/connect` com `{"path":"COM5"}`, `POST /api/serial/auto` (volta à detecção automática), `POST /api/serial/release` com `{"minutes":3}` (solta a porta para gravar)
- `GET /api/host-wifi`: rede Wi-Fi deste computador (`ssid`, `channel`, `band` `2.4`/`5`), via `netsh` (Windows), `nmcli` (Linux) ou `networksetup` (macOS)
- `POST /api/host-wifi/password` com `{"ssid":"..."}`: senha salva no perfil do Windows (`netsh wlan show profile ... key=clear`); só responde para quem abre o painel no próprio PC (localhost)
- WebSocket `/ws` (mesma regra de senha): envia `reading`, `event`, `eventUpdated`, `device`, `serial` (estado do cabo), `log` (mensagens da placa pelo cabo), `zones` e `hotspot` em tempo real

## Estrutura

```
server/
  index.js        liga tudo: banco, hub, MQTT, cabo USB, e-mail, áreas críticas e WebSocket
  app.js          Express: login, arquivos estáticos e registro das rotas (createApp)
  routes/         devices.js, connection.js, places.js, hotspots.js, email.js
  services/       hotspots.js (geohash + risk_score, GeoJSON/CSV), geohash.js, emailNotifier.js (nodemailer, fila, cooldown)
  hub.js          normalização dos dados, eventos, regras (geofence, impacto, bateria, offline) e latência
  discovery.js    anúncio UDP para a placa achar o servidor sozinha
  db.js           SQLite (WAL, synchronous NORMAL, foreign_keys) com devices, readings, events, calibrations, collision_hotspots e alert_notifications; migrações idempotentes e retenção
  sources/mqtt.js broker embutido ou broker externo (MQTT_URL=mqtt://...)
  sources/serial.js cabo USB: detecção automática, hot-plug, escolha de porta, liberar porta
  hostwifi.js     rede Wi-Fi do computador (e senha salva, só no Windows e só localhost)
  auth.js         login do painel (scrypt, cookie assinado, bloqueio após 5 erros)
  zones.js        zonas seguras fixas e âncoras rápidas (tabela safe_zones)
  heatmap.js      mapa de calor: ocorrência + posição mais próxima (±5 s), peso pelo TTC
public/           dashboard (HTML/CSS/JS, sem build), tokens.css (design system) e login.html
tools/simulator.js simula a ESP32
tools/test-*.mjs  testes sem placa (npm test)
```

**Latência:** sockets sem algoritmo de Nagle (MQTT e HTTP), WebSocket sem compressão por mensagem e a tela redesenha no máximo uma vez por quadro. No firmware, o Wi-Fi fica sem modo de economia (`NET_LOW_LATENCY`) e a rede é atendida a cada 20 ms.

**Banco e migrações:** `server/db.js` roda `migrate()` toda vez que abre o banco. Cada passo é idempotente (`CREATE TABLE IF NOT EXISTS`, ou `ALTER TABLE` só se a coluna ainda não existe), então um `data/echomap.db` antigo é atualizado sem perder dados. A Fase 3 criou a tabela `calibrations` e a coluna `devices.calibrated_at`; a Fase 4 criou `safe_zones` (zonas fixas e âncoras, com `type` e `expires_at`), `known_wifi_places` e o índice `events(type, ts)` do mapa de calor. O progresso da calibração fica só em memória; os resultados vão para o histórico.

As leituras de alta frequência (5 Hz) são gravadas no banco no máximo 1 vez por segundo (`persistEveryMs`) e apagadas depois de `retentionDays`. Ocorrências nunca são apagadas.
