"""Peca 2 - suporte farol (HC-SR04) + haptico (MV50), x2. Sanduiche na fita de 60 mm.

Referencial: fita ao longo de Y (Y+ = para cima no peito), largura em X, fita em
z = 0..STRAP_T_MAX, Z+ = para frente (HC-SR04), Z- = peito (MV50).
  externa - base 68 com 4 postes (canal de 61 mm entre eles), serrilha 0,6, corpo
            tronco-piramidal com o HC-SR04 (furos 16,4, berco com aba traseira de snap,
            recorte do cristal, saida inferior dos pinos/jumpers paralela a fita).
            Imprime de frente para a mesa (furos verticais, sem suporte).
  interna - contraplaca 68 com serrilha complementar, 4 ganchos cantilever no plano
            (dobram em XY, catraca de 2 posicoes: fita de 2,8 ou 1,6 mm) e o berco fino do
            MV50 (pinos conicos, aba de trava, janela circular na face do corpo).
            Imprime com a face do corpo na mesa.
HEADLIGHT_TILT_DEG inclina o HC-SR04 (0 ou -8 = apontado um pouco para baixo).
"""
import math
from build123d import Pos, Rot, Cylinder, Cone, Plane, Polygon, extrude, Axis, Part, loft, Rectangle, Sketch

from params import TOL, VEST, HC, MV, SNAP, MNT
from cadlib import caixa, dente, serrilha
import mockups as M

NOME = "headlight_haptic_mount"
VARIANTES = {"": 0.0, "_tilt-8": -8.0}
ST = VEST.STRAP_T_MAX
HX, HY = MNT.BASE_W / 2, 25.0
BASE = (ST, ST + 4.0)                 # placa da metade externa (2,8..6,8)
FRONT_W, FRONT_H = 50.0, 32.0         # face frontal do HC
Z_FRONT = BASE[1] + 13.0              # 19,8
IN_Z = (-8.0, 0.0)                    # metade interna
POST = dict(x0=MNT.CHANNEL_W / 2, w=3.0, y0=16.5, l=4.0)
POST_BOT = -5.6
RAT_GAP = 0.15
BEAM_Y0 = POST["y0"] + POST["l"] + RAT_GAP
BEAM_ROOT_X = 20.0
RAT_Z0 = -2.0                         # topo da rampa do dente (dente desce ate -3,145)
PASSO = 1.2
# HC-SR04
HC_BACK = Z_FRONT - (HC.PCB_T + HC.TR_H)      # 6,2
HC_FRONT_PCB = HC_BACK + HC.PCB_T             # 7,8
PKT_X, PKT_Y = (HC.PCB_L + TOL.PCB_GAP) / 2, (HC.PCB_W + TOL.PCB_GAP) / 2
TAB_ROOT, TAB_TIP = -18.0, -4.0
TAB_TOOTH_X = -6.5
# MV50
MV_CY = -2.0
MV_TOP = -1.3                                   # face de cima da PCB do MV50
MVX, MVY = (MV.PCB_W + TOL.PCB_GAP) / 2, (MV.PCB_L + TOL.PCB_GAP) / 2
LOCK_ROOT, LOCK_TIP, LOCK_TOOTH_X = -11.0, 2.5, -0.75


def _yr(sy, a, b):
    return (a, b) if sy > 0 else (-b, -a)


def _xr(sx, a, b):
    return (a, b) if sx > 0 else (-b, -a)


def _fenda_inclinada(x0, x1, yi, yo, z_in, sy=1, gap=0.6):
    """Fresta a 45 graus (sobe para fora) acima de uma viga: y de yi (dentro) a yo (fora);
    na face interna a fresta comeca em z_in. Extrudada de x0 a x1."""
    pl = Plane(origin=(x0, 0, 0), x_dir=(0, 1, 0), z_dir=(1, 0, 0))
    d = yo - yi
    pts = [(yi, z_in), (yo, z_in + d), (yo, z_in + d + gap), (yi, z_in + gap)]
    if sy < 0:
        pts = [(-a, b) for a, b in pts][::-1]
    return extrude(pl * Polygon(*pts, align=None), amount=x1 - x0)


# ------------------------------------------------------------------ metade externa
def _cabeca_bruta():
    """Tronco de piramide (flancos <= 45 graus) prolongado 10 mm para tras: com o farol
    inclinado, o flanco continua ate a fita e nao sobra aba horizontal (balanco)."""
    h = Z_FRONT - BASE[1]
    kx, ky = (HX - FRONT_W / 2) / h, (HY - FRONT_H / 2) / h
    ext = 10.0
    r0 = Pos(0, 0, BASE[1] - ext) * Rectangle(2 * (HX + kx * ext), 2 * (HY + ky * ext))
    r1 = Pos(0, 0, Z_FRONT) * Rectangle(FRONT_W, FRONT_H)
    return loft([Sketch() + r0, Sketch() + r1])


