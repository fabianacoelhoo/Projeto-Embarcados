"""Gera docs/img/arquitetura.svg (arquitetura completa do EchoMap, firmware 1.9).

Uso:  python docs/img/gerar_arquitetura.py
PNG:  rsvg-convert -w 1900 docs/img/arquitetura.svg -o docs/img/arquitetura.png
So usa a biblioteca padrao do Python. Ao mudar tasks, canais MQTT, regras ou telas,
atualize as listas abaixo e gere de novo.
"""
import os

SAIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "arquitetura.svg")
W, H = 1900, 920
out = []


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def t(x, y, s, size=13, cor="#1f2937", peso=400, anc="start", mono=False):
    fam = ' font-family="DejaVu Sans Mono, monospace"' if mono else ""
    out.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{cor}" font-weight="{peso}" '
               f'text-anchor="{anc}"{fam}>{esc(s)}</text>')


def rect(x, y, w, h, fill, stroke="none", rx=10, sw=1.5, dash=False):
    d = ' stroke-dasharray="6 4"' if dash else ""
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" '
               f'stroke="{stroke}" stroke-width="{sw}"{d}/>')


def caixa(x, y, w, titulo, linhas, cor, fundo="#ffffff", dash=False, lh=18):
    h = 40 + lh * len(linhas) + 8
    rect(x, y, w, h, fundo, cor, 10, 2, dash)
    t(x + 14, y + 26, titulo, 15, cor, 700)
    for i, s in enumerate(linhas):
        peso = 600 if s.startswith("▸") else 400
        t(x + 14, y + 50 + i * lh, s.lstrip("▸ ") if peso == 600 else s, 12.5,
          "#111827" if peso == 600 else "#374151", peso)
    return y + h


def seta(x1, y1, x2, y2, cor="#475569", rot=None, dash=False, dy_rot=-8):
    d = ' stroke-dasharray="7 5"' if dash else ""
    out.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{cor}" stroke-width="2.4"'
               f' marker-end="url(#ponta)"{d}/>')
    if rot:
        t((x1 + x2) / 2, (y1 + y2) / 2 + dy_rot, rot, 11.5, cor, 600, "middle")


out.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
           'font-family="DejaVu Sans, Arial, Helvetica, sans-serif">')
out.append('<defs><marker id="ponta" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">'
           '<path d="M0,0 L10,4 L0,8 z" fill="#475569"/></marker></defs>')
rect(0, 0, W, H, "#ffffff", rx=0)
t(50, 54, "EchoMap — Arquitetura do sistema (firmware 2.0)", 28, peso=700)
t(50, 84, "Do colete ao painel dos responsáveis · gerado por docs/img/gerar_arquitetura.py · "
  "tracejado = previsto, ainda não montado", 14, "#6b7280")
out.append(f'<line x1="50" y1="102" x2="{W-50}" y2="102" stroke="#FF6000" stroke-width="3"/>')

COLS = [(50, "1 · COLETE (VESTÍVEL)"), (510, "2 · ESP32 · FreeRTOS"), (1000, "3 · SERVIDOR LOCAL (PC)"),
        (1470, "4 · RESPONSÁVEIS")]
for x, nome in COLS:
    t(x, 136, nome, 15, "#FF6000", 700)

# ---- 1. colete
y = 152
y = caixa(50, y, 410, "Case central (bolso 78 × 160)", [
    "ESP32 DevKit 38 pinos (D0WD-V3, CP2102)",
    "MPU-6050 em prateleira rígida e plana",
    "Potenciômetro WH148: limiar 20–200 cm",
    "LED RGB 5 mm · push-button 6×6 mm",
    "USB-C acessível por fora",
], "#0f766e") + 14
y = caixa(50, y, 410, "2× suporte “farol” na alça de 60 mm", [
    "HC-SR04 (esquerdo / direito), cone de 15° livre",
    "Motor de vibração MV50 do mesmo lado,",
    "na metade interna, encostado no peito",
    "Catraca sem parafuso: fita de 1,6 a 2,8 mm",
], "#0f766e") + 14
y = caixa(50, y, 410, "Case do GPS no ombro (perfil 11,4 mm)", [
    "NEO-6M (GY-GPS6MV2) + antena cerâmica",
    "1,2 mm de plástico sobre a antena (céu livre)",
], "#0f766e") + 14
y = caixa(50, y, 410, "Mecânica 3D (hardware/cad)", [
    "build123d paramétrico · STL/STEP · renders",
    "verify.py: colisão, snap-fit, balanço",
], "#64748b") + 14
caixa(50, y, 410, "Bateria 3,7 V + TP4056 + MT3608", [
    "previsto: medição no GPIO34 (reservado)",
], "#9ca3af", dash=True)

