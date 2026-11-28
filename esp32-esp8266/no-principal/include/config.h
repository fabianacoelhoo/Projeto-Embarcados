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

#define FW_VERSION "2.0.0"
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
/* 3 cliques (cada um ate CLICK_GAP_MS depois do anterior) abrem o portal: ver "Gestos do botao" */
#define NET_TEST_TIMEOUT_MS 20000        /* rede nova: tempo maximo do teste antes de voltar para a anterior */
#define LOCATE_MS 4000                   /* "localizar" pelo painel: duracao da vibracao forte e alternada */

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

/* ----- Motores de vibracao: 2x modulo MV50 (1 por sensor ultrassonico) -----
 * IN do modulo no GPIO; VCC no 5V; GND no GND. O MV50 ja tem o transistor e o diodo do motor,
 * entao o GPIO so manda o PWM (3,3 V, poucos mA). Cada lado tem um canal LEDC proprio.
 * A linguagem haptica (include/haptic_engine.h) decide O QUE vibrar; aqui fica COMO. */
#define PIN_MOTOR_L 13
#define PIN_MOTOR_R 14
#define MOTOR_CHANNEL_L 0
#define MOTOR_CHANNEL_R 2
#define MOTOR_PWM_HZ 20000   /* acima do audivel: o motor nao chia */
#define MOTOR_PWM_BITS 10
#define MOTOR_MIN_DUTY 0.35f /* abaixo disso o motor nao gira: intensidade 0..1 vira 35..100% (0 = parado) */
#define HAPTIC_PERIOD_MS 10         /* passo do sequenciador (TaskHaptic) */
#define HEARTBEAT_PERIOD_MS 600000UL /* batimento a cada 10 min, so com Wi-Fi e servidor conectados */
#define CFG_NAMESPACE "echomap_cfg" /* NVS das configuracoes do usuario (calibracao) */

/* Distancias pensadas para pessoas andando na rua: alguem passando a ~1,2 m ja
 * entra no alcance (vibracao fraca) e a intensidade sobe ate o maximo a 30 cm. */
#define ALERT_START_CM 120.0f  /* comeca a vibrar, na intensidade minima */
#define ALERT_FULL_CM 30.0f    /* daqui para perto: intensidade maxima */
#define ALERT_HYST_CM 10.0f    /* so desliga ao passar de START + HYST (evita liga/desliga na borda) */
#define ALERT_CONFIRM_SAMPLES 2 /* leituras seguidas para ligar/desligar (filtra eco espurio) */

/* ----- GPS u-blox NEO-6M (GY-GPS6MV2) na UART2 -----
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
/* ----- Quase colisao por tempo ate o impacto (TTC, include/ttc_detector.h) -----
 * Ocorrencia NEAR_MISS so quando e critico: TTC <= TTC_CRITICAL_S a ate TTC_MAX_DIST_CM, ou
 * leitura <= TTC_CLOSE_CM em TTC_CLOSE_SAMPLES leituras seguidas. Parede ou pessoa parada ao lado
 * (sem aproximacao) so gera o aviso local: o padrao haptico "obstaculo parado" (pulso curto e suave). */
#define TTC_V_MIN_CM_S 15.0f      /* abaixo disso o obstaculo esta parado */
#define TTC_CRITICAL_S 1.5f       /* tempo ate o impacto que vira alerta */
#define TTC_MAX_DIST_CM 150.0f    /* o TTC so vale ate essa distancia */
#define TTC_CLOSE_CM 25.0f        /* perto demais, mesmo parado */
#define TTC_CLOSE_SAMPLES 3       /* leituras validas seguidas <= TTC_CLOSE_CM */
#define TTC_STATIC_MAX_CM 120.0f  /* faixa do aviso local para obstaculo parado */
#define TTC_COOLDOWN_MS 3000      /* intervalo minimo entre duas ocorrencias do mesmo lado */
#define TTC_CONFIRM_SAMPLES 2     /* leituras seguidas com TTC critico (filtra ruido) */
#define TTC_MAX_GAP_MS 500        /* amostra mais velha que isso nao entra no calculo da velocidade */
#define TTC_DROPOUT_RESET 3       /* falhas seguidas que zeram a janela (obstaculo sumiu) */
#define NEAR_MISS_CM TTC_CLOSE_CM /* vai na telemetria ("near"): o painel desenha a faixa critica com o mesmo valor */

/* ----- Pre-alerta "Estou bem" (include/alert_fsm.h) -----
 * Queda ou batida confirmada abre PRE_ALERT_MS de aviso local (LED ambar + bipes que aceleram).
 * 1 clique curto no botao cancela (vai ao painel como DISMISSED, gravidade info);
 * sem clique, o alerta vai normalmente. */
#define PRE_ALERT_MS 5000

