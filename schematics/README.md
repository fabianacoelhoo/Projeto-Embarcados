# Esquemático – nó principal

![Diagrama de ligações](diagrama-ligacoes.png)

Diagrama de ligações do **ESP32 DevKit de 38 pinos**, gerado por [`gerar_diagrama.py`](gerar_diagrama.py), que lê os `#define PIN_*` de [`esp32-esp8266/no-principal/include/config.h`](../esp32-esp8266/no-principal/include/config.h). Mostra apenas o que está configurado no firmware atual (1.9).

- `diagrama-ligacoes.svg`: vetorial, para editar ou ampliar
- `diagrama-ligacoes.png`: imagem para relatórios
- Para gerar de novo depois de mudar um pino: `python schematics/gerar_diagrama.py` e `rsvg-convert -w 1760 schematics/diagrama-ligacoes.svg -o schematics/diagrama-ligacoes.png`

## Placa

Confirmada com `esptool.py flash_id` em 26/11/2026:

| Item | Valor |
|---|---|
| Placa | ESP32 DevKit de **38 pinos** (19 de cada lado), USB-C, botões BOOT e EN |
| Chip | **ESP32-D0WD-V3**, revisão v3.1, dual core 240 MHz, Wi-Fi + Bluetooth |
| Módulo | ESP32-WROOM-32E (o D0WD-V3 é o chip dessa linha; confira a serigrafia do módulo de metal) |
| Flash | **4 MB** (fabricante 0x68, Boya), alimentada em 3,3 V |
| Cristal | 40 MHz |
| USB-serial | CP2102 (driver Silicon Labs no Windows) |
| PlatformIO | `board = esp32dev` (genérica, serve para essa placa) |

Pinos que **não** podem ser usados: GPIO 6 a 11 (ligados à flash). GPIO 12 deve ficar livre ou em LOW no boot (ele define a tensão da flash). GPIO 0, 2, 5 e 15 também participam do boot, então só use com cuidado. Livres e seguros para o futuro: GPIO 32 e GPIO 34 (só entrada, no ADC1; reservado para medir a bateria).

## Montagem na protoboard

![Montagem física](../docs/img/montagem-protoboard.jpg)

## Tabela de pinos

| Componente | Pino do componente | ESP32 | Observação |
|---|---|---|---|
| HC-SR04 esquerdo | VCC / GND | VIN (5 V) / GND | |
| | TRIG | GPIO 18 | |
| | ECHO | GPIO 19 | divisor: ECHO → 1 kΩ → GPIO 19 → 2 kΩ → GND (5 V → 3,3 V) |
| HC-SR04 direito | VCC / GND | VIN (5 V) / GND | |
| | TRIG | GPIO 25 | |
| | ECHO | GPIO 33 | divisor 1 kΩ / 2 kΩ igual ao esquerdo |
| Potenciômetro WH148 (10 kΩ, rosca M7) | extremos / cursor | 3V3 e GND / GPIO 35 | entrada só-ADC; limiar de detecção 20–200 cm |
| Push-button 6×6 mm | um lado / outro | GPIO 4 / GND | pull-up interno, interrupção na borda de descida |
| LED RGB 5 mm (catodo comum) | R / G / B | GPIO 21 / 22 / 23 | 220–330 Ω em cada cor; comum no GND |
| Atuador esquerdo | + (buzzer) ou IN (MV50) / – | GPIO 13 / GND | PWM LEDC canal 0: buzzer 2 kHz ou motor 20 kHz |
| Atuador direito | + (buzzer) ou IN (MV50) / – | GPIO 14 / GND | PWM LEDC canal 2: buzzer 2 kHz ou motor 20 kHz |
| GPS NEO-6M (GY-GPS6MV2) | VCC / GND | 3V3 / GND | |
| | TX | GPIO 16 (RX2) | UART2 a 9600 baud |
| | RX | GPIO 17 (TX2) | opcional (só para configurar o módulo) |
| MPU-6050 (GY-521) | VCC / GND | 3V3 / GND | |
| | SDA / SCL | GPIO 26 / GPIO 27 | I²C a 400 kHz; os pinos padrão 21/22 estão com o LED RGB |
| | AD0 | GND | endereço 0x68 |

Todos os GND estão ligados ao mesmo terra. GPIO 34 fica reservado para medir a bateria (divisor ainda não montado) e GPIO 32 está livre.

### Atuadores: buzzer hoje, MV50 pronto no firmware

Os dois atuadores usam os mesmos pinos (GPIO 13 esquerdo, GPIO 14 direito) e a mesma linguagem háptica (`include/haptic_engine.h`, 7 padrões). O que muda é só a frequência do PWM:

| | Buzzer passivo (montado hoje) | Módulo de vibração MV50 (2×, previsto) |
|---|---|---|
| Ligação | + no GPIO, – no GND | IN no GPIO, VCC no 5V, GND no GND (o módulo já tem o transistor e o diodo) |
| PWM | 2 kHz, volume pelo duty | 20 kHz (inaudível), intensidade pelo duty |
| Seleção | padrão de fábrica (`ACTUATOR_MODE` em `config.h`) | `atuador motor` na Serial ou `{"cmd":"actuator","mode":"motor"}` (fica salvo na NVS) |

Na mecânica 3D ([`hardware/cad`](../hardware/cad/)), cada MV50 fica na metade interna do suporte "farol", encostado no peito, do mesmo lado do seu HC-SR04.
