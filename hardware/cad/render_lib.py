"""Renderizacao offscreen (pyvista/VTK; sem tela). Usado por verify.py."""
import os

import numpy as np
import pyvista as pv
from build123d import Pos, export_stl

from params import RND

pv.OFF_SCREEN = True
CINZA = "#9aa3ad"


def _malha(shape, tmp, nome):
    p = os.path.join(tmp, nome.replace("/", "_") + ".stl")
    export_stl(shape, p, tolerance=0.05, angular_tolerance=0.3)
    return pv.read(p)


def _cena(a, tmp, explode=False):
    itens = []
    for pn, s, _ in a["pecas"]:
        if explode:
            s = Pos(*a["explode"].get(pn, (0, 0, 0))) * s
        itens.append((_malha(s, tmp, "p_" + pn), CINZA, RND.alpha_case, "peca"))
    for mn, s, cor, tipo in a["mockups"]:
        if explode:
            for pref, v in a.get("explode_mockups", {}).items():
                if mn.startswith(pref) or mn.startswith("ko_" + pref):
                    s = Pos(*v) * s
                    break
        if tipo == "visual":
            itens.append((_malha(s, tmp, "v_" + mn), cor, 0.35, tipo))
        elif tipo == "keepout":
            itens.append((_malha(s, tmp, "k_" + mn), "#e02424", 0.18, tipo))
        else:
            itens.append((_malha(s, tmp, "m_" + mn), cor, 1.0, tipo))
    return itens


def _plot(itens, arq, titulo, vista, corte=None, origem=None):
    pl = pv.Plotter(off_screen=True, window_size=(1400, 1050))
    pl.set_background("white")
    pts = np.vstack([m.points for m, _, _, t in itens if t in ("peca", "comp")])
    centro = (pts.min(0) + pts.max(0)) / 2
    if origem is not None:
        centro = np.array(origem, dtype=float)
    for m, cor, alpha, tipo in itens:
        if corte is not None:
            normal = {"x": (1, 0, 0), "y": (0, 1, 0)}[corte]
            # mantem o lado negativo (x < origem); a camera fica no lado +normal, de frente
            # para a face cortada (tampa a secao com clip_closed_surface)
            try:
                m = m.clip_closed_surface(normal=tuple(-v for v in normal), origin=centro)
            except Exception:
                m = m.clip(normal=normal, origin=centro, invert=True)
            if m.n_points == 0:
                continue
            if tipo == "peca":
                alpha = 0.85
        pl.add_mesh(m, color=cor, opacity=alpha, smooth_shading=False,
                    show_edges=False, specular=0.2)
    pl.add_text(titulo, font_size=12, color="black")
    pl.show_axes()
    if vista == "iso":
        pl.view_isometric()
    elif vista == "x":
        pl.view_vector((1, 0, 0), viewup=(0, 0, 1))
    elif vista == "y":
        pl.view_vector((0, 1, 0), viewup=(0, 0, 1))
    lo, hi = pts.min(0), pts.max(0)
    pl.reset_camera(bounds=(lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]))
    pl.camera.zoom(1.1)
    pl.screenshot(arq)
    pl.close()


def renderizar(nome, a, pasta, tmp):
    os.makedirs(pasta, exist_ok=True)
    base = _cena(a, tmp)
    view = a.get("vista_corte", {"x": "x", "y": "y"})
    _plot(base, os.path.join(pasta, "iso.png"), f"{nome} - isometrica", "iso")
    _plot(_cena(a, tmp, explode=True), os.path.join(pasta, "exploded.png"),
          f"{nome} - explodida", "iso")
    org = a.get("corte", {})
    _plot(base, os.path.join(pasta, "section_x.png"),
          f"{nome} - corte X (plano YZ em x={org.get('x', (0, 0, 0))[0]:.1f})", view["x"], corte="x",
          origem=org.get("x"))
    _plot(base, os.path.join(pasta, "section_y.png"),
          f"{nome} - corte Y (plano XZ em y={org.get('y', (0, 0, 0))[1]:.1f})", view["y"], corte="y",
          origem=org.get("y"))
    for arq, eixo, origem in a.get("cortes_extras", []):
        _plot(base, os.path.join(pasta, arq + ".png"), f"{nome} - {arq}", eixo, corte=eixo, origem=origem)
