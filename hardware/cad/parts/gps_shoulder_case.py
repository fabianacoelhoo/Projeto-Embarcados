"""Peca 3 - case do GPS no ombro (perfil baixo), sem parafusos.

Referencial de montagem: fita (60 mm) corre ao longo de Y, largura em X, Z+ = ceu.
Fita em z = 0..STRAP_T_MAX.  Tres pecas:
  contraplaca  - abaixo da fita (lado do corpo), serrilha 0,6 + 4 postes com catraca
  case         - acima da fita: compartimento NEO-6M | parede 1,6 | compartimento antena
  tampa        - snap-fit; 1,2 mm sobre a antena; difusor sobre o LED de fix
Fixacao na fita: os 4 postes da contraplaca sobem por fora da fita e sao presos por
4 ganchos cantilever no plano da base do case (dobram em XY -> nao delaminam).
A catraca tem 2 posicoes (passo 1,2 mm): fita de 2,8 mm ou de 1,6 mm (+ serrilha).
"""
from build123d import Pos, Rot, Cylinder, Plane, Polygon, extrude, Axis, Part

from params import TOL, VEST, GPSM, SNAP, MNT
from cadlib import caixa, dente, serrilha, pino_guia
import mockups as M

NOME = "gps_shoulder_case"
ST = VEST.STRAP_T_MAX                 # 2,8: fita mais grossa (posicao 1 da catraca)
CP_T = TOL.WALL                       # contraplaca
HX = MNT.BASE_W / 2                   # 34
HY = 25.0                             # meia-largura ao longo da fita (com "orelhas")
FLOOR = ST + TOL.WALL                 # topo do piso do case (4,8)
EAR_TOP = ST + 4.0                    # orelhas mais grossas (vigas da catraca)
W = TOL.WALL
# compartimentos (X): parede | NEO 36,4 | divisoria 1,6 | antena 25,4 | parede
NEO_X = (-HX + 0.3 + W, -HX + 0.3 + W + GPSM.PCB_L + TOL.PCB_GAP)        # (-31.7, 4.7)
DIV_X = (NEO_X[1], NEO_X[1] + 1.6)
ANT_X = (DIV_X[1], DIV_X[1] + GPSM.ANT_L + TOL.PCB_GAP)                   # (6.3, 31.7)
IN_Y = (GPSM.PCB_W + TOL.PCB_GAP) / 2                                      # 13.2
ANT_Y = (GPSM.ANT_W + TOL.PCB_GAP) / 2                                     # 12.7
OUT_X = (NEO_X[0] - W, ANT_X[1] + W)
OUT_Y = IN_Y + W
ANT_TOP = FLOOR + GPSM.ANT_H
LID_IN = ANT_TOP + 0.2 - (TOL.WALL - TOL.WALL_THIN_GPS)   # face interna fora da antena
WALL_TOP = LID_IN
LID_TOP = WALL_TOP + TOL.WALL
GPS_C = ((NEO_X[0] + NEO_X[1]) / 2, 0.0)
ANT_C = ((ANT_X[0] + ANT_X[1]) / 2, 0.0)
# catraca
POST = dict(x0=VEST.STRAP_W / 2 + 0.8, w=3.0, y0=16.5, l=4.0)   # x 30.8..33.8, y 16.5..20.5
POST_TOP = EAR_TOP - 0.2
RAT_GAP = 0.15
BEAM_Y0 = POST["y0"] + POST["l"] + RAT_GAP                       # face do gancho (20.65)
BEAM_ROOT_X = 20.0
RAT_Z0 = ST + 1.5                                                # inicio da rampa do dente
PASSO = 1.2
# trava da tampa (vigas nas paredes +-Y, lado do NEO)
LAT_ROOT, LAT_TIP = NEO_X[0] + 4.7, NEO_X[0] + 16.7               # L = 12
LAT_Z0 = WALL_TOP - 3.2
SKIRT_T = 1.2


def _x_post(sx):
    a, b = POST["x0"], POST["x0"] + POST["w"]
    return (a, b) if sx > 0 else (-b, -a)


def _y_rng(sy, a, b):
    return (a, b) if sy > 0 else (-b, -a)


def contraplaca():
    c = caixa(-HX, HX, -HY, HY, -CP_T, 0)
    try:
        c = c.chamfer(TOL.FILLET_PELE, None, c.edges().group_by(Axis.Z)[0])  # 45 graus: imprime sem suporte
    except Exception:
        pass
    c += serrilha(-VEST.STRAP_W / 2, VEST.STRAP_W / 2, -HY + 1, HY - 1, 0, passo=2.0, h=MNT.SERRATION)
    for sx in (-1, 1):
        for sy in (-1, 1):
            post = caixa(*_x_post(sx), *_y_rng(sy, POST["y0"], POST["y0"] + POST["l"]), 0, POST_TOP)
            for k in (0, 1):   # sulcos da catraca (k=1: fita fina, case 1,2 mm mais baixo)
                post -= dente((sx * (POST["x0"] + POST["w"] / 2), sy * BEAM_Y0, RAT_Z0 - 0.15 - k * PASSO),
                              (0, -sy, 0), (0, 0, 1), POST["w"] + 1.0, y=SNAP.y + 0.25)
            c += post
    return c