/* ----- Economia de energia guiada pelo MPU (include/power_manager.h) -----
 * Parado por POWER_IDLE_AFTER_MS: ultrassonicos a 1 Hz (SENSOR_IDLE_PERIOD_MS) e Wi-Fi em modem-sleep
 * (o MQTT continua conectado). Qualquer movimento, giro ou clique volta tudo na hora. */
#define POWER_IDLE_AFTER_MS 120000UL
#define POWER_MOTION_G 0.06f        /* |g - 1| acima disso e movimento */
#define POWER_MOTION_STD_G 0.03f    /* desvio padrao recente de g acima disso e movimento (balanco continuo) */
#define POWER_MOTION_GYRO_DPS 12.0f /* giro acima disso e movimento */
#define POWER_VAR_ALPHA 0.02f       /* media movel do desvio padrao (~250 ms a 200 Hz) */
#define SENSOR_IDLE_PERIOD_MS 1000  /* periodo dos ultrassonicos em economia */

/* ----- Calibracao assistida (include/calibration.h) -----
 * "Iniciar calibracao" no painel, {"cmd":"calibrate_start","duration_s":30} ou "calibrar" na Serial:
 * a pessoa anda em linha reta num corredor livre. No fim:
 *   limiar de batida = max(CAL_MIN_IMPACT_G, maior pico de passo x CAL_IMPACT_FACTOR), ate CAL_MAX_IMPACT_G
 *   histerese dos ultrassonicos = CAL_HYST_K x ruido do eco, entre CAL_HYST_MIN_CM e CAL_HYST_MAX_CM
 * Aplicado na hora e salvo na NVS (CFG_NAMESPACE); "calibrar padrao" volta para IMPACT_G e ALERT_HYST_CM. */
#define CAL_DEFAULT_DURATION_S 30
#define CAL_MIN_DURATION_S 10
#define CAL_MAX_DURATION_S 120
#define CAL_STEP_MIN_G 1.15f        /* pico acima disso conta como passo */
#define CAL_STEP_REFRACTORY_MS 250  /* dois passos nunca ficam mais perto que isso */
#define CAL_IMPACT_FACTOR 1.6f
#define CAL_MIN_IMPACT_G 2.5f       /* acima de FALL_IMPACT_G (2 g) */
#define CAL_MAX_IMPACT_G 4.5f       /* abaixo de HARD_IMPACT_G (5 g): correr na calibracao nao esconde batidas */
#define CAL_HYST_K 3.0f
#define CAL_HYST_MIN_CM 5.0f
#define CAL_HYST_MAX_CM 30.0f
#define CAL_MIN_STEPS 10            /* menos passos: calibracao invalida, nada muda */
#define CAL_MIN_ECHO_SAMPLES 20     /* menos leituras seguidas validas num lado: lado ignorado */
#define CAL_MAX_ECHO_JUMP_CM 20.0f  /* salto maior entre leituras e outro objeto, nao ruido */
#define CAL_PROGRESS_MS 1000        /* progresso para o painel a cada 1 s */

/* ----- Gestos do botao (include/click_classifier.h) -----
 * 1 clique = troca o modo (depois de CLICK_GAP_MS sem outro clique) | 2 cliques = ancora rapida
 * 3 cliques = portal de Wi-Fi | clique longo = SOS (CRASH) | no pre-alerta, 1 clique = "Estou bem" (na hora) */
#define CLICK_GAP_MS 450

/* ----- Assinatura de Wi-Fi quando o GPS nao pega (include/wifi_fingerprint.h) -----
 * GPS sem posicao (ou com menos de WIFI_FP_MIN_SATS satelites) ha WIFI_FP_GPS_LOST_MS: varredura passiva e
 * assincrona a cada WIFI_FP_EVERY_MS (a conexao MQTT continua), e as WIFI_FP_TOP redes mais fortes vao ao
 * servidor, que reconhece locais cadastrados ("Casa", "CESAR School"). */
#define WIFI_FP_GPS_LOST_MS 15000
#define WIFI_FP_EVERY_MS 30000
#define WIFI_FP_MIN_SATS 3
#define WIFI_FP_TOP 3
#define WIFI_FP_SCAN_MS_PER_CHAN 120 /* varredura passiva: tempo em cada canal */
#define WIFI_FP_SCAN_TIMEOUT_MS 8000
#define SENSOR_DROPOUT_HOLD 3   /* leituras perdidas seguidas antes de considerar "nada no alcance" */

/* ----- Periodos das tasks (ms) ----- */
#define SENSOR_PERIOD_MS 60
#define SENSOR_GAP_MS 30 /* intervalo entre os pings L/R para o eco de um nao chegar no outro */
#define STATUS_PERIOD_MS 20
#define TELEMETRY_PERIOD_MS 200
#define CRASH_FLASH_MS 300