def _cortes_cabeca():
    k = Part()
    for sx in (-1, 1):
        k += Pos(sx * HC.TR_PITCH / 2, 0, (HC_FRONT_PCB + Z_FRONT + 1) / 2) * Cylinder(
            HC.TR_HOLE / 2, Z_FRONT + 1 - HC_FRONT_PCB)
    hy = HC.PCB_W / 2
    k += caixa(-HC.CRYSTAL_W / 2 - 0.2, HC.CRYSTAL_W / 2 + 0.2, hy - 1.0 - HC.CRYSTAL_H - 0.2, hy - 0.8,
               HC_FRONT_PCB - 0.1, Z_FRONT + 1)
    k += caixa(-PKT_X, PKT_X, -PKT_Y, PKT_Y, -4.0, HC_FRONT_PCB)                  # berco (aberto atras)
    k += caixa(-5.6, 5.6, -PKT_Y, -hy + 3.0, -4.0, HC_FRONT_PCB + 2.5 + 0.3)     # header dos pinos
    k += caixa(-6.4, 6.4, -HY - 5, -PKT_Y + 0.1, -4.0, HC_FRONT_PCB + 3.5 + 0.3)  # saida dos jumpers
    # aba traseira de snap (viga em X na parede +Y do berco)
    yi, yo = PKT_Y, PKT_Y + SNAP.t
    z_in = HC_BACK + 0.4
    k += caixa(TAB_ROOT, TAB_TIP + 0.6, yo, yo + 0.8, -4.0, z_in + SNAP.t + 0.6 + 1.0)
    k += caixa(TAB_TIP, TAB_TIP + 0.6, yi - 0.1, yo + 0.8, -4.0, z_in + SNAP.t + 0.6 + 1.0)
    k += _fenda_inclinada(TAB_ROOT, TAB_TIP + 0.6, yi - 0.15, yo + 0.8, z_in)
    k += Pos(TAB_ROOT, yo + 0.4, 0) * Cylinder(0.4, 30)
    return k


def _dente_aba():
    return dente((TAB_TOOTH_X, PKT_Y, HC_BACK - 0.05 - 1.145), (0, -1, 0), (0, 0, 1), 4.0)


def externa(tilt=0.0):
    T = Pos(0, 0, BASE[1]) * Rot(tilt, 0, 0) * Pos(0, 0, -BASE[1])
    base = serrilha(-VEST.STRAP_W / 2, VEST.STRAP_W / 2, -HY + 1, HY - 1, BASE[0], passo=2.0,
                     h=MNT.SERRATION, para_cima=False)
    cab = T * _cabeca_bruta()
    corpo = base + (cab & caixa(-HX, HX, -HY, HY, BASE[0], Z_FRONT + 10))
    corpo = corpo & caixa(-HX, HX, -HY, HY, BASE[0] - 1, Z_FRONT + 10)
    corpo -= T * _cortes_cabeca()
    corpo += T * _dente_aba()
    for sx in (-1, 1):
        for sy in (-1, 1):
            post = caixa(*_xr(sx, POST["x0"], POST["x0"] + POST["w"]),
                         *_yr(sy, POST["y0"], POST["y0"] + POST["l"]), POST_BOT, BASE[0] + 0.5)
            post = post.chamfer(0.6, None, post.edges().group_by(Axis.Z)[0])
            for k in (0, 1):   # k=1: fita fina -> externa desce 1,2 -> sulco 1,2 mais alto no poste
                post -= dente((sx * (POST["x0"] + POST["w"] / 2), sy * BEAM_Y0, RAT_Z0 + 0.15 + k * PASSO),
                              (0, -sy, 0), (0, 0, -1), POST["w"] + 1.0, y=SNAP.y + 0.25)
            corpo += post
    return corpo, T