def _viga_catraca(c, sx, sy):
    """Corta o gancho cantilever (no plano XY) numa orelha e poe o dente."""
    xa = min(sx * BEAM_ROOT_X, sx * (HX + 1))
    xb = max(sx * BEAM_ROOT_X, sx * (HX + 1))
    yb = BEAM_Y0 + SNAP.t
    # fresta interna (entre viga e orelha) e externa (espaco para dobrar 0,6 + folga)
    c -= caixa(xa, xb, *_y_rng(sy, BEAM_Y0 - 0.6, BEAM_Y0), FLOOR - 3, EAR_TOP + 1)
    c -= caixa(xa, xb, *_y_rng(sy, yb, yb + 0.8), FLOOR - 3, EAR_TOP + 1)
    for yy in (BEAM_Y0 - 0.3, yb + 0.4):   # alivio arredondado na raiz
        c -= Pos(sx * BEAM_ROOT_X, sy * yy, EAR_TOP) * Cylinder(0.4, 20)
    # janela do poste (aberta para a borda externa)
    xp = _x_post(sx)
    xw = (xp[0] - 0.3, HX + 1) if sx > 0 else (-HX - 1, xp[1] + 0.3)
    c -= caixa(*xw, *_y_rng(sy, POST["y0"] - 0.3, BEAM_Y0), ST - 1, EAR_TOP + 1)
    c += dente((sx * (POST["x0"] + POST["w"] / 2), sy * BEAM_Y0, RAT_Z0), (0, -sy, 0), (0, 0, 1), POST["w"] - 0.4)
    return c


def _trava_tampa(c, sy):
    """Viga cantilever na parede +-Y (dobra em Y, comprimento em X): fresta inclinada a 45
    graus por baixo (sem balanco), alivio externo de 0,4 e dente para dentro."""
    yi, yo = IN_Y, IN_Y + SNAP.t
    c -= caixa(LAT_ROOT, LAT_TIP + 0.6, *_y_rng(sy, yo, OUT_Y + 0.5), LAT_Z0, WALL_TOP + 1)
    c -= caixa(LAT_TIP, LAT_TIP + 0.6, *_y_rng(sy, yi - 0.1, OUT_Y + 0.5), LAT_Z0 - 0.6, WALL_TOP + 1)
    pl = Plane(origin=(LAT_ROOT, 0, 0), x_dir=(0, 1, 0), z_dir=(1, 0, 0))
    pts = [(yi - 0.1, LAT_Z0 - 0.6), (yo + 0.1, LAT_Z0 - 0.6 + (SNAP.t + 0.2)),
           (yo + 0.1, LAT_Z0 + (SNAP.t + 0.2)), (yi - 0.1, LAT_Z0)]
    if sy < 0:
        pts = [(-a, b) for a, b in pts][::-1]
    c -= extrude(pl * Polygon(*pts, align=None), amount=LAT_TIP + 0.6 - LAT_ROOT)
    zt = WALL_TOP - 0.6
    c += dente(((LAT_TIP + LAT_ROOT) / 2 + 4.5, sy * yi, zt), (0, -sy, 0), (0, 0, -1), 3.0)
    return c


def case():
    c = caixa(-HX, HX, -HY, HY, ST, FLOOR)
    for sy in (-1, 1):
        c += caixa(-HX, HX, *_y_rng(sy, OUT_Y, HY), ST, EAR_TOP)
    c += caixa(*OUT_X, -OUT_Y, OUT_Y, FLOOR, WALL_TOP)
    c -= caixa(NEO_X[0], ANT_X[1], -IN_Y, IN_Y, FLOOR, WALL_TOP + 1)
    c += caixa(*DIV_X, -IN_Y, IN_Y, FLOOR, WALL_TOP)
    for sy in (-1, 1):   # nervuras que estreitam o compartimento da antena para 25,4
        c += caixa(*ANT_X, *_y_rng(sy, ANT_Y, IN_Y), FLOOR, WALL_TOP)
    # pinos-guia nos furos diagonais do GPS
    for fx, fy in (M.GPS_FUROS[0], M.GPS_FUROS[3]):
        c += pino_guia(GPS_C[0] - fx, GPS_C[1] - fy, FLOOR, GPSM.PCB_T + 1.0)
    # canal de saida dos 4 fios (parede -X), aberto em cima
    c -= caixa(OUT_X[0] - 1, NEO_X[0] + 0.1, -5.6, 5.6, FLOOR + 1.2, WALL_TOP + 1)
    # fenda lisa do coaxial na base da divisoria
    yc = -5.5
    c -= caixa(DIV_X[0] - 0.1, DIV_X[1] + 0.1, yc - 2.0, yc + 2.0, FLOOR, FLOOR + 2.0)
    c -= Pos((DIV_X[0] + DIV_X[1]) / 2, yc, FLOOR + 2.0) * Rot(0, 90, 0) * Cylinder(2.0, 2.0)
    for sx in (-1, 1):
        for sy in (-1, 1):
            c = _viga_catraca(c, sx, sy)
    for sy in (-1, 1):
        c = _trava_tampa(c, sy)
    return c


