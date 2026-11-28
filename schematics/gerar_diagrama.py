"""Gera schematics/diagrama-ligacoes.svg a partir da pinagem de
esp32-esp8266/no-principal/include/config.h (le os #define PIN_* do arquivo).

Uso:  python schematics/gerar_diagrama.py
PNG:  rsvg-convert -w 1700 schematics/diagrama-ligacoes.svg -o schematics/diagrama-ligacoes.png
      (ou: pip install cairosvg && python -m cairosvg ... )
So usa a biblioteca padrao do Python.
"""
import os
import re

AQUI = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(AQUI, "..", "esp32-esp8266", "no-principal", "include", "config.h")
SAIDA = os.path.join(AQUI, "diagrama-ligacoes.svg")


def ler_pinos(caminho):
    txt = open(caminho, encoding="utf-8", errors="replace").read()
    return {m.group(1): int(m.group(2)) for m in re.finditer(r"#define\s+(PIN_\w+)\s+(\d+)", txt)}


P = ler_pinos(CONFIG)

# ESP32 DevKit 38 pinos (ESP32-D0WD-V3, CP2102, USB-C embaixo), de cima para baixo
ESQ = ["3V3", "EN", "36", "39", "34", "35", "32", "33", "25", "26", "27", "14", "12", "GND", "13",
       "SD2", "SD3", "CMD", "5V"]
DIR = ["GND", "23", "22", "1", "3", "21", "GND", "19", "18", "5", "17", "16", "4", "0", "2", "15",
       "SD1", "SD0", "CLK"]
APELIDO = {"36": "VP", "39": "VN", "1": "TX0", "3": "RX0", "17": "TX2", "16": "RX2"}
FLASH = {"SD2", "SD3", "CMD", "SD1", "SD0", "CLK"}
BOOT = {"0", "2", "5", "12", "15"}

W, H = 1760, 1330
BX0, BX1 = 740, 1020
Y0, DY = 250, 44
COR = {"hc": "#2563eb", "pot": "#0891b2", "imu": "#7c3aed", "act": "#ea580c", "rgb": "#db2777",
       "gps": "#16a34a", "btn": "#475569", "pwr5": "#dc2626", "pwr3": "#f59e0b", "gnd": "#111827"}

out = []


def t(x, y, s, size=14, cor="#1f2937", peso=400, anc="start", mono=False):
    fam = ' font-family="DejaVu Sans Mono, monospace"' if mono else ""
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    out.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{cor}" font-weight="{peso}" '
               f'text-anchor="{anc}"{fam}>{s}</text>')


def rect(x, y, w, h, fill, stroke="none", rx=8, dash=False, sw=1.5):
    d = ' stroke-dasharray="6 4"' if dash else ""
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" '
               f'stroke="{stroke}" stroke-width="{sw}"{d}/>')


def linha(pts, cor, sw=2.4, dash=False):
    d = ' stroke-dasharray="7 5"' if dash else ""
    p = " ".join(f"{x},{y}" for x, y in pts)
    out.append(f'<polyline points="{p}" fill="none" stroke="{cor}" stroke-width="{sw}" '
               f'stroke-linejoin="round"{d}/>')
    for x, y in (pts[0], pts[-1]):
        out.append(f'<circle cx="{x}" cy="{y}" r="3.6" fill="{cor}"/>')


def pino_y(lado, nome):
    lst = ESQ if lado == "E" else DIR
    return Y0 + lst.index(nome) * DY


def pino_x(lado):
    return BX0 if lado == "E" else BX1


usados = {}


FIOS = []


def fio(lado, gpio, origem, _canal, cor, rotulo=None, dash=False):
    """Registra um fio ortogonal componente -> canal vertical -> pino; rotear() desenha."""
    FIOS.append((lado, str(gpio), origem, cor, rotulo, dash))


def rotear():
    """Escolhe o canal de cada fio para nao cruzar: fios que descem ficam mais perto da
    placa quanto mais alto comecam; fios que sobem, quanto mais baixo comecam."""
    for lado, x_placa, passo in (("E", BX0 - 34, -14), ("D", BX1 + 34, 14)):
        fs = [f for f in FIOS if f[0] == lado]
        desce = sorted([f for f in fs if f[2][1] <= pino_y(lado, f[1])], key=lambda f: f[2][1])
        sobe = sorted([f for f in fs if f[2][1] > pino_y(lado, f[1])], key=lambda f: -f[2][1])
        canal = {}
        for grupo in (desce, sobe):
            for i, f in enumerate(grupo):
                canal[id(f)] = x_placa + passo * i
        for f in fs:
            _, nome, (xo, yo), cor, rot, dash = f
            c = canal[id(f)]
            yp = pino_y(lado, nome)
            linha([(xo, yo), (c, yo), (c, yp), (pino_x(lado), yp)], cor, dash=dash)
            if rot:
                t((xo + c) / 2, yo - 7, rot, 11, cor, 600, "middle")