# ------------------------------------------------------------------ metade interna
def interna():
    c = caixa(-HX, HX, -HY, HY, *IN_Z)
    c = c.chamfer(TOL.FILLET_PELE, None, c.edges().group_by(Axis.Z)[0])
    c += serrilha(-VEST.STRAP_W / 2, VEST.STRAP_W / 2, -HY + 2, HY, 0, passo=2.0, h=MNT.SERRATION)
    # berco do MV50 (aberto para a fita), janela do motor, canal dos jumpers
    c -= caixa(-MVX, MVX, MV_CY - MVY, MV_CY + MVY, MV_TOP - MV.PCB_T, 2.0)
    c -= caixa(-5.4, 5.4, MV_CY - 5.4, MV_CY + 5.4, MV_TOP - MV.H - 0.1, 0)
    c -= Pos(0, MV_CY, IN_Z[0]) * Cylinder(5.5, 2 * (MV_TOP - MV.PCB_T - IN_Z[0]))
    c -= caixa(-4.6, 4.6, -HY - 1, MV_CY - MVY + 0.1, IN_Z[0] + 1.4, 2.0)
    c -= caixa(-4.4, 4.4, MV_CY - MVY, MV_CY - MV.PCB_L / 2 + 2.75, IN_Z[0] + 1.4, 0)   # pinos sob a PCB
    for sy in (-1, 1):   # pinos conicos (tolerantes) nos furos do MV50
        y = MV_CY + sy * MV.HOLE_PITCH / 2
        c += Pos(0, y, MV_TOP - MV.PCB_T + 0.6) * Cylinder(TOL.PIN_D / 2, 1.2)
        c += Pos(0, y, MV_TOP - 0.2) * Cone(TOL.PIN_D / 2, TOL.PIN_D / 2 - 0.5, 0.6)
    # aba de trava do MV50 (viga em X no lado +Y, altura total, dobra em Y)
    yi = MV_CY + MVY
    yo = yi + SNAP.t
    c -= caixa(LOCK_ROOT, LOCK_TIP + 0.6, yo, yo + 0.8, IN_Z[0] - 1, 2.0)
    c -= caixa(LOCK_TIP, LOCK_TIP + 0.6, yi - 0.1, yo + 0.8, IN_Z[0] - 1, 2.0)
    c -= caixa(LOCK_ROOT, LOCK_TIP + 0.6, yi - 0.1, yi, MV_TOP - MV.PCB_T, 2.0)
    c -= Pos(LOCK_ROOT, yo + 0.4, 0) * Cylinder(0.4, 30)
    c += dente((LOCK_TOOTH_X, yi, -0.1), (0, -1, 0), (0, 0, -1), 4.0)
    # ganchos da catraca (no plano, altura total) e janelas dos postes
    for sx in (-1, 1):
        for sy in (-1, 1):
            xa, xb = (BEAM_ROOT_X, HX + 1) if sx > 0 else (-HX - 1, -BEAM_ROOT_X)
            yb = BEAM_Y0 + SNAP.t
            c -= caixa(xa, xb, *_yr(sy, BEAM_Y0 - 0.6, BEAM_Y0), IN_Z[0] - 1, 2.0)
            c -= caixa(xa, xb, *_yr(sy, yb, yb + 0.8), IN_Z[0] - 1, 2.0)
            for yy in (BEAM_Y0 - 0.3, yb + 0.4):
                c -= Pos(sx * BEAM_ROOT_X, sy * yy, 0) * Cylinder(0.4, 30)
            xw = (POST["x0"] - 0.3, HX + 1) if sx > 0 else (-HX - 1, -POST["x0"] + 0.3)
            c -= caixa(*xw, *_yr(sy, POST["y0"] - 0.3, BEAM_Y0), IN_Z[0] - 1, 2.0)
            c += dente((sx * (POST["x0"] + POST["w"] / 2), sy * BEAM_Y0, RAT_Z0), (0, -sy, 0),
                       (0, 0, -1), POST["w"] - 0.4)
    return c


def build(tilt=MNT.HEADLIGHT_TILT_DEG):
    ext, T = externa(tilt)
    inn = interna()
    mocks = M.place(M.hcsr04(), T * Pos(0, 0, HC_BACK))
    mv_loc = Pos(0, MV_CY, MV_TOP) * Rot(0, 0, -90) * Rot(180, 0, 0)
    mocks += M.place(M.mv50(), mv_loc)
    mocks.append(("fita_60mm", caixa(-VEST.STRAP_W / 2, VEST.STRAP_W / 2, -45, 45, 0, ST), "#556b2f", "visual"))
    imp_ext = Rot(180, 0, 0) * Rot(-tilt, 0, 0)
    return {
        "pecas": [("externa_hcsr04", ext, imp_ext), ("interna_mv50", inn, None)],
        "mockups": mocks,
        "explode": {"externa_hcsr04": (0, 0, 22), "interna_mv50": (0, 0, -18)},
        "explode_mockups": {"hc_": (0, 0, 22), "mv50": (0, 0, -18)},
        "snaps": [("aba traseira do HC-SR04", SNAP.t, TAB_TOOTH_X - TAB_ROOT, SNAP.y),
                  ("catraca da fita (x4)", SNAP.t, POST["x0"] + POST["w"] / 2 - BEAM_ROOT_X, SNAP.y),
                  ("trava do MV50", SNAP.t, LOCK_TOOTH_X - LOCK_ROOT, SNAP.y)],
        "corte": {"x": (POST["x0"] + POST["w"] / 2, 0, 0), "y": (0, 0, 0)},
        "limites": {"largura da base": (2 * HX, MNT.BASE_W)},
    }
