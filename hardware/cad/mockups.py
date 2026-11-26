"""EchoMap - mockups simplificados dos componentes + volumes de exclusao (keep-out).

Cada funcao devolve uma lista de (nome, solido, cor, tipo) no referencial LOCAL
do componente; as pecas posicionam com Location. tipo = "comp" ou "keepout".
Medidas vem de params.py (ver campo `fonte`).
"""
import math
from build123d import Box, Cylinder, Cone, Pos, Rot, Align, Part

from params import ESP, MPU, POT, LED, BTN, HC, MV, GPSM, TOL

C = (Align.CENTER, Align.CENTER, Align.CENTER)
MIN = (Align.MIN, Align.MIN, Align.MIN)
CMIN = (Align.CENTER, Align.CENTER, Align.MIN)
CMAX = (Align.CENTER, Align.CENTER, Align.MAX)

VERDE = "#2e9d57"
AZUL = "#2f6fd6"
AMARELO = "#e0b300"
ROXO = "#8a4fd0"
LARANJA = "#e07b1f"
CIANO = "#1aa3b8"
PRETO = "#333333"
KO = "#e02424"


def caixa(x0, x1, y0, y1, z0, z1):
    """Caixa por limites (x0..x1, y0..y1, z0..z1)."""
    return Pos((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2) * Box(x1 - x0, y1 - y0, z1 - z0)


def place(lista, loc):
    return [(n, loc * s, c, t) for (n, s, c, t) in lista]


# ---------------------------------------------------------------- ESP32 DevKit
def esp32():
    """PCB em XY, X = largura, Y = comprimento (USB-C em y=0), lado dos pinos +Z.
    Face de tras da PCB (lado dos componentes) em z=0."""
    hw = ESP.W / 2
    pcb = caixa(-hw, hw, 0, ESP.L, 0, ESP.PCB_T)
    comp = caixa(-12.5, 12.5, 2.0, ESP.L, -ESP.COMP_TOP, 0)
    usb = caixa(-4.5, 4.5, -1.0, 6.5, -3.2, 0)
    pitch = 25.4 / 2
    h0, h1 = 4.0, 4.0 + 19 * 2.54
    hdr = caixa(-pitch - 1.27, -pitch + 1.27, h0, h1, ESP.PCB_T, ESP.PCB_T + ESP.PIN_H)
    hdr += caixa(pitch - 1.27, pitch + 1.27, h0, h1, ESP.PCB_T, ESP.PCB_T + ESP.PIN_H)
    rabo = caixa(-pitch - 0.8, -pitch + 0.8, h0, h1, -1.5, 0)
    rabo += caixa(pitch - 0.8, pitch + 0.8, h0, h1, -1.5, 0)
    ko_jump = caixa(-hw, hw, h0, h1, ESP.PCB_T, ESP.PCB_T + TOL.JUMPER_CLEARANCE)
    # plugue USB-C 12 x 6 saindo 25 mm pela borda inferior
    ko_usb = caixa(-6.0, 6.0, -1.0 - ESP.USB_KEEPOUT, -1.0, -1.6 - 3.0, -1.6 + 3.0)
    return [
        ("esp32_pcb", pcb, VERDE, "comp"),
        ("esp32_componentes", comp + usb + rabo, PRETO, "comp"),
        ("esp32_headers", hdr, AMARELO, "comp"),
        ("ko_esp32_jumpers", ko_jump, KO, "keepout"),
        ("ko_usb_c", ko_usb, KO, "keepout"),
    ]


ESP_HDR_Y = (4.0, 4.0 + 19 * 2.54)


# ---------------------------------------------------------------- MPU-6050
def mpu6050():
    """PCB em XY (x = 21, y = 16), face de baixo em z=0, pinos para -Z na borda y-.
    Furos em y = +W/2 - HOLE_EDGE, x = +-PITCH/2."""
    hx, hy = MPU.L / 2, MPU.W / 2
    yfuro = hy - MPU.HOLE_EDGE
    pcb = caixa(-hx, hx, -hy, hy, 0, MPU.PCB_T)
    for sx in (-1, 1):
        pcb -= Pos(sx * MPU.HOLE_PITCH / 2, yfuro, MPU.PCB_T / 2) * Cylinder(MPU.HOLE_D / 2, 5)
    comp = caixa(-5.0, 5.0, -3.0, 3.0, MPU.PCB_T, MPU.PCB_T + MPU.COMP_TOP)
    yp = -hy + MPU.PIN_ROW_EDGE
    pinos = caixa(-4 * 2.54, 4 * 2.54, yp - 1.27, yp + 1.27, -MPU.PIN_H, 0)
    ko = caixa(-hx, hx, yp - 1.4, yp + 1.4, -TOL.JUMPER_CLEARANCE, 0)
    return [
        ("mpu_pcb", pcb, AZUL, "comp"),
        ("mpu_componentes", comp, PRETO, "comp"),
        ("mpu_pinos", pinos, AMARELO, "comp"),
        ("ko_mpu_jumpers", ko, KO, "keepout"),
    ]


MPU_FUROS = [(s * MPU.HOLE_PITCH / 2, MPU.W / 2 - MPU.HOLE_EDGE) for s in (-1, 1)]
MPU_PINO_Y = -MPU.W / 2 + MPU.PIN_ROW_EDGE


# ---------------------------------------------------------------- WH148
def wh148():
    """Face de montagem (face interna do painel) em z=0; eixo para +Z; corpo para -Z."""
    corpo = Pos(0, 0, -POT.BODY_H / 2) * Cylinder(POT.BODY_D / 2, POT.BODY_H)
    bucha = Pos(0, 0, 3.5) * Cylinder(3.5, 7.0)
    eixo = Pos(0, 0, 7.0 + (POT.SHAFT_H - 7.0) / 2) * Cylinder(POT.SHAFT_D / 2, POT.SHAFT_H - 7.0)
    pino = Pos(POT.PIN_OFFSET, 0, 0.6) * Cylinder(POT.PIN_D / 2 - 0.2, 1.2)
    terminais = caixa(-6.0, 6.0, -POT.BODY_D / 2 - 6.0, -POT.BODY_D / 2 + 2.0, -POT.BODY_H, -POT.BODY_H + 4)
    ko = caixa(-7.0, 7.0, -POT.BODY_D / 2 - 12.0, -POT.BODY_D / 2 + 2.0, -POT.BODY_H - 6, -POT.BODY_H + 4)
    ko_mao = Pos(0, 0, 8.0 + 15.0 / 2) * Cylinder(11.0, 15.0)  # dedos girando o knob
    return [
        ("pot_corpo", corpo + pino, CIANO, "comp"),
        ("pot_eixo", bucha + eixo, PRETO, "comp"),
        ("pot_terminais", terminais, AMARELO, "comp"),
        ("ko_pot_fios", ko, KO, "keepout"),
        ("ko_pot_knob", ko_mao, KO, "keepout"),
    ]


# ---------------------------------------------------------------- LED 5 mm
def led5():
    """Topo da lente em z=+BODY_H; flange em z=0; pernas para -Z."""
    lente = Pos(0, 0, LED.BODY_H / 2) * Cylinder(LED.BODY_D / 2, LED.BODY_H)
    flange = Pos(0, 0, 0.5) * Cylinder(LED.FLANGE_D / 2, 1.0)
    pernas = caixa(-2.6, 2.6, -0.4, 0.4, -10.0, 0)
    ko = caixa(-3.0, 3.0, -3.0, 3.0, -16.0, 0)
    return [
        ("led", lente + flange, "#e83e8c", "comp"),
        ("led_pernas", pernas, AMARELO, "comp"),
        ("ko_led_fios", ko, KO, "keepout"),
    ]


# ---------------------------------------------------------------- Botao 6x6
def botao():
    """Base do corpo em z=0, haste para +Z ate BTN_H; pernas para -Z."""
    corpo = caixa(-BTN.BODY / 2, BTN.BODY / 2, -BTN.BODY / 2, BTN.BODY / 2, 0, BTN.BODY_H)
    haste = Pos(0, 0, (BTN.BODY_H + BTN.BTN_H) / 2) * Cylinder(BTN.STEM_D / 2, BTN.BTN_H - BTN.BODY_H)
    pernas = caixa(-3.25, 3.25, -2.25, 2.25, -3.5, 0) - caixa(-2.5, 2.5, -2.3, 2.3, -3.6, 0.1)
    ko = caixa(-4.0, 4.0, -4.0, 4.0, -14.0, -3.5)
    return [
        ("botao", corpo, PRETO, "comp"),
        ("botao_haste", haste, "#999999", "comp"),
        ("botao_pernas", pernas, AMARELO, "comp"),
        ("ko_botao_fios", ko, KO, "keepout"),
    ]


# ---------------------------------------------------------------- HC-SR04
def hcsr04():
    """PCB em XY (x = 45,5, y = 20,5), face dos transdutores para +Z a partir de z=PCB_T.
    Face de tras da PCB em z=0. 4 pinos retos NO PLANO da PCB saindo pela borda y-."""
    hx, hy = HC.PCB_L / 2, HC.PCB_W / 2
    pcb = caixa(-hx, hx, -hy, hy, 0, HC.PCB_T)
    tr = Part()
    cones = Part()
    for sx in (-1, 1):
        tr += Pos(sx * HC.TR_PITCH / 2, 0, HC.PCB_T + HC.TR_H / 2) * Cylinder(HC.TR_D / 2, HC.TR_H)
        r1 = HC.TR_D / 2 + HC.CONE_LEN * math.tan(math.radians(HC.CONE_HALF_DEG))
        cones += Pos(sx * HC.TR_PITCH / 2, 0, HC.PCB_T + HC.TR_H + HC.CONE_LEN / 2) * Cone(
            HC.TR_D / 2, r1, HC.CONE_LEN)
    cristal = caixa(-HC.CRYSTAL_W / 2, HC.CRYSTAL_W / 2, hy - 1.0 - HC.CRYSTAL_H, hy - 1.0,
                    HC.PCB_T, HC.PCB_T + HC.CRYSTAL_T)
    traseira = caixa(-10.0, 10.0, -6.0, 6.0, -1.8, 0)
    pinos = caixa(-5.1, 5.1, -hy - 6.0, -hy + 2.5, HC.PCB_T, HC.PCB_T + 2.5)
    ko = caixa(-6.0, 6.0, -hy - 0.5 - TOL.JUMPER_CLEARANCE, -hy - 0.5, -0.5, HC.PCB_T + 3.5)
    return [
        ("hc_pcb", pcb, AZUL, "comp"),
        ("hc_transdutores", tr, "#c0c0c0", "comp"),
        ("hc_cristal", cristal + traseira, PRETO, "comp"),
        ("hc_pinos", pinos, AMARELO, "comp"),
        ("ko_hc_cone15", cones, KO, "keepout"),
        ("ko_hc_jumpers", ko, KO, "keepout"),
    ]


# ---------------------------------------------------------------- MV50
def mv50():
    """PCB em XY (x = 23,5, y = 21,5), face de tras (motor) em z=0 encostada no corpo,
    altura total H para +Z. Furos em x = +-PITCH/2, y = 0. Pinos na borda x+ (3)."""
    hx, hy = MV.PCB_L / 2, MV.PCB_W / 2
    pcb = caixa(-hx, hx, -hy, hy, 0, MV.PCB_T)
    for sx in (-1, 1):
        pcb -= Pos(sx * MV.HOLE_PITCH / 2, 0, 0) * Cylinder(MV.HOLE_D / 2, 10)
    motor = Pos(0, 0, -0.0) * caixa(-5, 5, -5, 5, MV.PCB_T, MV.H)
    pinos = caixa(hx - 2.5, hx + 8.5, -3.9, 3.9, MV.PCB_T, MV.PCB_T + 2.5)
    ko = caixa(hx + 6.0, hx + 6.0 + TOL.JUMPER_CLEARANCE - 8.5, -4.2, 4.2, 0, MV.H)
    return [
        ("mv50_pcb", pcb, LARANJA, "comp"),
        ("mv50_motor", motor, PRETO, "comp"),
        ("mv50_pinos", pinos, AMARELO, "comp"),
        ("ko_mv50_jumpers", ko, KO, "keepout"),
    ]


MV_FUROS = [(s * MV.HOLE_PITCH / 2, 0.0) for s in (-1, 1)]


# ---------------------------------------------------------------- GPS NEO-6M + antena
def gps_neo6m():
    """PCB em XY (x = 36, y = 26), face de baixo em z=0, altura H. 4 pinos na borda x+."""
    hx, hy = GPSM.PCB_L / 2, GPSM.PCB_W / 2
    pcb = caixa(-hx, hx, -hy, hy, 0, GPSM.PCB_T)
    for sx in (-1, 1):
        for sy in (-1, 1):
            pcb -= Pos(sx * (hx - GPSM.HOLE_EDGE), sy * (hy - GPSM.HOLE_EDGE), 0) * Cylinder(
                GPSM.HOLE_D / 2, 10)
    comp = caixa(-8.0, 8.0, -8.0, 8.0, GPSM.PCB_T, GPSM.H)          # NEO-6M + blindagem
    bat = Pos(-12.0, 0, GPSM.PCB_T + 1.0) * Cylinder(3.0, 2.0)      # bateria/backup
    led = Pos(-hx + GPSM.LED_X, -hy + 4.0, GPSM.PCB_T + 0.4) * Box(1.6, 0.8, 0.8)
    ufl = caixa(-13.0, -10.0, 4.0, 7.0, GPSM.PCB_T, GPSM.PCB_T + 1.3)
    pinos = caixa(hx - 2.5, hx + 6.0, -5.1, 5.1, GPSM.PCB_T, GPSM.PCB_T + 2.5)
    ko = caixa(hx + 3.0, hx + 9.0, -5.4, 5.4, 0, GPSM.H)
    return [
        ("gps_pcb", pcb, AZUL, "comp"),
        ("gps_componentes", comp + bat + ufl, PRETO, "comp"),
        ("gps_led", led, "#ff4d4d", "comp"),
        ("gps_pinos", pinos, AMARELO, "comp"),
        ("ko_gps_fios", ko, KO, "keepout"),
    ]


GPS_FUROS = [(sx * (GPSM.PCB_L / 2 - GPSM.HOLE_EDGE), sy * (GPSM.PCB_W / 2 - GPSM.HOLE_EDGE))
             for sx in (-1, 1) for sy in (-1, 1)]
GPS_LED_XY = (-GPSM.PCB_L / 2 + GPSM.LED_X, -GPSM.PCB_W / 2 + 4.0)


def antena_gps(ceu_ate=0.0):
    """Antena ceramica: base em z=0, face ativa para +Z. `ceu_ate`: altura do volume livre
    acima da antena (ate a face externa da tampa)."""
    a = caixa(-GPSM.ANT_L / 2, GPSM.ANT_L / 2, -GPSM.ANT_W / 2, GPSM.ANT_W / 2, 0, GPSM.ANT_H)
    out = [("antena_gps", a, "#d9a441", "comp")]
    if ceu_ate > 0:
        ceu = caixa(-GPSM.ANT_L / 2 + 2, GPSM.ANT_L / 2 - 2, -GPSM.ANT_W / 2 + 2, GPSM.ANT_W / 2 - 2,
                    GPSM.ANT_H, GPSM.ANT_H + ceu_ate)
        out.append(("ko_antena_ceu", ceu, KO, "keepout"))
    return out