def bloco(x, y, w, h, titulo, linhas, cor, dash=False):
    rect(x, y, w, h, "#ffffff", cor, 10, dash, 2)
    rect(x, y, w, 30, cor, cor, 10)
    rect(x, y + 20, w, 10, cor, cor, 0)
    t(x + 12, y + 21, titulo, 14, "#ffffff", 700)
    for i, s in enumerate(linhas):
        t(x + 12, y + 50 + i * 18, s, 12, "#374151")


out.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
           f'font-family="DejaVu Sans, Arial, Helvetica, sans-serif">')
rect(0, 0, W, H, "#ffffff", rx=0)
t(60, 56, "EchoMap — Diagrama de ligações do nó principal (ESP32 DevKit 38 pinos)", 26, peso=700)
t(60, 86, "Gerado por schematics/gerar_diagrama.py a partir de esp32-esp8266/no-principal/include/config.h",
  14, "#6b7280")
out.append(f'<line x1="60" y1="104" x2="{W-60}" y2="104" stroke="#FF6000" stroke-width="3"/>')

# placa
rect(BX0, 150, BX1 - BX0, Y0 + 18 * DY + 70 - 150, "#1e293b", rx=16)
rect(BX0 + 80, 126, BX1 - BX0 - 160, 40, "#334155", rx=4)
t((BX0 + BX1) / 2, 151, "antena (WROOM)", 12, "#cbd5e1", anc="middle")
t((BX0 + BX1) / 2, 196, "ESP32-D0WD-V3 · 4 MB", 17, "#ffffff", 700, "middle")
t((BX0 + BX1) / 2, 216, "CP2102 · FreeRTOS · board = esp32dev", 12, "#94a3b8", anc="middle")
yb = Y0 + 18 * DY + 70
rect((BX0 + BX1) / 2 - 34, yb - 10, 68, 26, "#64748b", rx=4)
t((BX0 + BX1) / 2, yb + 38, "USB-C (alimentação 5 V + Serial 115200)", 12, "#6b7280", anc="middle")

for lado, lst in (("E", ESQ), ("D", DIR)):
    for nome in lst:
        y = pino_y(lado, nome)
        x = pino_x(lado)
        rect(x - 7, y - 7, 14, 14, "#94a3b8" if nome not in FLASH else "#475569", rx=3)
        rot = nome if not nome.isdigit() else f"GPIO{nome}" + (f" ({APELIDO[nome]})" if nome in APELIDO else "")
        cor = "#e2e8f0"
        if nome in FLASH:
            rot += " ✕ flash"
            cor = "#64748b"
        elif nome in BOOT:
            rot += " · boot"
            cor = "#94a3b8"
        if lado == "E":
            t(x + 14, y + 5, rot, 12, cor)
        else:
            t(x - 14, y + 5, rot, 12, cor, anc="end")

# ---------------- lado esquerdo (na ordem do header, para os fios nao cruzarem)
XL, WL = 50, 420
O = XL + WL
CH = None

bloco(XL, 150, WL, 70, "Reservado: bateria (GPIO34, só entrada)",
      ["divisor de tensão da bateria — ainda não montado"], "#9ca3af", dash=True)
fio("E", 34, (O, 196), CH, "#9ca3af", None, dash=True)

bloco(XL, 240, WL, 92, "Potenciômetro WH148 (10 kΩ, rosca M7)",
      ["limiar de detecção 20–200 cm", "extremos: 3V3 e GND · cursor no ADC1"], COR["pot"])
fio("E", P["PIN_POT"], (O, 300), CH, COR["pot"], "cursor")

bloco(XL, 352, WL, 128, "HC-SR04 direito",
      ["VCC → 5V · GND → GND", "TRIG direto (3,3 V basta)",
       "ECHO 5 V → 1 kΩ → GPIO → 2 kΩ → GND"], COR["hc"])
fio("E", P["PIN_ECHO_R"], (O, 424), CH, COR["hc"], "ECHO (divisor)")
fio("E", P["PIN_TRIG_R"], (O, 456), CH, COR["hc"], "TRIG")

bloco(XL, 500, WL, 110, "MPU-6050 (GY-521) · I²C 400 kHz",
      ["VCC → 3V3 · GND → GND · AD0 → GND (0x68)", "SDA/SCL em 26/27: 21/22 estão no LED RGB"],
      COR["imu"])
fio("E", P["PIN_I2C_SDA"], (O, 564), CH, COR["imu"], "SDA")
fio("E", P["PIN_I2C_SCL"], (O, 590), CH, COR["imu"], "SCL")

for i, (lado_txt, pino, canal_ledc) in enumerate((("direito", "PIN_MOTOR_R", 2), ("esquerdo", "PIN_MOTOR_L", 0))):
    y = 630 + i * 180
    bloco(XL, y, WL, 160, f"Motor de vibração MV50 {lado_txt}",
          ["IN → GPIO (PWM 20 kHz, LEDC canal %d)" % canal_ledc,
           "VCC → 5V (VIN) · GND → GND comum",
           "o módulo já tem transistor e diodo do motor",
           "opcional: 10 kΩ de IN ao GND (parado no boot)"], COR["act"])
    fio("E", P[pino], (O, y + 116), CH, COR["act"], "IN")

