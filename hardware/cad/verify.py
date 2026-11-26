"""EchoMap CAD - gera e valida todas as pecas.  Uso:  python verify.py [nome_da_peca ...]

1. Exporta STL (orientacao de impressao) para export/stl e STEP para export/step.
2. trimesh: is_watertight, is_winding_consistent, caixa envolvente, peso (1,24 g/cm3).
3. Colisao (booleana build123d) peca x mockup/keep-out e peca x peca: reprova > 0,5 mm3.
4. Snap-fit (deformacao vs. limite do material) e balanco de impressao (> 45 graus fora
   da mesa; regioes estreitas <= 15 mm contam como ponte).
5. Renderiza renders/<peca>/{iso,exploded,section_x,section_y}.png (pyvista offscreen).
Sai com codigo 1 se algo reprovar.  Tambem roda como `pytest verify.py`.
"""
import importlib
import os
import sys
import tempfile

import numpy as np
import trimesh
from build123d import Location, Pos, Compound, export_stl, export_step

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
sys.path.insert(0, os.path.join(AQUI, "parts"))

from params import MAT, RND  # noqa: E402

PECAS = ["tolerance_test_card", "gps_shoulder_case", "headlight_haptic_mount", "central_case"]
LIMITE_COLISAO = 0.5
PONTE_MAX = 15.0
STL_DIR = os.path.join(AQUI, "export", "stl")
STEP_DIR = os.path.join(AQUI, "export", "step")
REN_DIR = os.path.join(AQUI, "renders")
TMP = tempfile.mkdtemp(prefix="cad_")


def volume(shape):
    if shape is None:
        return 0.0
    try:
        return sum(s.volume for s in shape.solids())
    except Exception:
        return 0.0


def para_impressao(solido, loc):
    s = solido if loc is None else loc * solido
    bb = s.bounding_box()
    return Pos(-(bb.min.X + bb.max.X) / 2, -(bb.min.Y + bb.max.Y) / 2, -bb.min.Z) * s


def area_em_balanco(m, max_ang=45.0, tol_mesa=0.05):
    """Devolve (area_reprovada, area_ponte). Faces viradas para baixo alem de max_ang,
    fora da mesa, agrupadas por vizinhanca; grupo com menor lado XY <= PONTE_MAX = ponte."""
    zmin = m.bounds[0][2]
    baixo = m.face_normals[:, 2] < -np.cos(np.radians(max_ang)) - 1e-6
    mesa = np.all(np.abs(m.vertices[m.faces][:, :, 2] - zmin) < tol_mesa, axis=1)
    sel = np.where(baixo & ~mesa)[0]
    if len(sel) == 0:
        return 0.0, 0.0
    sub = m.submesh([sel], append=True)
    ruim = ponte = 0.0
    for comp in sub.split(only_watertight=False, repair=False):
        ext = comp.bounds[1] - comp.bounds[0]
        if min(ext[0], ext[1]) <= PONTE_MAX:
            ponte += comp.area
        else:
            ruim += comp.area
    return ruim, ponte


def deformacao(t, L, y):
    return 1.5 * t * y / L ** 2


class Relatorio:
    def __init__(self):
        self.linhas, self.falhas = [], []

    def ok(self, cond, msg):
        self.linhas.append(("APROVADO " if cond else "REPROVADO") + "  " + msg)
        if not cond:
            self.falhas.append(msg)
        return cond

    def info(self, msg):
        self.linhas.append("          " + msg)


def verificar(nome, render=True, rel=None):
    rel = rel or Relatorio()
    mod = importlib.import_module(nome)
    for suf, arg in getattr(mod, "VARIANTES", {"": None}).items():
        a = mod.build() if arg is None else mod.build(arg)
        _verificar_montagem(nome + suf, a, render, rel)
    return rel


