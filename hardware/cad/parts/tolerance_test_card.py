"""Peca 0 - cartao de tolerancia (~15 min). Imprima ANTES das pecas finais.

Testa: trilho de largura do ESP32, furo do HC-SR04 (16,4), furo do WH148 (7,4) + pino
anti-giro, 2 pinos-guia 2,65 (passo do MPU-6050) e um par macho/femea de snap-fit.
Coordenadas = orientacao de impressao (face de baixo em z=0).
"""
from build123d import Pos, Cylinder, Part

from params import TOL, ESP, HC, POT, MPU, SNAP
from cadlib import caixa, dente, pino_guia, comprimento_dente
import mockups as M

NOME = "tolerance_test_card"
CARD_X, CARD_Y, CARD_Z = 70.0, 45.0, 6.0
BASE_T = 3.0

HC_C = (12.0, 8.0)
POT_C = (28.0, 14.0)
PINOS_C = (12.0, -10.0)
# par de snap: parede femea (2 postes) e macho com 2 hastes (seta)
PAREDE_X = (29.0, 31.0)
FENDA_Y = -13.0
HASTE_GAP = 1.6


def card():
    c = caixa(-CARD_X / 2, CARD_X / 2, -CARD_Y / 2, CARD_Y / 2, 0, BASE_T)
    # trilho do ESP32: 2 nervuras com vao = W + PCB_GAP
    vao = ESP.W + TOL.PCB_GAP
    xr0 = -CARD_X / 2 + 1.0
    c += caixa(xr0, xr0 + 2.0, -CARD_Y / 2 + 1, CARD_Y / 2 - 1, BASE_T, CARD_Z)
    c += caixa(xr0 + 2.0 + vao, xr0 + 4.0 + vao, -CARD_Y / 2 + 1, CARD_Y / 2 - 1, BASE_T, CARD_Z)
    # furos
    c -= Pos(*HC_C, 0) * Cylinder(HC.TR_HOLE / 2, 20)
    c -= Pos(*POT_C, 0) * Cylinder(POT.PANEL_HOLE / 2, 20)
    c -= Pos(POT_C[0], POT_C[1] - POT.PIN_OFFSET, 0) * Cylinder((POT.PIN_D + TOL.HOLE_GAP) / 2, 20)
    # pinos-guia do MPU
    for s in (-1, 1):
        c += pino_guia(PINOS_C[0] + s * MPU.HOLE_PITCH / 2, PINOS_C[1], BASE_T, 3.0)
    # femea: 2 postes com fenda = 2 hastes + vao + folga
    fenda = 2 * SNAP.t + HASTE_GAP + SNAP_GAP_TOTAL()
    c += caixa(*PAREDE_X, FENDA_Y + fenda / 2, FENDA_Y + fenda / 2 + 6.0, BASE_T, CARD_Z)
    c += caixa(*PAREDE_X, FENDA_Y - fenda / 2 - 6.0, FENDA_Y - fenda / 2, BASE_T, CARD_Z)
    # identificacao: degraus de leitura (1 entalhe = 0,40 de folga)
    c -= caixa(-CARD_X / 2 + 5, -CARD_X / 2 + 7, -CARD_Y / 2, -CARD_Y / 2 + 0.8, 0, BASE_T + 1)
    return c


def SNAP_GAP_TOTAL():
    return TOL.SNAP_GAP


def macho():
    """Macho em seta: 2 hastes (L livre = SNAP.L) com dentes para fora; batentes laterais.
    Montado: a face dos batentes encosta na parede femea (x = PAREDE_X[1])."""
    x_ret = PAREDE_X[0] - 0.2                   # face de retencao logo atras da parede
    x_raiz = x_ret + SNAP.L                     # raiz das hastes
    z0, z1 = BASE_T + 0.15, CARD_Z - 0.15
    m = Part()
    for s in (-1, 1):
        yi = FENDA_Y + s * HASTE_GAP / 2
        yo = yi + s * SNAP.t
        y0, y1 = sorted((yi, yo))
        m += caixa(x_ret - comprimento_dente() - 0.3, x_raiz, y0, y1, z0, z1)
        # dente na face externa; rampa encontra a parede vindo de +X para -X
        m += dente((x_ret - comprimento_dente(), yo, (z0 + z1) / 2), (0, s, 0), (1, 0, 0), z1 - z0)
    # base e batentes
    m += caixa(x_raiz, x_raiz + 6.0, FENDA_Y - 9.0, FENDA_Y + 9.0, z0, z1)
    m += caixa(PAREDE_X[1], x_raiz, FENDA_Y + 7.6, FENDA_Y + 9.0, z0, z1)
    m += caixa(PAREDE_X[1], x_raiz, FENDA_Y - 9.0, FENDA_Y - 7.6, z0, z1)
    return m


def build():
    pc = card()
    mc = macho()
    mocks = []
    # PCB do ESP32 entre as nervuras (folga de 0,2 por lado)
    xr0 = -CARD_X / 2 + 1.0
    xc = xr0 + 2.0 + (ESP.W + TOL.PCB_GAP) / 2
    mocks.append(("esp32_pcb", caixa(xc - ESP.W / 2, xc + ESP.W / 2, -20, 20, BASE_T, BASE_T + ESP.PCB_T),
                  M.VERDE, "comp"))
    mocks.append(("hc_transdutor", Pos(*HC_C, 0) * Cylinder(HC.TR_D / 2, 12), "#c0c0c0", "comp"))
    mocks.append(("pot_bucha", Pos(*POT_C, 0) * Cylinder(3.5, 12), M.CIANO, "comp"))
    mocks.append(("pot_pino", Pos(POT_C[0], POT_C[1] - POT.PIN_OFFSET, BASE_T + 0.6) * Cylinder(
        POT.PIN_D / 2, 1.2), M.CIANO, "comp"))
    mp = M.mpu6050()
    loc = Pos(PINOS_C[0], PINOS_C[1] - M.MPU_FUROS[0][1], BASE_T)
    mocks.append(("mpu_pcb", loc * mp[0][1], M.AZUL, "comp"))
    return {
        "pecas": [("card", pc, None), ("snap_macho", mc, None)],
        "mockups": mocks,
        "explode": {"card": (0, 0, 0), "snap_macho": (20, 0, 0)},
        "snaps": [("seta do snap_macho", SNAP.t, SNAP.L, SNAP.y)],
        "contatos": {("card", "snap_macho")},
    }