# ---------------- lado direito
XR, WR = W - 50 - 420, 420
CH = None

bloco(XR, 150, WR, 130, "LED RGB 5 mm (catodo comum)",
      ["220–330 Ω em cada cor · comum → GND", "cor = modo (radar / autoteste) e avisos"], COR["rgb"])
fio("D", P["PIN_RGB_B"], (XR, 220), CH, COR["rgb"], "B")
fio("D", P["PIN_RGB_G"], (XR, 244), CH, COR["rgb"], "G")
fio("D", P["PIN_RGB_R"], (XR, 268), CH, COR["rgb"], "R")

bloco(XR, 300, WR, 128, "HC-SR04 esquerdo",
      ["VCC → 5V · GND → GND", "TRIG direto (3,3 V basta)",
       "ECHO 5 V → 1 kΩ → GPIO → 2 kΩ → GND"], COR["hc"])
fio("D", P["PIN_ECHO_L"], (XR, 380), CH, COR["hc"], "ECHO (divisor)")
fio("D", P["PIN_TRIG_L"], (XR, 410), CH, COR["hc"], "TRIG")

bloco(XR, 448, WR, 128, "GPS NEO-6M (GY-GPS6MV2) · UART2",
      ["VCC → 3V3 · GND → GND · 9600 baud", "TX do GPS → RX2 (obrigatório)",
       "RX do GPS ← TX2 (opcional, só configura)"], COR["gps"])
fio("D", P["PIN_GPS_TX"], (XR, 530), CH, COR["gps"], "RX do GPS")
fio("D", P["PIN_GPS_RX"], (XR, 558), CH, COR["gps"], "TX do GPS")

bloco(XR, 596, WR, 110, "Push-button 6×6 mm",
      ["um terminal no GPIO, outro no GND", "pull-up interno · interrupção na descida",
       "1 clique modo · 2 âncora · 3 portal · 1,5 s SOS"], COR["btn"])
fio("D", P["PIN_BUTTON"], (XR, 662), CH, COR["btn"], "A")

bloco(XR, 760, WR, 160, "Alimentação e terra",
      ["5V (VIN): HC-SR04 ×2 e MV50 ×2", "100 µF entre 5V e GND junto dos motores", "3V3: potenciômetro, GPS, MPU-6050",
       "GND comum a todos os módulos",
       "Hoje pelo USB-C; bateria 3,7 V + TP4056 +", "MT3608 (5 V) entra no 5V quando montada"],
      "#111827")

rotear()
# trilhos: pontas curtas com rotulo (sem cruzar os fios)
y5, y3, yg = pino_y("E", "5V"), pino_y("E", "3V3"), pino_y("D", "GND")
linha([(BX0, y5), (BX0 - 30, y5), (BX0 - 30, y5 + 40)], COR["pwr5"])
t(BX0 - 38, y5 + 56, "5V → HC-SR04 ×2, MV50 ×2", 11, COR["pwr5"], 600, "end")
linha([(BX0, y3), (BX0 - 20, y3), (BX0 - 20, y3 - 80)], COR["pwr3"])
t(BX0 - 28, y3 - 84, "3V3 → pot., GPS, MPU-6050", 11, COR["pwr3"], 600, "end")
linha([(BX1, yg), (BX1 + 30, yg), (BX1 + 30, yg - 46)], COR["gnd"])
t(BX1 + 38, yg - 50, "GND comum", 11, COR["gnd"], 600)

# legenda
yl = H - 130
out.append(f'<line x1="60" y1="{yl-20}" x2="{W-60}" y2="{yl-20}" stroke="#e5e7eb" stroke-width="1.5"/>')
leg = [(COR["hc"], "HC-SR04 (5 V; ECHO com divisor 1k/2k → 3,3 V)"), (COR["act"], "Motores de vibração MV50 (PWM)"),
       (COR["pot"], "Potenciômetro (ADC1)"), (COR["rgb"], "LED RGB"), (COR["btn"], "Botão (interrupção)"),
       (COR["imu"], "MPU-6050 (I²C)"), (COR["gps"], "GPS (UART2)"), ("#9ca3af", "Reservado")]
for i, (c, s) in enumerate(leg):
    x = 60 + (i % 4) * 410
    y = yl + (i // 4) * 30
    out.append(f'<line x1="{x}" y1="{y-5}" x2="{x+34}" y2="{y-5}" stroke="{c}" stroke-width="4"/>')
    t(x + 44, y, s, 13)
t(60, yl + 76, "Não usar: GPIO 6–11 (flash, marcados ✕). GPIO 0, 2, 5, 12 e 15 participam do boot (GPIO12 em LOW). "
  "Livre: GPIO32. Todos os GND no mesmo terra.", 13, "#6b7280")
out.append("</svg>")

open(SAIDA, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
print("gerado", SAIDA, "pinos:", sorted(P.items()))