def tampa():
    t = caixa(*OUT_X, -OUT_Y, OUT_Y, WALL_TOP, LID_TOP)
    t -= caixa(*ANT_X, -ANT_Y, ANT_Y, WALL_TOP - 1, LID_TOP - TOL.WALL_THIN_GPS)   # 1,2 sobre a antena
    lx, ly = GPS_C[0] - M.GPS_LED_XY[0], GPS_C[1] - M.GPS_LED_XY[1]
    t -= Pos(lx, ly, WALL_TOP) * Cylinder(2.0, 2 * (TOL.WALL - 0.6))                # difusor 0,6
    zb = FLOOR + GPSM.PCB_T + 3.0
    for sy in (-1, 1):
        yo = IN_Y - TOL.SNAP_GAP
        sk = caixa(NEO_X[0] + 0.3, NEO_X[1] - 0.3, *_y_rng(sy, yo - SKIRT_T, yo), zb, WALL_TOP)
        for x0, x1 in ((NEO_X[0] + 2.5, NEO_X[0] + 6.5), (NEO_X[1] - 6.5, NEO_X[1] - 2.5)):
            sk += caixa(x0, x1, *_y_rng(sy, yo - SKIRT_T, yo), FLOOR + GPSM.PCB_T, zb)   # pes
        xd = (LAT_TIP + LAT_ROOT) / 2 + 4.5
        zt = WALL_TOP - 0.6
        sk -= caixa(xd - 1.8, xd + 1.8, *_y_rng(sy, yo - 0.75, yo + 0.1), zt - 1.6, zt + 0.15)
        t += sk
    return t


def build():
    cp, cs, tp = contraplaca(), case(), tampa()
    mocks = []
    gps_loc = Pos(GPS_C[0], GPS_C[1], FLOOR) * Rot(0, 0, 180)
    mocks += M.place(M.gps_neo6m(), gps_loc)
    mocks += M.place(M.antena_gps(ceu_ate=LID_TOP - TOL.WALL_THIN_GPS - ANT_TOP), Pos(*ANT_C, FLOOR))
    # caminho do coaxial (U.FL -> fenda -> antena)
    ko = caixa(GPS_C[0] - (-13.0) - 3.0, DIV_X[1] + 3.0, -6.3, -4.7, FLOOR + GPSM.PCB_T, FLOOR + GPSM.PCB_T + 1.6)
    ko += caixa(NEO_X[1] - 0.3, DIV_X[1] + 3.0, -6.2, -4.8, FLOOR + 0.1, FLOOR + 1.6)
    mocks.append(("ko_coaxial", ko, M.KO, "keepout"))
    mocks.append(("fita_60mm", caixa(-VEST.STRAP_W / 2, VEST.STRAP_W / 2, -45, 45, 0, ST), "#556b2f", "visual"))
    x_dente = (LAT_TIP + LAT_ROOT) / 2 + 4.5
    snaps = [("trava da tampa (x2)", SNAP.t, x_dente - LAT_ROOT, SNAP.y),
             ("catraca da fita (x4)", SNAP.t, POST["x0"] + POST["w"] / 2 - BEAM_ROOT_X, SNAP.y)]
    return {
        "pecas": [("case", cs, None), ("tampa", tp, Rot(180, 0, 0)), ("contraplaca", cp, None)],
        "mockups": mocks,
        "explode": {"tampa": (0, 0, 25), "contraplaca": (0, 0, -20), "case": (0, 0, 0)},
        "explode_mockups": {"gps": (0, 0, 10), "antena": (0, 0, 10), "ko_coaxial": (0, 0, 10)},
        "snaps": snaps,
        "corte": {"x": (POST["x0"] + POST["w"] / 2, 0, 0), "y": (0, -5.5, 0)},
        "limites": {"altura acima da fita (case+tampa)": (LID_TOP - ST, 15.0),
                    "largura da base": (2 * HX, MNT.BASE_W)},
    }
