#pragma once

/*=====================================================*/
/* EchoMap - No Principal (bancada)                    */
/* Configuracao de pinos, rede e calibracao             */
/*=====================================================*/

/* ----- Rede / MQTT (codigo em src/net.cpp) -----
 * O Wi-Fi e configurado pelo proprio EchoMap: sem rede salva (ou segurando o botao ao ligar),
 * a placa abre a rede "EchoMap-XXXX" e uma pagina de configuracao (192.168.4.1). O que for salvo
 * ali fica na flash e vale mais que o secrets.h, que so serve de padrao na gravacao.
 * Sem rede, a placa continua funcionando e mandando tudo pela Serial. */
#define ENABLE_MQTT 1   /* 1 = Wi-Fi + MQTT com o dashboard */

#if __has_include("secrets.h")
#include "secrets.h"
#endif
#ifndef WIFI_SSID
#define WIFI_SSID "SUA_REDE_WIFI"
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD "SUA_SENHA_WIFI"
#endif
#ifndef MQTT_BROKER_IP
#define MQTT_BROKER_IP "auto" /* "auto" = acha o PC do dashboard sozinho; ou um IP fixo (se ele parar de responder e o painel se anunciar em outro IP, a placa passa para "auto" sozinha) */
#endif

#define FW_VERSION "1.4.0"
#define DEVICE_ID "node1" /* ID padrao no painel (pode ser trocado no portal) */
#define MQTT_BROKER_PORT 1883
#define MQTT_TOPIC_PREFIX "echomap" /* topicos: echomap/<id>/telemetry, events, location, imu, status, pong, cmd */

/* latencia: modem-sleep desligado (+~80 mA, respostas em poucos ms em vez de 100-300 ms) */
#define NET_LOW_LATENCY 1
#define COMMS_TICK_MS 20             /* a TaskComms atende rede/comandos a cada 20 ms (eventos saem na hora) */
#define NET_DISCOVERY_PORT 47801     /* porta UDP do anuncio do dashboard (descoberta automatica) */

/* portal de configuracao */
#define PORTAL_PASSWORD "echomap123"     /* senha da rede EchoMap-<id> (minimo 8 caracteres; o painel mostra) */
#define PORTAL_TIMEOUT_MS 300000         /* fecha sozinho apos 5 min sem uso (se ja houver rede salva) */
#define NET_PORTAL_AFTER_FAIL_MS 15000   /* Wi-Fi sem conectar por 15 s: abre o portal sozinho (a Serial segue ativa) */
#define PORTAL_BUTTON_HOLD_MS 2000       /* segurar o botao ao ligar por 2 s tambem abre o portal */
#define TRIPLE_CLICK_MS 1500             /* 3 cliques dentro desse tempo abrem o portal */
#define NET_TEST_TIMEOUT_MS 20000        /* rede nova: tempo maximo do teste antes de voltar para a anterior */
#define LOCATE_MS 4000                   /* "tocar buzzer" pelo painel: duracao do bipe */

/* reconexao sem travar as tasks: tentativas espacadas e conexao TCP com tempo limite */
#define WIFI_RETRY_MS 10000
#define MQTT_RETRY_MS 5000
#define MQTT_CONNECT_TIMEOUT_MS 800
#define MQTT_SOCKET_TIMEOUT_S 2  /* espera pelo CONNACK (padrao da biblioteca: 15 s) */
#define MQTT_KEEPALIVE_S 10
#define PENDING_EVENTS_MAX 8     /* eventos guardados enquanto o broker esta fora e reenviados depois */
#define NET_STATUS_PERIOD_MS 5000 /* publica RSSI e versao do firmware em .../status */

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
#define MPU_ADDR 0x68            /* AD0 no GND; com AD0 em 3V3 vira 0x69 (o firmware testa os dois sozinho) */
#define IMU_PERIOD_MS 5          /* 200 amostras/s: uma pancada dura poucos ms, a 100 Hz o pico se perdia */
#define MPU_DLPF_CFG 0x01        /* filtro interno ~184 Hz (antes 44 Hz, que achatava o pico do impacto) */
#define MPU_SMPLRT_DIV (IMU_PERIOD_MS - 1) /* 1 kHz / (1 + div) = 1000 / IMU_PERIOD_MS amostras/s */
#define IMU_DEBUG 0              /* 1 = imprime a aceleracao 2x/s na Serial, para calibrar os limiares */
#define IMU_CALIBRATION_MS 1000  /* no boot: dispositivo parado para medir o offset do giroscopio e a posicao de referencia */

