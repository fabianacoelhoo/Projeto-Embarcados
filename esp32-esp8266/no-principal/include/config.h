#pragma once

/*=====================================================*/
/* EchoMap - No Principal (bancada)                    */
/* Configuracao de pinos, rede e calibracao             */
/*=====================================================*/

/* ----- Rede / MQTT ----- */
#define ENABLE_MQTT 0   /* 1 = conecta Wi-Fi e publica no broker Mosquitto */

#define WIFI_SSID "SUA_REDE_WIFI"
#define WIFI_PASSWORD "SUA_SENHA_WIFI"

#define MQTT_BROKER_IP "192.168.1.100"
#define MQTT_BROKER_PORT 1883
#define MQTT_TOPIC_TELEMETRY "echomap/node1/telemetry"
#define MQTT_TOPIC_EVENTS "echomap/node1/events"
#define MQTT_TOPIC_LOCATION "echomap/node1/location"
#define MQTT_TOPIC_IMU "echomap/node1/imu"

/* ----- HC-SR04 esquerdo (sensor original) ----- */
#define PIN_TRIG_L 18
#define PIN_ECHO_L 19 /* via divisor de tensao: ECHO -> 1k -> GPIO19 -> 2k -> GND */

/* ----- HC-SR04 direito (novo sensor) ----- */
#define PIN_TRIG_R 25
#define PIN_ECHO_R 33 /* via divisor de tensao: ECHO -> 1k -> GPIO33 -> 2k -> GND */

/* ----- Potenciometro (calibracao) ----- */
#define PIN_POT 35

/* ----- Botao (troca de modo / CRASH manual) ----- */
#define PIN_BUTTON 4
#define BUTTON_DEBOUNCE_MS 50
#define BUTTON_LONGPRESS_MS 1500

/* ----- LED RGB (status) ----- */
#define PIN_RGB_R 21
#define PIN_RGB_G 22
#define PIN_RGB_B 23
#define RGB_COMMON_ANODE 0 /* 1 = comum no 3V3 (anodo comum) */

/* ----- Buzzers passivos (1 por sensor ultrassonico) -----
 * Canais LEDC dedicados (nao usar tone()/noTone(): nesse core elas
 * compartilham um unico canal global e um buzzer rouba o som do outro). */
#define PIN_BUZZER_L 13
#define PIN_BUZZER_R 14
#define BUZZER_CHANNEL_L 0
#define BUZZER_CHANNEL_R 2
#define BUZZER_FREQ_HZ 2000 /* tom fixo; o que varia com a distancia e o volume */

/* Distancias pensadas para pessoas andando na rua: alguem passando a ~1,2 m ja
 * entra no alcance (volume baixo) e o volume sobe ate o maximo a 30 cm. */
#define BUZZER_START_CM 120.0f  /* comeca a apitar, no volume minimo */
#define BUZZER_FULL_CM 30.0f    /* daqui para perto: volume maximo */
#define BUZZER_MIN_VOLUME 0.15f /* volume (0..1) logo ao entrar no alcance */
#define BUZZER_HYST_CM 10.0f    /* so desliga ao passar de START + HYST (evita liga/desliga na borda) */
#define BUZZER_CONFIRM_SAMPLES 2 /* leituras seguidas para ligar/desligar (filtra eco espurio) */

/* ----- GPS u-blox NEO-6M (GY-NEO6MV2) na UART2 -----
 * TX do GPS -> GPIO16 (RX2 da ESP32) · RX do GPS -> GPIO17 (TX2) · VCC 3V3 · GND.
 * O modulo manda sentencas NMEA a 9600 baud; o fix pode levar alguns minutos
 * no primeiro uso e precisa de ceu aberto (dentro de casa costuma nao pegar). */
#define ENABLE_GPS 1
#define PIN_GPS_RX 16 /* recebe o TX do GPS */
#define PIN_GPS_TX 17 /* vai no RX do GPS (opcional: so para configurar o modulo) */
#define GPS_BAUD 9600
#define GPS_MAX_AGE_MS 3000     /* posicao mais velha que isso nao e publicada */
#define GPS_UERE_M 5.0f         /* erro tipico por unidade de HDOP, para estimar a precisao em metros */
#define LOCATION_PERIOD_MS 1000 /* o NEO-6M atualiza a posicao 1x por segundo */
#define GPS_STATUS_LOG_MS 5000  /* sem fix: imprime o status do GPS na Serial a cada 5 s */

/* ----- Acelerometro/giroscopio MPU-6050 (GY-521) no I2C -----
 * Os pinos I2C padrao (21/22) ja estao com o LED RGB, por isso o barramento
 * usa 26 (SDA) e 27 (SCL). VCC 3V3 · GND · AD0 no GND (endereco 0x68). */
#define ENABLE_IMU 1
#define PIN_I2C_SDA 26
#define PIN_I2C_SCL 27
#define I2C_FREQ_HZ 400000
#define MPU_ADDR 0x68
#define IMU_PERIOD_MS 10         /* 100 amostras/s: rapido o bastante para pegar o pico de um impacto */
#define IMU_CALIBRATION_MS 1000  /* no boot: dispositivo parado para medir o offset do giroscopio e a posicao de referencia */

/* Deteccao (valores em g = modulo da aceleracao; parado vale ~1 g)
 * QUEDA:   queda livre (abaixo de FREEFALL_G por FREEFALL_MIN_MS) seguida de impacto >= FALL_IMPACT_G
 *          em ate FALL_WINDOW_MS.
 * IMPACTO: pancada >= IMPACT_G sem queda livre antes (ex.: a crianca bateu em algo).
 * IMPACT_G igual ao thresholds.impactG do config.json do dashboard. */
#define FREEFALL_G 0.5f
#define FREEFALL_MIN_MS 60
#define FALL_WINDOW_MS 1000
#define FALL_IMPACT_G 2.0f
#define IMPACT_G 3.0f
#define IMU_PEAK_WINDOW_MS 100   /* depois de passar do limiar, espera o pico do impacto antes de avisar */
#define IMU_EVENT_COOLDOWN_MS 3000 /* evita varios eventos para a mesma pancada */
#define TILT_FILTER_ALPHA 0.1f   /* filtro da inclinacao (0..1, menor = mais suave) */

/* ----- Calibracao / limiares ----- */
#define DIST_MIN_CM 20.0f
#define DIST_MAX_CM 200.0f
#define NEAR_MISS_CM 50.0f /* alguem passou a menos de meio metro */

/* ----- Periodos das tasks (ms) ----- */
#define SENSOR_PERIOD_MS 60
#define SENSOR_GAP_MS 30 /* intervalo entre os pings L/R para o eco de um nao chegar no outro */
#define STATUS_PERIOD_MS 20
#define TELEMETRY_PERIOD_MS 200
#define CRASH_FLASH_MS 300
