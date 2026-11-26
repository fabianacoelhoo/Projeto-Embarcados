"""Utilitarios de geometria compartilhados (dente de snap-fit, serrilha, pino-guia)."""
import math
from build123d import (Plane, Polygon, extrude, Box, Cylinder, Cone, Pos, Part, Vector)

from params import SNAP, TOL


def caixa(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2) * Box(x1 - x0, y1 - y0, z1 - z0)


def perfil_dente(y=SNAP.y, ang_entrada=SNAP.ang_entrada, ang_ret=SNAP.ang_retencao):
    """Pontos (n, a) do dente: n = altura (para fora da face), a = ao longo da insercao.
    Rampa de entrada (ang_entrada da face) na frente (a=0); face de retencao atras."""
    a_rampa = y / math.tan(math.radians(ang_entrada))
    a_ret = y / math.tan(math.radians(ang_ret))
    return [(0, 0), (y, a_rampa), (0, a_rampa + a_ret)], a_rampa + a_ret


def dente(origem, N, A, largura, y=SNAP.y):
    """Dente triangular sobre uma face.
    origem: ponto na face onde comeca a rampa; N: normal da face (para onde o dente cresce);
    A: direcao de insercao da peca que encaixa (a rampa encontra ela primeiro);
    largura: extensao do dente na direcao N x A (centrada)."""
    N, A = Vector(N).normalized(), Vector(A).normalized()
    E = N.cross(A)
    pts, comp = perfil_dente(y)
    pl = Plane(origin=Vector(origem) - E * (largura / 2), x_dir=N, z_dir=E)
    return extrude(pl * Polygon(*pts, align=None), amount=largura)


def comprimento_dente(y=SNAP.y):
    return perfil_dente(y)[1]


def serrilha(x0, x1, y0, y1, z, passo=2.0, h=0.6, para_cima=True):
    """Dentes triangulares (anti-deslizamento) correndo ao longo de X, repetidos em Y.
    Base em z, crescendo para +Z (ou -Z). Flancos a 45 graus (h = passo/2 no maximo)."""
    h = min(h, passo / 2)
    s = 1 if para_cima else -1
    out = Part()
    n = int((y1 - y0) // passo)
    y_ini = y0 + ((y1 - y0) - n * passo) / 2
    for i in range(n):
        yc = y_ini + i * passo + passo / 2
        pl = Plane(origin=(x0, 0, 0), x_dir=(0, 1, 0), z_dir=(1, 0, 0))
        pts = [(yc - passo / 2, z), (yc + passo / 2, z), (yc, z + s * h)]
        if s < 0:
            pts = pts[::-1]
        tri = Polygon(*pts, align=None)
        out += extrude(pl * tri, amount=x1 - x0)
    return out


def pino_guia(x, y, z_base, altura, d=TOL.PIN_D, chanfro=TOL.PIN_CHAMFER, eixo="z"):
    """Pino cilindrico com chanfro de 45 graus na ponta, crescendo a partir de z_base em +Z."""
    corpo = Pos(x, y, z_base + (altura - chanfro) / 2) * Cylinder(d / 2, altura - chanfro)
    ponta = Pos(x, y, z_base + altura - chanfro / 2) * Cone(d / 2, d / 2 - chanfro, chanfro)
    return corpo + ponta

