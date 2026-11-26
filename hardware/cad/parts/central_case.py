"""Peca 1 - case central (bolso do colete 78 x 160), sem parafusos.

Referencial: X = largura (72), Y = altura (102, Y+ = para cima, USB-C embaixo),
Z = profundidade (Z = 0 encosta no peito, Z+ = para fora). Corpo z = 0..34, tampa 34..36.
  corpo - ESP32 em pe num berco com trilhos laterais + batente (aceita 51,5 a 55,5),
          18 mm livres para os jumpers na frente, corte USB-C 10 x 4,5 + janela 14 x 8;
          prateleira rigida do MPU-6050 (paralela ao chao) com 2 pinos 2,65 em gota e aba
          elastica no plano; topo com WH148 (+ anti-giro), LED (colar de atrito) e tecla
          de 10 mm em dobradica viva sobre o botao 6x6; 2 saidas laterais em S;
          2 travas cantilever nas paredes laterais (dobram em XY).
  tampa - frontal, com 2 nervuras que prendem a PCB do ESP32, saia com os entalhes
          das travas e frestas de ventilacao sobre o ESP32.
Imprime: corpo com as costas na mesa; tampa com a face externa na mesa.
"""
from build123d import Pos, Rot, Cylinder, Plane, Polygon, extrude, Axis, Part

from params import TOL, ESP, MPU, POT, LED, BTN, SNAP, VEST
from cadlib import caixa, dente, pino_guia
import mockups as M

NOME = "central_case"
HX, HY = 36.0, 51.0
W = TOL.WALL
Z_TOP = 34.0                     # topo do corpo / face interna da tampa
LID_T = W
IX, IY = HX - W, HY - W          # interior 68 x 98
# ESP32
ESP_XC = -IX + TOL.PCB_GAP / 2 + ESP.W / 2          # -19,55
ESP_Z0 = W + ESP.COMP_TOP + 0.1                      # face de tras da PCB (5,6)
ESP_Z1 = ESP_Z0 + ESP.PCB_T                          # face dos pinos (7,2)
ESP_Y0 = -IY                                         # borda inferior da PCB (USB-C)
ESP_XR = ESP_XC + ESP.W / 2                          # borda direita da PCB
HDR = M.ESP_HDR_Y
# MPU-6050
Y_S = 10.0                       # topo da prateleira
MPU_X, MPU_Z = 18.0, 20.0
MPU_LOC = Pos(MPU_X, Y_S, MPU_Z) * Rot(-90, 0, 0)
FURO_Z = MPU_Z - M.MPU_FUROS[0][1]                   # 14,5
PINO_Z = MPU_Z - M.MPU_PINO_Y                        # 26,7
MPU_XR = MPU_X + MPU.L / 2
TAB_X0 = MPU_XR + 0.2
TAB_ROOT_Y = Y_S + MPU.PCB_T + 10.6
# topo
POT_X, POT_Z = 18.0, 18.0
LED_X, LED_Z = -12.0, 18.0
BTN_X, BTN_Z = -26.0, 18.0
PLUNGER = 1.0
BTN_Y = IY - PLUNGER - BTN.KEY_GAP - BTN.BTN_H       # base do corpo do botao (42,7)
# travas da tampa
LAT_ROOT, LAT_TIP, LAT_TOOTH = -11.0, 3.0, 0.5
LAT_Z0 = Z_TOP - 3.2
SKIRT_T = 1.2


def _xr(sx, a, b):
    return (a, b) if sx > 0 else (-b, -a)


def _ext_y(prof_no_plano, y0, h):
    """Extruda um perfil no plano XZ (em y0) ocupando exatamente y0..y0+h."""
    e = extrude(prof_no_plano, amount=h)
    if e.bounding_box().min.Y < y0 - 1e-6:
        e = Pos(0, h, 0) * e
    return e


def _pino_gota(x, z, y0, h, d=TOL.PIN_D):
    """Pino horizontal (eixo +Y) com base em gota truncada para -Z: imprime sem suporte."""
    r = d / 2
    c = Pos(x, y0 + h / 2, z) * Rot(90, 0, 0) * Cylinder(r, h)
    t = 0.7071 * r
    pl = Plane(origin=(0, y0, 0), x_dir=(1, 0, 0), z_dir=(0, 1, 0))
    pts = [(x - t, z - t), (x - 0.424, z - 1.45), (x + 0.424, z - 1.45), (x + t, z - t)]
    g = _ext_y(pl * Polygon(*[(a, -b) for a, b in pts], align=None), y0, h)
    return c + g


