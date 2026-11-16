# Esquemático – nó principal

![Diagrama de ligações](diagrama-ligacoes.png)

Diagrama de ligações gerado a partir de [`esp32-esp8266/no-principal/include/config.h`](../esp32-esp8266/no-principal/include/config.h). Mostra apenas o que está configurado no firmware atual.

- `diagrama-ligacoes.svg`: vetorial, para editar ou ampliar
- `diagrama-ligacoes.png`: imagem para relatórios

## Tabela de pinos

| Componente | Pino do componente | ESP32 | Observação |
|---|---|---|---|
| HC-SR04 esquerdo | VCC / GND | VIN (5 V) / GND | |
| | TRIG | GPIO 18 | |
| | ECHO | GPIO 19 | divisor: ECHO → 1 kΩ → GPIO 19 → 2 kΩ → GND (5 V → 3,3 V) |
| HC-SR04 direito | VCC / GND | VIN (5 V) / GND | |
| | TRIG | GPIO 25 | |
| | ECHO | GPIO 33 | divisor 1 kΩ / 2 kΩ igual ao esquerdo |
| Potenciômetro | extremos / cursor | 3V3 e GND / GPIO 35 | entrada só-ADC |
| Botão | um lado / outro | GPIO 4 / GND | pull-up interno, interrupção na borda de descida |
| LED RGB (catodo comum) | R / G / B | GPIO 21 / 22 / 23 | 220–330 Ω em cada cor; comum no GND |
| Buzzer passivo esquerdo | + / – | GPIO 13 / GND | PWM (LEDC canal 0, 2 kHz) |
| Buzzer passivo direito | + / – | GPIO 14 / GND | PWM (LEDC canal 2, 2 kHz) |

Todos os GND estão ligados ao mesmo terra. A ligação dos buzzers aparece de forma simplificada no diagrama.

O GPS NEO-6M e o MPU-6050 ainda não estão no circuito: os pinos deles serão definidos na próxima etapa. Os pinos 21/22, que são o I²C padrão da ESP32, já estão ocupados pelo LED RGB.
