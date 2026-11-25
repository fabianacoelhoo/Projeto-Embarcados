# EchoMap

**Dispositivo vestível com ESP32 que avisa os responsáveis quando uma criança, um idoso ou outra pessoa vulnerável chega perto demais de um obstáculo, sofre um impacto ou sai de uma zona segura.**

Projeto da disciplina **Sistemas Embarcados – CESAR School (2026.1)** · Grupo 19.

![Arquitetura do EchoMap](docs/img/arquitetura.png)

## O problema

Crianças com dificuldade de locomoção ou de percepção do ambiente, idosos e outras pessoas vulneráveis podem esbarrar em obstáculos, cair ou se afastar de um lugar seguro sem que ninguém perceba na hora. O EchoMap junta, num dispositivo pequeno preso ao corpo (pulseira, cinto ou colete):

- **percepção do entorno**: dois sensores ultrassônicos (esquerda e direita) e buzzers que apitam mais alto quanto mais perto está o obstáculo;
- **eventos para os responsáveis**: quase colisão, impacto/queda e pedido manual de ajuda, enviados via MQTT;
- **painel dos responsáveis**: distâncias em tempo real, histórico, ocorrências, localização e zonas seguras.

## Estrutura do repositório

| Pasta | Conteúdo |
|---|---|
| [`esp32-esp8266/`](esp32-esp8266/) | Firmware do nó principal (ESP32 + FreeRTOS, PlatformIO) |
| [`applications/`](applications/) | Back-end (Node.js, broker MQTT, SQLite) e dashboard web dos responsáveis |
| [`schematics/`](schematics/) | Diagrama de ligações e tabela de pinos |
| [`docs/`](docs/) | Arquitetura, contrato MQTT, protótipo do front-end, fotos dos componentes e relatórios |

## Como rodar

### 1. Dashboard e back-end (PC)

Requer Node.js 22.13 ou mais novo.

```bash
cd applications/dashboard
npm install
npm start                 # http://localhost:3000 · broker MQTT em :1883
```

No próprio computador o painel abre direto. Em **outro aparelho** (celular, outro PC da rede, `http://<IP-do-PC>:3000`) ele pede a **senha do painel**, que aparece no terminal ao iniciar (linha `[SENHA]`) e em **Dispositivo → Este painel**. Ela é gerada na primeira vez e fica em `data/auth.json`; para escolher outra, preencha `auth.password` no `config.json`.

Sem a placa, simule a ESP32 em outro terminal:

```bash
npm run simulate          # só os 2 ultrassônicos
npm run simulate:all      # + GPS e acelerômetro (igual ao firmware atual) e bateria
```

### 2. Firmware (ESP32)

1. Instale a extensão **PlatformIO IDE** no VS Code e abra a pasta `esp32-esp8266/no-principal`.
2. **Build → Upload → Serial Monitor** (115200 baud).
3. Conecte o EchoMap ao Wi-Fi (próxima seção).

Detalhes em [`esp32-esp8266/README.md`](esp32-esp8266/README.md).

## Conectar o EchoMap ao Wi-Fi

Não é preciso regravar o firmware nem digitar o IP do computador. Use uma rede de **2,4 GHz** (a ESP32 não enxerga 5 GHz) e deixe o `npm start` rodando no PC, na mesma rede.

Toda rede nova é **testada antes de ser salva**: se não conectar em 20 s, o EchoMap volta para a rede anterior e diz o motivo (senha incorreta, rede não encontrada...). Enquanto testa, o LED pisca em azul-claro.

### Jeito 1: pelo painel (mais fácil)

1. Rode `npm start` e ligue o EchoMap no **cabo USB**. O servidor acha a placa sozinho (CP210x, CH340/CH9102, FTDI ou USB nativo da ESP32; portas Bluetooth são ignoradas). Com mais de uma placa, escolha a porta no painel.
2. Abra `http://localhost:3000` → **Dispositivo** → **Wi-Fi do EchoMap**. O selo no topo mostra por onde a configuração vai: **via cabo USB (COMx)**, **via Wi-Fi** ou **EchoMap desconectado** (nesse caso o card mostra os dois caminhos: cabo e celular).
3. Clique em **Usar a rede deste computador**: o nome da rede é preenchido. No Windows, **Preencher a senha salva do Windows** traz a senha (só abrindo o painel no próprio PC). Ou digite rede e senha.
4. Clique em **Conectar a esta rede**. O teste e as mensagens da placa aparecem ali mesmo, na hora.

Se o computador estiver numa rede de **5 GHz**, o painel avisa: o EchoMap só conecta em 2,4 GHz. Funciona se o roteador usa o mesmo nome nas duas faixas; senão, use o nome da rede 2,4 GHz.

**Gravar o firmware com o servidor rodando:** o servidor fica com a porta USB. Clique em **Liberar a porta** (ao lado do selo) antes do Upload no PlatformIO; depois de 3 minutos ele volta a usar o cabo sozinho. `npm start -- --serial COM5` fixa uma porta e `npm start -- --sem-usb` desliga a detecção.

### Jeito 2: pelo celular