def _trava(c, sx):
    """Viga cantilever na parede lateral: comprimento em Y, dobra em X, fresta inclinada."""
    xi, xo = IX, IX + SNAP.t
    c -= caixa(*_xr(sx, xo, HX + 0.5), LAT_ROOT, LAT_TIP + 0.6, LAT_Z0, Z_TOP + 1)
    c -= caixa(*_xr(sx, xi - 0.1, HX + 0.5), LAT_TIP, LAT_TIP + 0.6, LAT_Z0 - 0.6, Z_TOP + 1)
    pl = Plane(origin=(0, LAT_ROOT, 0), x_dir=(1, 0, 0), z_dir=(0, -1, 0))
    pts = [(xi - 0.1, LAT_Z0 - 0.6), (xo + 0.1, LAT_Z0 - 0.6 + SNAP.t + 0.2),
           (xo + 0.1, LAT_Z0 + SNAP.t + 0.2), (xi - 0.1, LAT_Z0)]
    if sx < 0:
        pts = [(-a, b) for a, b in pts]
    pts = [(a, -b) for a, b in pts]
    pl = Plane(origin=(0, LAT_ROOT, 0), x_dir=(1, 0, 0), z_dir=(0, 1, 0))
    c -= _ext_y(pl * Polygon(*pts, align=None), LAT_ROOT, LAT_TIP + 0.6 - LAT_ROOT)
    c += dente((sx * xi, LAT_TOOTH, Z_TOP - 0.6), (-sx, 0, 0), (0, 0, -1), 3.0)
    return c


