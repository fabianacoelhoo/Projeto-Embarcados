# EchoMap — cases e suportes vestíveis (CAD)

Modelos 3D paramétricos (build123d, Python) dos cases do EchoMap, todos **sem parafuso**: snap-fit, catraca e dobradiça viva. Os arquivos para imprimir já estão em `export/stl/` (orientação de impressão) e `export/step/` (cada peça e a montagem).

| Peça | Arquivos | Quantidade |
|---|---|---|
| 0. Cartão de tolerância | `tolerance_test_card__card.stl` + `__snap_macho.stl` | 1 (imprima primeiro) |
| 1. Case central (bolso 78 × 160) | `central_case__corpo.stl` + `__tampa.stl` | 1 |
| 2. Suporte farol + háptico | `headlight_haptic_mount__externa_hcsr04.stl` + `__interna_mv50.stl` | 2 |
| 2b. Mesmo suporte, HC-SR04 inclinado −8° | `headlight_haptic_mount_tilt-8__*.stl` | opcional |
| 3. Case do GPS no ombro | `gps_shoulder_case__case.stl` + `__tampa.stl` + `__contraplaca.stl` | 1 |

## Como usar

```powershell
cd hardware\cad
py -3.12 -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python verify.py                 # gera tudo e valida
.venv\Scripts\python verify.py central_case    # só uma peça
.venv\Scripts\python -m pytest -q verify.py    # mesmo teste, sem renders
```

