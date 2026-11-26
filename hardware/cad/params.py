"""EchoMap - parametros de CAD (fonte unica de verdade). Todas as medidas em mm.

Cada componente traz `fonte`: "medido", "datasheet" ou "tipico - medir".
Ajuste o bloco Tolerancias depois de imprimir o cartao de tolerancia.
"""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Tolerancias:
    NOZZLE: float = 0.4
    WALL: float = 2.0            # parede estrutural (5 perimetros)
    WALL_THIN_GPS: float = 1.2   # tampa sobre a antena do GPS
    PCB_GAP: float = 0.40        # folga total de PCB em trilho/berco
    HOLE_GAP: float = 0.40       # folga no diametro de furos passantes
    SNAP_GAP: float = 0.28       # folga de pecas com snap-fit
    JUMPER_CLEARANCE: float = 18.0
    PIN_D: float = 2.65          # pino-guia para furo de PCB 3,0
    PIN_CHAMFER: float = 0.4
    FILLET_PELE: float = 1.5     # raio minimo nas arestas do lado do corpo
    data_calibracao: str = "nao calibrado - imprimir tolerance_test_card"


@dataclass(frozen=True)
class Material:
    nome: str = "PETG"
    densidade_g_cm3: float = 1.24   # pedido do projeto (PLA); PETG ~1,27
    limite_def: dict = field(default_factory=lambda: {"PLA": 0.015, "PETG": 0.025, "NYLON": 0.04})


@dataclass(frozen=True)
class Colete:
    STRAP_W: float = 60.0
    STRAP_T_MIN: float = 1.2
    STRAP_T_MAX: float = 2.8
    POCKET_MAX_W: float = 78.0
    POCKET_MAX_H: float = 160.0


@dataclass(frozen=True)
class Snap:
    """Gancho cantilever padrao (impresso no plano XY)."""
    L: float = 10.0        # comprimento livre
    t: float = 1.6         # espessura
    w: float = 5.0         # largura
    y: float = 0.6         # interferencia (altura do dente)
    raio_raiz: float = 0.8
    ang_entrada: float = 30.0
    ang_retencao: float = 80.0


@dataclass(frozen=True)
class ESP32:
    fonte: str = "tipico - medir (clones 51,5 a 55,0)"
    L: float = 55.0
    L_MAX: float = 55.5     # batente aceita ate 55,5 (calco opcional para placas menores)
    W: float = 28.5
    PCB_T: float = 1.6
    COMP_TOP: float = 3.5   # modulo WROOM + componentes por cima
    PIN_H: float = 8.5      # headers macho por baixo
    USB_CUT_W: float = 10.0
    USB_CUT_H: float = 4.5
    USB_WIN_W: float = 14.0
    USB_WIN_H: float = 8.0
    USB_KEEPOUT: float = 25.0


@dataclass(frozen=True)
class MPU6050:
    fonte: str = "tipico - medir"
    L: float = 21.0
    W: float = 16.0
    PCB_T: float = 1.6
    HOLE_D: float = 3.0
    HOLE_PITCH: float = 15.24
    HOLE_EDGE: float = 2.5   # centro do furo ate a borda
    COMP_TOP: float = 1.5
    PIN_ROW_EDGE: float = 1.3
    PIN_H: float = 8.5       # pinos 90 graus retos (para cima)
    eixos: str = "X = frente da pessoa, Y = esquerda, Z = para cima (prateleira paralela ao chao)"


@dataclass(frozen=True)
class WH148:
    fonte: str = "datasheet"
    PANEL_HOLE: float = 7.4
    BODY_D: float = 17.5
    BODY_H: float = 11.0
    PIN_D: float = 2.8
    PIN_OFFSET: float = 7.8
    SHAFT_D: float = 6.0
    SHAFT_H: float = 15.0
    NUT_AF: float = 10.0


@dataclass(frozen=True)
class LED5:
    fonte: str = "datasheet"
    HOLE: float = 5.4
    BODY_D: float = 5.0
    BODY_H: float = 8.6
    FLANGE_D: float = 5.8
    COLLAR_H: float = 3.0
    LEG_OPEN: float = 6.0


@dataclass(frozen=True)
class Botao:
    fonte: str = "datasheet"
    BODY: float = 6.0
    BODY_H: float = 3.5
    STEM_D: float = 3.5
    BTN_H: float = 5.0
    KEY_D: float = 10.0
    HINGE_T: float = 0.8      # dobradica viva (TPU/PETG); 2 camadas de 0,4
    KEY_GAP: float = 0.3
    TRAVEL: float = 0.25


@dataclass(frozen=True)
class HCSR04:
    fonte: str = "tipico - medir"
    PCB_L: float = 45.5
    PCB_W: float = 20.5
    PCB_T: float = 1.6
    TR_D: float = 16.0
    TR_HOLE: float = 16.4
    TR_H: float = 12.0
    TR_PITCH: float = 26.0
    CRYSTAL_W: float = 11.0
    CRYSTAL_H: float = 4.5
    CRYSTAL_T: float = 3.6
    PIN_H: float = 8.5
    CONE_HALF_DEG: float = 15.0
    CONE_LEN: float = 60.0


@dataclass(frozen=True)
class MV50:
    fonte: str = "tipico - medir"
    PCB_L: float = 23.5
    PCB_W: float = 21.5
    H: float = 5.2
    PCB_T: float = 1.6
    HOLE_D: float = 3.0
    HOLE_PITCH: float = 16.0
    MOTOR_D: float = 10.0


@dataclass(frozen=True)
class GPS:
    fonte: str = "tipico - medir"
    PCB_L: float = 36.0
    PCB_W: float = 26.0
    H: float = 5.0
    PCB_T: float = 1.6
    HOLE_D: float = 3.0
    HOLE_EDGE: float = 3.0
    ANT_L: float = 25.0
    ANT_W: float = 25.0
    ANT_H: float = 8.0
    LED_X: float = 10.0   # LED de fix, a partir do centro da PCB
    COAX_D: float = 1.4


@dataclass(frozen=True)
class Mount:
    BASE_W: float = 68.0
    CHANNEL_W: float = 61.0
    SERRATION: float = 0.6
    HEADLIGHT_TILT_DEG: float = 0.0   # 0 ou -8


@dataclass(frozen=True)
class Render:
    explode_mm: float = 25.0
    alpha_case: float = 0.45


TOL = Tolerancias()
MAT = Material()
VEST = Colete()
SNAP = Snap()
ESP = ESP32()
MPU = MPU6050()
POT = WH148()
LED = LED5()
BTN = Botao()
HC = HCSR04()
MV = MV50()
GPSM = GPS()
MNT = Mount()
RND = Render()