def corpo():
    c = caixa(-HX, HX, -HY, HY, 0, Z_TOP)
    c = c.fillet(3.0, c.edges().filter_by(Axis.Z))
    c = c.chamfer(TOL.FILLET_PELE, None, c.edges().group_by(Axis.Z)[0])
    c -= caixa(-IX, IX, -IY, IY, W, Z_TOP + 1)
    # --- ESP32: trilho direito, apoios de tras, batente superior
    c += caixa(ESP_XR + 0.2, ESP_XR + 2.2, -IY, ESP_Y0 + ESP.L_MAX + 2.0, W, ESP_Z1 + 1.8)
    c += caixa(-IX, -IX + 0.2 + 0.7, -IY, ESP_Y0 + ESP.L - 1.0, W, ESP_Z0)
    c += caixa(ESP_XR - 0.7, ESP_XR + 0.2, -IY, ESP_Y0 + ESP.L - 1.0, W, ESP_Z0)
    c += caixa(-IX, ESP_XR + 2.2, ESP_Y0 + ESP.L_MAX, ESP_Y0 + ESP.L_MAX + 2.0, W, ESP_Z1)
    # USB-C: corte 10 x 4,5 + janela externa 14 x 8
    zu = ESP_Z0 - 1.6
    c -= caixa(ESP_XC - ESP.USB_CUT_W / 2, ESP_XC + ESP.USB_CUT_W / 2, -HY - 1, -IY + 0.1,
               zu - ESP.USB_CUT_H / 2, zu + ESP.USB_CUT_H / 2)
    c -= caixa(ESP_XC - ESP.USB_WIN_W / 2, ESP_XC + ESP.USB_WIN_W / 2, -HY - 1, -IY - 1.0,
               zu - ESP.USB_WIN_H / 2, zu + ESP.USB_WIN_H / 2)
    # --- prateleira do MPU-6050 (rigida, paralela ao chao), pinos em gota, fenda dos pinos
    c += caixa(MPU_X - MPU.L / 2 - 3.5, IX, Y_S - W, Y_S, W, PINO_Z + 3.3)
    # fenda aberta para a frente (sem teto = sem ponte de 21 mm)
    c -= caixa(MPU_X - MPU.L / 2 - 0.3, MPU_X + MPU.L / 2 + 0.3, Y_S - W - 1, Y_S + 0.1,
               PINO_Z - 1.7, Z_TOP - 0.5)
    for fx, _ in M.MPU_FUROS:
        c += _pino_gota(MPU_X + fx, FURO_Z, Y_S, MPU.PCB_T + 1.0)
    # aba elastica: viga vertical (comprimento em Y, dobra em X), dente sobre a borda da PCB
    yb = Y_S + 0.6
    viga = caixa(TAB_X0, TAB_X0 + SNAP.t, yb, TAB_ROOT_Y, W + 0.6, FURO_Z + 2.0)
    pl = Plane(origin=(0, yb - 1, 0), x_dir=(1, 0, 0), z_dir=(0, 1, 0))
    viga -= _ext_y(pl * Polygon((TAB_X0 - 0.1, -(W - 0.1)), (TAB_X0 + SNAP.t + 0.1, -(W - 0.1)),
                                (TAB_X0 + SNAP.t + 0.1, -(W + 0.6 + SNAP.t + 0.1)), align=None),
                   yb - 1, TAB_ROOT_Y - yb + 2)
    c += viga
    c += caixa(TAB_X0, IX, TAB_ROOT_Y, TAB_ROOT_Y + 2.0, W, FURO_Z + 2.0)
    c += dente((TAB_X0, Y_S + MPU.PCB_T + 0.05 + 1.145, FURO_Z), (-1, 0, 0), (0, -1, 0), 4.0)
    # --- topo: WH148, LED, tecla do botao
    c -= Pos(POT_X, IY + W / 2, POT_Z) * Rot(90, 0, 0) * Cylinder(POT.PANEL_HOLE / 2, W + 1)
    c -= Pos(POT_X, IY + W / 2, POT_Z + POT.PIN_OFFSET) * Rot(90, 0, 0) * Cylinder(
        (POT.PIN_D + TOL.HOLE_GAP) / 2, W + 1)
    c -= Pos(LED_X, IY + W / 2, LED_Z) * Rot(90, 0, 0) * Cylinder(LED.HOLE / 2, W + 1)
    colar = Pos(LED_X, IY - LED.COLLAR_H / 2, LED_Z) * Rot(90, 0, 0) * Cylinder(LED.BODY_D / 2 + 1.2, LED.COLLAR_H)
    colar += caixa(LED_X - 1.0, LED_X + 1.0, IY - LED.COLLAR_H, IY, W, LED_Z)
    colar -= Pos(LED_X, IY - LED.COLLAR_H / 2, LED_Z) * Rot(90, 0, 0) * Cylinder(LED.BODY_D / 2 + 0.05, LED.COLLAR_H + 1)
    c += colar
    # berco do botao (com canais das pernas) apoiado nas costas
    bx0, bx1 = BTN_X - 4.0, BTN_X + 4.0
    bz0, bz1 = BTN_Z - BTN.BODY / 2 - 0.2, BTN_Z + BTN.BODY / 2 + 0.2
    berco = caixa(bx0 - 0.6, bx1 + 0.6, BTN_Y - 2.0, BTN_Y + BTN.BODY_H, W, bz1 + 1.2)
    berco -= caixa(bx0, bx1, BTN_Y, BTN_Y + BTN.BODY_H + 1, bz0, bz1)
    for xa, xb in ((bx0, BTN_X - 2.5), (BTN_X + 2.5, bx1)):
        berco -= caixa(xa, xb, BTN_Y - 2.1, BTN_Y + 0.1, bz0, bz1)
    c += berco
    # tecla de 10 mm com dobradica viva (lingueta em +X, 0,8 mm)
    r0, r1 = BTN.KEY_D / 2, BTN.KEY_D / 2 + 0.4
    anel = Pos(BTN_X, IY + W / 2, BTN_Z) * Rot(90, 0, 0) * (Cylinder(r1, W + 1) - Cylinder(r0, W + 1))
    lx0, lx1 = BTN_X + r0 - 0.5, BTN_X + r0 + 5.0
    anel -= caixa(lx0, lx1 + 1, IY - 1, HY + 1, BTN_Z - 2.0, BTN_Z + 2.0)
    anel += caixa(lx0 + 0.5, lx1, IY - 1, HY + 1, BTN_Z - 2.4, BTN_Z - 2.0)
    anel += caixa(lx0 + 0.5, lx1, IY - 1, HY + 1, BTN_Z + 2.0, BTN_Z + 2.4)
    c -= anel
    c -= caixa(BTN_X + r0, lx1, IY - 0.1, HY - BTN.HINGE_T, BTN_Z - 2.0, BTN_Z + 2.0)
    c += Pos(BTN_X, IY - PLUNGER / 2, BTN_Z) * Rot(90, 0, 0) * Cylinder(BTN.STEM_D / 2, PLUNGER)
    # --- saidas laterais em S (alivio de tracao)
    for sx, yc, pinos in ((-1, 21.0, ((-31.0, 25.5), (-27.0, 16.0))),
                          (1, 31.0, ((31.0, 36.5), (27.0, 26.0)))):
        c -= caixa(*_xr(sx, IX - 0.1, HX + 1), yc - 4.0, yc + 4.0, 14.0, 22.0)
        for px, py in pinos:
            c += Pos(px, py, (W + 24.0) / 2) * Cylinder(2.0, 24.0 - W)
    for sx in (-1, 1):
        c = _trava(c, sx)
    return c