/* Deteccao (valores em g = modulo da aceleracao, normalizado pela gravidade medida no boot; parado = 1 g)
 * QUEDA:   queda livre (abaixo de FREEFALL_G por FREEFALL_MIN_MS) seguida de impacto >= FALL_IMPACT_G
 *          em ate FALL_WINDOW_MS, E, FALL_CONFIRM_MS depois, inclinacao media >= FALL_TILT_DEG
 *          (caiu e ficou deitado/inclinado). Pulo, corrida e degrau tambem tem queda livre + impacto,
 *          mas a pessoa continua de pe: viram "pulo" no log e nao geram alerta.
 * IMPACTO: pancada >= IMPACT_G sem queda livre antes (ex.: a crianca bateu em algo), ou queda nao
 *          confirmada com pancada >= HARD_IMPACT_G (bateu em algo correndo).
 * IMPACT_G igual ao thresholds.impactG do config.json do dashboard. */
#define FREEFALL_G 0.5f
#define FREEFALL_MIN_MS 60
#define FALL_WINDOW_MS 1000
#define FALL_IMPACT_G 2.0f
#define IMPACT_G 3.0f
#define IMU_PEAK_WINDOW_MS 100   /* depois de passar do limiar, espera o pico do impacto antes de avisar */
#define IMU_EVENT_COOLDOWN_MS 3000 /* evita varios eventos para a mesma pancada */
#define FALL_CONFIRM_MS 2000     /* espera depois do impacto para olhar a postura */
#define FALL_TILT_DEG 45.0f      /* inclinacao que confirma a queda (preso no tronco/cinto). 0 = desliga a confirmacao
                                    (use 0 se o modulo ficar no pulso, onde a inclinacao muda o tempo todo) */
#define HARD_IMPACT_G 5.0f       /* queda nao confirmada com pancada >= isso ainda gera IMPACT */
#define TILT_FILTER_ALPHA 0.05f  /* filtro da inclinacao (0..1, menor = mais suave; ~0,1 s a 200 Hz) */

/* ----- Calibracao / limiares ----- */
#define DIST_MIN_CM 20.0f
#define DIST_MAX_CM 200.0f
#define NEAR_MISS_CM 50.0f /* alguem passou a menos de meio metro (vai na telemetria: o painel usa o mesmo valor) */
#define NEAR_MISS_HYST_CM 10.0f /* so rearma o NEAR_MISS depois de passar de NEAR_MISS_CM + HYST */
#define NEAR_MISS_CONFIRM_SAMPLES 2   /* leituras seguidas perto antes de alertar (filtra eco espurio) */
#define NEAR_MISS_COOLDOWN_MS 10000   /* intervalo minimo entre dois alertas do mesmo lado */
#define SENSOR_DROPOUT_HOLD 3   /* leituras perdidas seguidas antes de considerar "nada no alcance" */

/* ----- Periodos das tasks (ms) ----- */
#define SENSOR_PERIOD_MS 60
#define SENSOR_GAP_MS 30 /* intervalo entre os pings L/R para o eco de um nao chegar no outro */
#define STATUS_PERIOD_MS 20
#define TELEMETRY_PERIOD_MS 200
#define CRASH_FLASH_MS 300