1. Dê **3 cliques rápidos** no botão do EchoMap (ou clique em **Abrir o portal no celular** no painel). O LED fica azul, pulsando. Na primeira vez, sem rede salva, o portal já abre sozinho.
2. No celular, entre na rede **`EchoMap-node1`**, senha **`echomap123`**, ou aponte a câmera para o QR code da tela Dispositivo.
3. A página abre sozinha (se não abrir, acesse `192.168.4.1`). Toque na rede da casa, digite a senha e toque em **Testar e salvar**. A página mostra se deu certo; depois volte o celular para a sua rede.

### Jeito 3: pela Serial (Serial Monitor do PlatformIO)

```
wifi "Nome da rede" "senha"      testa e salva a rede
status                           estado completo em JSON (o painel usa pelo cabo)
rede                             mostra rede, IP, servidor e último erro
portal                           abre o portal do celular
servidor auto                    acha o PC sozinho (ou: servidor 192.168.0.10)
esquecer                         apaga a rede salva e abre o portal
```

### O que o EchoMap faz sozinho

- **Acha o computador do painel**: o servidor se anuncia na rede e o EchoMap (com servidor `auto`) usa esse endereço; ele lembra o último servidor e reconecta na hora no próximo boot.
- **Nunca fica preso numa rede errada**: a rede salva pelo painel/portal/Serial vale mais que a do `secrets.h` (que só é usada enquanto nada foi salvo). Se a rede não conectar em **15 s**, o portal abre sozinho e a Serial continua aceitando comandos; se a rede voltar e ninguém estiver no portal, ele fecha.
- **Avisa o motivo** de não conectar na Serial, no portal e no painel.
- **Não fica preso num IP de servidor antigo**: se o servidor estiver fixo (ex.: `172.26.121.65` de outra rede), não responder 3 vezes e o painel se anunciar em outro IP, o EchoMap passa para `auto` sozinho (firmware 1.4). Pelo painel, **Dispositivo → Encontrar o servidor automaticamente** faz o mesmo (pelo Wi-Fi ou pelo cabo, inclusive no firmware 1.3).

### Se não conectar

| O que aparece | O que fazer |
|---|---|
| "senha incorreta" | digite a senha de novo (maiúsculas contam) |
| "rede não encontrada" | a rede está longe ou é de 5 GHz; use a de 2,4 GHz ou o roteador do celular |
| Wi-Fi conecta, mas "Procurando o painel na rede..." não para | o `npm start` precisa estar rodando na mesma rede; redes de faculdade/empresa costumam isolar os aparelhos: use o roteador do celular em 2,4 GHz |
| "Painel ... não respondeu" | libere a porta TCP 1883 no firewall do Windows e deixe a rede como **Privada** |
| Painel mostra "O EchoMap está no Wi-Fi, mas não alcança este servidor" | clique em **Encontrar o servidor automaticamente** (ou digite `servidor auto` na Serial) |

Para liberar o firewall (PowerShell como administrador):

```powershell
New-NetFirewallRule -DisplayName "EchoMap MQTT" -Direction Inbound -Protocol TCP -LocalPort 1883 -Action Allow -Profile Private
```

## Status (checkpoint de 25/11/2026)

| Parte | Situação |
|---|---|
| Firmware: 2× HC-SR04, potenciômetro, botão, LED RGB, 2 buzzers, FreeRTOS (5 tasks) | implementado |
| Firmware: publicação MQTT | ligada; reconecta sem travar as tasks e reenvia eventos perdidos |
| Back-end: broker embutido, API REST, WebSocket, SQLite, regras de alerta | funcionando (testado com o simulador) |
| Dashboard web em tempo real | funcionando (testado com o simulador) |
| Firmware: GPS NEO-6M (posição) e MPU-6050 (queda, batida e inclinação) | implementado; lógica de queda testada no PC |
| Trocar buzzers por motores de vibração (alerta tátil) | próxima etapa |
| Status da placa (sinal Wi-Fi, versão, memória) em `echomap/<id>/status` | implementado |
| Wi-Fi configurado pelo painel (cabo USB detectado sozinho, rede do PC com 1 clique), pelo celular (portal) ou pela Serial, com teste antes de salvar; servidor encontrado automaticamente | implementado |
| Comandos do painel para a placa (latência, tocar buzzer, reabrir portal) | implementado |
| Painel refeito com as 7 telas do protótipo | implementado |
| Zonas seguras editáveis no Mapa (zona "Casa" real cadastrada) | implementado |
| Senha do painel para outros aparelhos e broker que só aceita comandos do servidor | implementado |
| Quase colisão sem rajada: confirma em 2 leituras e no máximo 1 alerta a cada 10 s por lado | implementado (firmware 1.4) |

## Tecnologias

ESP32 · FreeRTOS · C++ (Arduino/PlatformIO) · MQTT (PubSubClient, Aedes) · Node.js · Express · WebSocket · SQLite · HTML/CSS/JS · Leaflet

## Equipe – Grupo 19

| Integrante |
|---|
| Amanda Montarroios |
| Bruno Assunção |
| Carlos Espósito |
| Fabiana Souza Leão |
| Felipe Marques |
| Jerônimo Barbosa (representante) |
| Mateus Ribeiro |

Professores: Bella Nunes e Jymmy Barreto.