def tampa():
    t = caixa(-HX, HX, -HY, HY, Z_TOP, Z_TOP + LID_T)
    t = t.fillet(3.0, t.edges().filter_by(Axis.Z))
    t = t.chamfer(0.8, None, t.edges().group_by(Axis.Z)[-1])
    # nervuras que prendem a PCB do ESP32 (fora da zona dos headers)
    xa, xb = -IX + 0.4, ESP_XR - 0.2
    t += caixa(xa, xb, ESP_Y0 + HDR[1] + 0.4, ESP_Y0 + ESP.L - 0.2, ESP_Z1 + 0.05, Z_TOP)
    t += caixa(xa, xb, ESP_Y0 + 0.2, ESP_Y0 + HDR[0] - 0.4, ESP_Z1 + 0.05, Z_TOP)
    # saia com entalhes das travas
    for sx in (-1, 1):
        xo = IX - TOL.SNAP_GAP
        sk = caixa(*_xr(sx, xo - SKIRT_T, xo), -12.0, 6.0, Z_TOP - 5.5, Z_TOP)
        sk -= caixa(*_xr(sx, xo - 0.75, xo + 0.1), LAT_TOOTH - 1.8, LAT_TOOTH + 1.8,
                    Z_TOP - 0.6 - 1.6, Z_TOP - 0.6 + 0.15)
        t += sk
    # frestas de ventilacao sobre o ESP32 (1,6 mm: dedo nao entra)
    for x in (-29.0, -24.0, -14.0, -9.0):
        t -= caixa(x - 0.8, x + 0.8, -30.0, -8.0, Z_TOP - 1, Z_TOP + LID_T + 1)
    return t


def build():
    cp, tp = corpo(), tampa()
    mocks = M.place(M.esp32(), Pos(ESP_XC, ESP_Y0, ESP_Z0))
    mocks += M.place(M.mpu6050(), MPU_LOC)
    mocks += M.place(M.wh148(), Pos(POT_X, IY, POT_Z) * Rot(-90, 0, 0) * Rot(0, 0, -90))
    mocks += M.place(M.led5(), Pos(LED_X, IY - LED.COLLAR_H - 1.05, LED_Z) * Rot(-90, 0, 0))
    mocks += M.place(M.botao(), Pos(BTN_X, BTN_Y, BTN_Z) * Rot(-90, 0, 0))
    return {
        "pecas": [("corpo", cp, None), ("tampa", tp, Rot(180, 0, 0))],
        "mockups": mocks,
        "explode": {"tampa": (0, 0, 30), "corpo": (0, 0, 0)},
        "snaps": [("trava da tampa (x2)", SNAP.t, LAT_TOOTH - LAT_ROOT, SNAP.y),
                  ("aba elastica do MPU-6050", SNAP.t, TAB_ROOT_Y - (Y_S + MPU.PCB_T + 0.6), SNAP.y)],
        "corte": {"x": (ESP_XC, 0, 0), "y": (0, Y_S + 1.0, 0)},
        "cortes_extras": [("section_x_mpu_pot", "x", (MPU_X, 0, 0))],
        "limites": {"largura (bolso 78)": (2 * HX, VEST.POCKET_MAX_W),
                    "altura (bolso 160)": (2 * HY, VEST.POCKET_MAX_H)},
    }