def _verificar_montagem(nome, a, render, rel):
    rel.info(f"== {nome} ==")
    os.makedirs(STL_DIR, exist_ok=True)
    os.makedirs(STEP_DIR, exist_ok=True)

    # 1-2. exportacao + malha
    for pn, solido, loc in a["pecas"]:
        imp = para_impressao(solido, loc)
        stl = os.path.join(STL_DIR, f"{nome}__{pn}.stl" if len(a["pecas"]) > 1 else f"{nome}.stl")
        export_stl(imp, stl, tolerance=0.02, angular_tolerance=0.15)
        export_step(imp, os.path.join(STEP_DIR, os.path.basename(stl)[:-4] + ".step"))
        m = trimesh.load(stl)
        ext = m.bounds[1] - m.bounds[0]
        rel.ok(m.is_watertight, f"{pn}: malha fechada (watertight)")
        rel.ok(m.is_winding_consistent, f"{pn}: normais consistentes (winding)")
        n_sol = len(solido.solids())
        rel.ok(n_sol == 1, f"{pn}: corpo unico ({n_sol} solido(s))")
        g = volume(solido) / 1000.0 * MAT.densidade_g_cm3
        rel.info(f"{pn}: caixa de impressao {ext[0]:.1f} x {ext[1]:.1f} x {ext[2]:.1f} mm, "
                 f"{volume(solido)/1000:.2f} cm3, ~{g:.1f} g macico")
        ruim, ponte = area_em_balanco(m)
        rel.ok(ruim < 1.0, f"{pn}: balanco sem suporte {ruim:.1f} mm2 (pontes <= {PONTE_MAX:.0f} mm: {ponte:.1f} mm2)")
    for k, v in a.get("limites", {}).items():
        rel.ok(v[0] <= v[1], f"limite {k}: {v[0]:.1f} <= {v[1]:.1f} mm")
    if len(a["pecas"]) > 0:
        export_step(Compound(children=[s for _, s, _ in a["pecas"]]),
                    os.path.join(STEP_DIR, f"{nome}__montagem.step"))

    # 3. colisao
    pior = 0.0
    for pn, solido, _ in a["pecas"]:
        for mn, ms, _, tipo in a["mockups"]:
            if tipo == "visual":
                continue
            v = volume(solido & ms)
            pior = max(pior, v)
            if v > LIMITE_COLISAO:
                rel.ok(False, f"COLISAO {pn} x {mn} ({tipo}): {v:.2f} mm3")
    pecas = a["pecas"]
    for i in range(len(pecas)):
        for j in range(i + 1, len(pecas)):
            v = volume(pecas[i][1] & pecas[j][1])
            pior = max(pior, v)
            rel.ok(v <= LIMITE_COLISAO, f"interferencia {pecas[i][0]} x {pecas[j][0]}: {v:.2f} mm3")
    rel.ok(pior <= LIMITE_COLISAO, f"colisao com mockups/keep-outs: pior {pior:.2f} mm3 (limite {LIMITE_COLISAO})")

    # 4. snap-fit
    lim = MAT.limite_def
    for sn, t, L, y in a.get("snaps", []):
        e = deformacao(t, L, y)
        geo = 8.0 <= L and 1.4 <= t <= 1.8
        rel.ok(geo and e <= lim[MAT.nome],
               f"snap '{sn}': t={t} L={L} y={y} -> {e*100:.2f} % (PLA {lim['PLA']*100:.1f} / "
               f"PETG {lim['PETG']*100:.1f}; material {MAT.nome})")
        if e > lim["PLA"]:
            rel.info(f"    atencao: '{sn}' passa do limite do PLA - imprimir em PETG")

    if render:
        import render_lib
        render_lib.renderizar(nome, a, os.path.join(REN_DIR, nome), TMP)
        rel.info(f"renders: renders/{nome}/iso.png, exploded.png, section_x.png, section_y.png")


def main(nomes):
    rel = Relatorio()
    for n in nomes:
        verificar(n, rel=rel)
    print("\n".join(rel.linhas))
    print(f"\n{len(rel.falhas)} reprovacao(oes)")
    return 1 if rel.falhas else 0


def _existe(n):
    return os.path.exists(os.path.join(AQUI, "parts", n + ".py"))


def test_pecas():
    for n in [p for p in PECAS if _existe(p)]:
        r = verificar(n, render=False)
        assert not r.falhas, "\n".join(r.falhas)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or [p for p in PECAS if _existe(p)]))