Linux/macOS: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`. A renderização é offscreen (pyvista/VTK) e funciona sem tela.

Todas as medidas ficam em `params.py`. Para mudar uma folga ou um componente, altere só esse arquivo e rode `verify.py` de novo.

## O que o `verify.py` confere

Para cada peça:

1. Exporta STL (já na orientação de impressão) e STEP.
2. Malha fechada (`is_watertight`), normais consistentes (`is_winding_consistent`) e corpo único.
3. Caixa de impressão e peso maciço (1,24 g/cm³).
4. Colisão (booleana) de cada peça com os mockups dos componentes e com os volumes que precisam ficar livres:
   - plugue USB-C;
   - 18 mm dos jumpers;
   - cone de 15° dos transdutores do HC-SR04;
   - coaxial do GPS;
   - céu da antena;
   - knob do potenciômetro.

   Reprova acima de 0,5 mm³. Também confere peça contra peça.
5. Snap-fit: deformação ε = 1,5·t·y/L² contra o limite do material (PLA 1,5 %, PETG 2,5 %).
6. Balanço de impressão: nenhuma face fora da mesa passa de 45°, a não ser pontes de até 15 mm.
7. Gera `renders/<peça>/iso.png`, `exploded.png`, `section_x.png` e `section_y.png`, com o case semitransparente, os módulos coloridos e as zonas livres em vermelho.

Resultado atual: **73 verificações aprovadas, 0 reprovadas.**

| Snap-fit | t × L × y (mm) | Deformação |
|---|---|---|
| Seta do cartão de tolerância | 1,6 × 10 × 0,6 | 1,44 % |
| Trava da tampa do case central | 1,6 × 11,5 × 0,6 | 1,09 % |
| Aba elástica do MPU-6050 | 1,6 × 10 × 0,6 | 1,44 % |
| Aba traseira do HC-SR04 | 1,6 × 11,5 × 0,6 | 1,09 % |
| Catraca da fita (×4 por suporte) | 1,6 × 12 × 0,6 | 1,00 % |
| Trava do MV50 | 1,6 × 10,25 × 0,6 | 1,37 % |
| Trava da tampa do GPS | 1,6 × 10,5 × 0,6 | 1,31 % |

Todos passam até em PLA, mas use **PETG** nas peças vestíveis (veja abaixo).

## Guia de impressão

**Material**
- **PETG** para tudo que vai no colete. O PLA amolece a 55–60 °C (carro fechado, sol) e as travas perdem a pressão.
- PLA serve para o cartão de tolerância e para protótipos rápidos de encaixe.

| | PLA | PETG |
|---|---|---|
| Bico / mesa | 200–210 °C / 60 °C | 230–240 °C / 75–80 °C |
| Ventoinha | 100 % | 30–50 % (melhor para as camadas aderirem nas travas) |
| Uso | teste de encaixe | peça final |

**Configuração comum:** bico 0,4 mm, **camada 0,2 mm**, **5 perímetros** (parede de 2 mm maciça, onde ficam as travas), 5 camadas de topo e fundo, **preenchimento gyroid de 25 a 40 %**. **Sem suporte em nenhuma peça.**

**Orientação na mesa** (os STL já saem assim, é só não girar):

| Peça | Face na mesa | Por quê |
|---|---|---|
| Case central — corpo | costas (lado do peito) | travas laterais dobram no plano XY; furos do topo são horizontais pequenos (ponte ≤ 15 mm) |
| Case central — tampa | face externa | nervuras e saia para cima |
| Suporte — externa (HC-SR04) | face frontal (furos de 16,4) | furos verticais e redondos; flancos a ≤ 45° |
| Suporte — interna (MV50) | face do corpo | ganchos da catraca dobram em XY |
| GPS — case | base (lado da fita) | |
| GPS — tampa | face externa | |
| GPS — contraplaca | face do corpo | postes e serrilha para cima |

Peso estimado (maciço): central 73 g; suporte 71 g cada; GPS 29 g. Com 5 perímetros e 30 % de preenchimento, conte com uns 60 % disso.

## Montagem

**Case central**
1. Encaixe o LED por dentro no colar de atrito (a aba do LED encosta embaixo do colar) e o botão 6×6 no berço (pernas nos canais).
2. Rosqueie o WH148 por dentro no furo do topo, com o pino anti-giro no furo pequeno, e aperte a porca M7 por fora.
3. Prenda o MPU-6050 com os pinos virados para baixo:
   1. Abra a aba elástica com a unha.
   2. Assente o MPU-6050 nos 2 pinos de 2,65 mm, com os pinos dele passando pela fenda da prateleira.
   3. Solte a aba.

   Eixos: X para a frente da pessoa, Y para a esquerda, Z para cima.
4. Ligue os jumpers fêmea direto nos pinos do ESP32 (18 mm livres na frente). Assente o ESP32 com o USB-C para baixo, no corte da parede.
5. Passe os chicotes pelas saídas laterais em S: entrem por dentro, deem a volta nos 2 pinos e saiam pela janela.
6. Feche a tampa até ouvir os 2 cliques. As 2 nervuras da tampa prendem o ESP32 nas pontas, onde não há pinos.

**Suporte farol + háptico (na fita de 60 mm)**
1. Externa: empurre o HC-SR04 por trás até os transdutores aparecerem nos furos de 16,4. A aba traseira trava a placa e os pinos saem por baixo.
2. Interna: assente o MV50 com o motor virado para o corpo, nos 2 pinos cônicos, até a aba de trava estalar.
3. Passe a fita entre as metades, entre os 4 postes da externa, e aperte uma contra a outra.
   - Primeiro clique: fita de 2,8 mm.
   - Segundo clique: fita de 1,6 mm ou mais fina.

   Para soltar, afaste os 4 ganchos com uma chave de fenda pequena.

**GPS no ombro**
1. Cole a antena com a fita dupla-face dela no compartimento da direita, com a face cerâmica para cima. O coaxial passa pela fenda da divisória.
2. Assente o NEO-6M nos 2 pinos diagonais, com os 4 fios saindo pelo canal da parede.
3. Feche a tampa. Os pés da saia prendem a placa e o LED de fix aparece pelo difusor de 0,6 mm.
4. Prenda na fita com a contraplaca, com a mesma catraca de 2 posições do suporte.

## Medidas para conferir com o paquímetro

Os valores em `params.py` com `fonte = "tipico - medir"` ainda não foram medidos. Meça antes da impressão final:

- **ESP32 DevKit:** comprimento (51,5 a 55,0; o batente aceita até 55,5 e usa calço se for menor), largura 28,5, altura dos componentes por baixo (3,5) e posição dos headers.
- **MPU-6050:** distância dos furos até a borda e lado dos pinos.
- **HC-SR04:** altura dos transdutores (12) e posição do cristal.
- **MV50:** placa 23,5 × 21,5, altura 5,2, passo dos furos 16, de que lado ficam os 3 pinos e o motor.
- **GPS GY-GPS6MV2:** posição do conector U.FL, do LED de fix e dos furos. Meça também a altura real da antena (8 mm no projeto).

**Depois do cartão de tolerância**, ajuste o bloco `Tolerancias` em `params.py` e registre a data em `data_calibracao`:

| Teste no cartão | Se ficou apertado | Se ficou folgado |
|---|---|---|
| Trilho do ESP32 | `PCB_GAP` + 0,1 | `PCB_GAP` − 0,1 |
| Furos de 16,4 e 7,4 | `HOLE_GAP` + 0,1 | `HOLE_GAP` − 0,1 |
| Pinos de 2,65 no MPU | `PIN_D` − 0,05 | `PIN_D` + 0,05 |
| Snap macho/fêmea | `SNAP_GAP` + 0,05 | `SNAP_GAP` − 0,05 |

## Decisões de projeto

- **Catraca da fita:** os 4 ganchos cantilever ficam na peça em que eles dobram no plano XY da impressão (interna do suporte, case do GPS) e os postes com os dentes ficam na outra. Gancho que dobra entre camadas delamina.
- **Serrilha:** 0,6 mm a 45° nas duas faces que apertam a fita.
- **Arestas do lado do corpo:** chanfro de 45° de 1,5 mm no lugar do raio, porque o raio na face da mesa precisaria de suporte. Passe uma lixa leve.
- **Ventilação:** frestas de 1,6 mm na tampa, sobre o ESP32, longe da pele.
- **BOOT/EN do ESP32:** ficam para dentro. Para gravar, o auto-reset do CP2102 basta. Se travar, abra a tampa.
- **GPS:** não há 18 mm livres para jumpers no perfil baixo. Use o conector de 4 vias passando pelo canal da parede ou solde os fios. A altura acima da fita é de 11,4 mm, com 1,2 mm de plástico sobre a antena.

## Estrutura

```
params.py        medidas, folgas, material (fonte única)
mockups.py       componentes simplificados + zonas livres
cadlib.py        dente de snap, serrilha, pino-guia
parts/           uma peça por arquivo (build() devolve peças, mockups, snaps)
verify.py        exporta, valida e renderiza (também roda com pytest)
render_lib.py    renderização offscreen (pyvista)
export/stl, export/step, renders/   gerados
```