# ---- 2. ESP32
y = 152
y = caixa(510, y, 440, "Core 1 (tempo real dos sensores)", [
    "▸ TaskSensors · 60 ms · prioridade 2",
    "2× HC-SR04 alternados, filtro EMA, TTC por lado",
    "NEAR_MISS só no crítico (≤ 1,5 s ou < 25 cm)",
    "▸ TaskHaptic · 10 ms · linguagem háptica",
    "7 padrões por lado nos motores MV50 (PWM 20 kHz)",
    "▸ TaskStatusLed · 20 ms · cor do LED RGB",
], "#1d4ed8") + 14
y = caixa(510, y, 440, "Core 0 (eventos e rede)", [
    "▸ TaskImu · 5 ms (200 Hz) · prioridade 3",
    "queda, batida, inclinação · pré-alerta de 5 s",
    "▸ TaskButton · interrupção · gestos",
    "1 clique: radar ↔ autoteste · 2: âncora rápida",
    "3: portal Wi-Fi · 1,5 s: SOS · pré-alerta: “Estou bem”",
    "▸ TaskGps · 20 ms · NMEA (TinyGPSPlus)",
    "▸ TaskComms · 20 ms · Wi-Fi, MQTT, Serial, comandos",
], "#1d4ed8") + 14
caixa(510, y, 440, "Serviços do firmware", [
    "Economia: parado 2 min → sensores 1 Hz + modem-sleep",
    "Calibração assistida (30 s andando) salva na NVS",
    "Assinatura Wi-Fi (BSSID) quando o GPS some 15 s",
    "Portal cativo de Wi-Fi · descoberta do servidor (auto)",
    "Mutex do estado · fila de eventos · semáforo da ISR",
], "#1d4ed8")

# ---- transporte (entre 2 e 3)
caixa(510, 690, 920, "Comunicação em dois canais (mesmo JSON)", [
    "Wi-Fi 2,4 GHz → MQTT TCP :1883 · echomap/<id>/<canal>",
    "Descoberta UDP :47801: placa com servidor “auto” acha o PC",
    "Cabo USB: Serial 115200, porta detectada sozinha",
    "Com os dois ligados, o servidor descarta duplicatas",
    "Canais: telemetry · events · location · imu · status",
    "pong · diag · calib · wifi    |    comandos: …/cmd",
], "#7c3aed")

# ---- 3. servidor
y = 152
y = caixa(1000, y, 430, "Node.js 22 (applications/dashboard)", [
    "▸ Broker MQTT embutido (Aedes) :1883",
    "só o servidor publica em …/cmd",
    "▸ hub.js: normaliza Wi-Fi e USB, gera eventos",
    "▸ Regras de alerta",
    "NEAR_MISS · CRASH/SOS · FALL · IMPACT · DISMISSED",
    "zona segura fixa + âncora rápida (100 m, 4 h)",
    "fallback interno: local conhecido pelo Wi-Fi",
    "dispositivo offline · bateria (regra pronta)",
    "▸ Mapa de calor: quase colisões × GPS (~5 m)",
    "▸ API REST /api + WebSocket /ws",
    "▸ Senha do painel fora do próprio PC",
], "#b45309") + 14
y = caixa(1000, y, 430, "SQLite (node:sqlite)", [
    "devices · readings (1/s) · events · calibrations",
    "safe_zones · known_wifi_places",
    "migrate() idempotente na partida",
], "#b45309") + 14
caixa(1000, y, 430, "Simulador e testes", [
    "tools/simulator.js: mesmo JSON do firmware",
    "npm test (painel, eventos, calibração, fase 4, USB)",
], "#b45309")

# ---- 4. responsáveis
y = 152
y = caixa(1470, y, 380, "Dashboard web (7 telas)", [
    "▸ Início: estado geral e últimos alertas",
    "▸ Ao vivo: esquerda/direita, distância e limiar",
    "▸ Ocorrências + detalhe do alerta (“Ciente”)",
    "▸ Mapa: trajeto, zonas seguras, âncora,",
    "mapa de calor e locais por Wi-Fi",
    "▸ Movimento: queda, batida, inclinação",
    "▸ Dispositivo: Wi-Fi, comandos, calibração,",
    "teste da linguagem háptica, latência",
    "Notificações do navegador · Leaflet (mapa)",
], "#be185d") + 14
caixa(1470, y, 380, "Responsáveis", [
    "pais, cuidadores de crianças, idosos",
    "ou pessoas com deficiência visual",
], "#be185d")

# ---- setas
seta(460, 260, 508, 260, rot="sensores", dy_rot=-10)
seta(508, 300, 460, 300, rot="vibração", dy_rot=18)
seta(950, 300, 998, 300, rot="MQTT/USB")
seta(998, 360, 950, 360, rot="…/cmd", dy_rot=18)
seta(1430, 300, 1468, 300, rot="WS")
seta(1468, 360, 1430, 360, rot="REST", dy_rot=18)
seta(730, 650, 730, 688, "#7c3aed")
seta(1215, 688, 1215, 614, "#7c3aed")

t(50, H - 30, "Fonte: esp32-esp8266/no-principal (config.h, main.cpp, net.cpp), applications/dashboard/server, "
  "hardware/cad. Bateria: ainda não medida (GPIO34 reservado).", 12.5, "#6b7280")
out.append("</svg>")
open(SAIDA, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
print("gerado", SAIDA)
