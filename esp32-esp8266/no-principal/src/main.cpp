/*=====================================================*/
/* EchoMap - No Principal (prototipo de bancada)         */
/* ESP32 + FreeRTOS                                      */
/* 2x HC-SR04 + potenciometro + botao + LED RGB + 2 motores de vibracao (MV50) */
/* + GPS NEO-6M (UART2) + MPU-6050 (I2C)                    */
/*=====================================================*/

#include <Arduino.h>
#include <math.h>
#include "config.h"
#include "imu_detector.h"
#include "ttc_detector.h" /* quase colisao por tempo ate o impacto */
#include "alert_fsm.h"    /* pre-alerta "Estou bem" de queda/batida */
#include "power_manager.h" /* economia de energia guiada pelo MPU */
#include "haptic_engine.h" /* linguagem haptica: padroes -> motores de vibracao */
#include "calibration.h"   /* calibracao assistida (30 s andando) */
#include "click_classifier.h" /* 1, 2 e 3 cliques */
#include "wifi_fingerprint.h" /* assinatura de Wi-Fi quando o GPS nao pega */
#include <Preferences.h>   /* NVS: configuracoes do usuario (namespace echomap_cfg) */

#if ENABLE_GPS
#include <TinyGPS++.h>
#endif

#if ENABLE_IMU
#include <Wire.h>
#endif

#include "net.h" /* Wi-Fi, MQTT, portal de configuracao e descoberta do servidor */

/*=====================================================*/
/* Tipos                                                 */
/*=====================================================*/
enum Mode { MODE_RADAR = 0, MODE_SELFTEST = 1, MODE_COUNT = 2 };
enum EventType { EVT_NEAR_MISS, EVT_CRASH, EVT_FALL, EVT_IMPACT, EVT_DISMISSED, EVT_ANCHOR };

struct SideState {
  float rawCm = -1;
  float filteredCm = -1;
  bool inRange = false; /* alguem confirmado dentro de ALERT_START_CM */
  uint8_t nearHits = 0;
  uint8_t farHits = 0;
  uint8_t misses = 0;   /* leituras perdidas seguidas */
  TtcLevel level = TtcLevel::Clear; /* do detector de TTC: estatico limita a intensidade da vibracao */
};

struct SensorState {
  SideState left;
  SideState right;
  float potNormalized = 0;
};

struct AppState {
  Mode mode = MODE_RADAR;
  float lastThr = DIST_MIN_CM;
  float vibL = 0; /* intensidade atual de cada motor (0..1), so para telemetria */
  float vibR = 0;
};

/* sem valor padrao nos campos: no C++11 do core isso impediria o AppEvent{...}.
   Use makeEvent() para os casos simples. */
struct AppEvent {
  EventType type;
  float value;    /* cm para NEAR_MISS, g para FALL/IMPACT/DISMISSED */
  uint32_t t;
  char side;      /* 'L'/'R' para NEAR_MISS, '-' quando nao se aplica */
  float tilt;     /* inclinacao (graus) que confirmou a queda; -1 quando nao se aplica */
  float ttc;      /* NEAR_MISS: tempo ate o impacto (s); -1 quando foi por "perto demais" */
  float vel;      /* NEAR_MISS: velocidade de aproximacao (cm/s) */
  uint8_t cause;  /* DISMISSED: AlertCause do alerta cancelado; NEAR_MISS: TtcReason; ANCHOR: 1 = tem posicao */
  float lat;      /* ANCHOR: posicao do GPS no momento dos 2 cliques */
  float lon;
};

AppEvent makeEvent(EventType type, float value, char side) {
  AppEvent e{type, value, (uint32_t)millis(), side, -1.0f, -1.0f, 0.0f, 0, 0.0f, 0.0f};
  return e;
}

struct GpsState {
  bool hasFix = false;     /* posicao valida e recente */
  double lat = 0;
  double lon = 0;
  float accuracyM = 0;     /* estimativa: HDOP x GPS_UERE_M */
  float hdop = 0;
  float speedMps = 0;
  uint32_t sats = 0;
  uint32_t fixAtMs = 0;    /* millis() da ultima posicao valida */
  uint32_t charsRx = 0;    /* bytes recebidos do modulo (0 = fiacao/baud errados) */
};

struct ImuState {
  bool ready = false;      /* MPU-6050 respondeu e foi calibrado */
  float ax = 0, ay = 0, az = 0; /* aceleracao em g */
  float gx = 0, gy = 0, gz = 0; /* giro em graus/s (sem offset) */
  float g = 1.0f;          /* modulo da aceleracao */
  float gMax = 0;          /* maior modulo desde a ultima publicacao */
  float tiltDeg = 0;       /* inclinacao em relacao a posicao de uso (equilibrio) */
};

/*=====================================================*/
/* Globais                                               */
/*=====================================================*/
SensorState sensorState;
AppState appState;
GpsState gpsState;
ImuState imuState;
SemaphoreHandle_t stateMutex;
QueueHandle_t eventQueue;
SemaphoreHandle_t buttonSemaphore;
volatile uint32_t crashFlashUntil = 0;

#if ENABLE_GPS
TinyGPSPlus gps;
#endif

/* pedidos para a TaskHaptic (de qualquer task): tocar ou parar um padrao */
struct HapticRequest {
  HapticPattern pattern;
  uint8_t sides;
  bool stop;
};
QueueHandle_t hapticQueue = NULL;

void haptic(HapticPattern p, uint8_t sides = HAPTIC_BOTH) {
  if (!hapticQueue) return;
  HapticRequest r{p, sides, false};
  xQueueSend(hapticQueue, &r, 0);
}
void hapticStop(HapticPattern p) {
  if (!hapticQueue) return;
  HapticRequest r{p, HAPTIC_BOTH, true};
  xQueueSend(hapticQueue, &r, 0);
}

/* limiares que a calibracao assistida ajusta (salvos na NVS, aplicados sem reiniciar) */
volatile float runtimeImpactG = IMPACT_G;     /* limiar de batida (ImuDetector) */
volatile float runtimeHystCm = ALERT_HYST_CM; /* histerese da faixa de aviso dos ultrassonicos */
static const CalibConfig CAL_CFG = {CAL_STEP_MIN_G,   CAL_STEP_REFRACTORY_MS, CAL_IMPACT_FACTOR, CAL_MIN_IMPACT_G,
                                    CAL_MAX_IMPACT_G, CAL_HYST_K,             CAL_HYST_MIN_CM,   CAL_HYST_MAX_CM,
                                    CAL_MIN_STEPS,    CAL_MIN_ECHO_SAMPLES,   CAL_MAX_ECHO_JUMP_CM};
Calibrator calibrator(CAL_CFG); /* sempre com stateMutex: TaskImu e TaskSensors alimentam, TaskComms comanda */
volatile bool calibrating = false;

/* economia de energia: decidida na TaskImu (PowerManager), aplicada aqui */
TaskHandle_t sensorTaskHandle = NULL;
volatile bool powerIdle = false;
volatile bool wakeRequested = false; /* botao: a TaskImu acorda na proxima amostra */

void applyPowerChange(PowerChange c) {
  if (c == PowerChange::None) return;
  bool idle = c == PowerChange::EnterIdle;
  powerIdle = idle;
  netSetPowerSave(idle); /* aplicado pela TaskComms no proximo netService() */
  if (!idle && sensorTaskHandle) xTaskNotifyGive(sensorTaskHandle); /* ultrassonicos voltam na hora */
  if (idle) {
    Serial.printf("[ENERGIA] Parado ha %lu s: economia (ultrassonicos a 1 Hz, Wi-Fi em modem-sleep).\n",
                  (unsigned long)(POWER_IDLE_AFTER_MS / 1000));
  } else {
    Serial.println("[ENERGIA] Movimento: modo ativo.");
  }
}
bool bootPortalRequested = false;    /* botao segurado ao ligar */
volatile bool sensorsPaused = false; /* teste de sensores em andamento: a leitura normal espera */
volatile bool diagRequested = false; /* "sensores" na Serial ou "Testar sensores" no painel */

/* pre-alerta "Estou bem": TaskImu dispara e avanca o tempo, TaskButton cancela (sempre com stateMutex) */
AlertFsm alertFsm(PRE_ALERT_MS);
volatile uint32_t preAlertSince = 0;     /* millis() do inicio do pre-alerta; 0 = nenhum */
volatile uint32_t confirmFeedbackUntil = 0; /* bip curto + LED verde: alerta cancelado */

/* resultado do pre-alerta vira evento: queda/batida confirmada, ou descartada pelo usuario */
void queueAlertOutcome(AlertAction action, const PendingAlert &p) {
  if (action == AlertAction::None) return;
  AppEvent e = makeEvent(EVT_DISMISSED, p.value, '-');
  e.t = p.t;
  e.tilt = p.tilt;
  e.cause = (uint8_t)p.cause;
  if (action == AlertAction::Confirm) e.type = p.cause == AlertCause::Fall ? EVT_FALL : EVT_IMPACT;
  if (e.type != EVT_FALL) e.tilt = -1.0f;
  xQueueSend(eventQueue, &e, 0);
  preAlertSince = 0;
  hapticStop(HapticPattern::PreAlert);
  if (action == AlertAction::Dismiss) haptic(HapticPattern::Confirm);
}

/*=====================================================*/
/* Botao - ISR                                           */
/*=====================================================*/
void IRAM_ATTR buttonISR() {
  BaseType_t xHigherPriorityTaskWoken = pdFALSE;
  xSemaphoreGiveFromISR(buttonSemaphore, &xHigherPriorityTaskWoken);
  portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
}

/*=====================================================*/
/* HC-SR04                                               */
/*=====================================================*/
float readDistanceCm(uint8_t trigPin, uint8_t echoPin) {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  unsigned long duration = pulseIn(echoPin, HIGH, 30000UL); /* timeout ~5 m */
  if (duration == 0) return -1.0f;

  float cm = duration * 0.0343f / 2.0f;
  if (cm < 2.0f || cm > 400.0f) return -1.0f;
  return cm;
}

/*=====================================================*/
/* Saida: RGB                                            */
/*=====================================================*/
void setRGB(float r, float g, float b) {
  if (RGB_COMMON_ANODE) {
    r = 1.0f - r;
    g = 1.0f - g;
    b = 1.0f - b;
  }
  analogWrite(PIN_RGB_R, constrain((int)(r * 255), 0, 255));
  analogWrite(PIN_RGB_G, constrain((int)(g * 255), 0, 255));
  analogWrite(PIN_RGB_B, constrain((int)(b * 255), 0, 255));
}

void bootFlash() {
  setRGB(1, 0, 0); delay(120);
  setRGB(0, 1, 0); delay(120);
  setRGB(0, 0, 1); delay(120);
  setRGB(1, 1, 1); delay(120);
  setRGB(0, 0, 0);
}

/*=====================================================*/
/* Logica de cada modo - define a cor do RGB             */
/*=====================================================*/
float closenessFor(float distCm, float thrCm) {
  if (distCm < 0 || distCm > thrCm) return 0.0f;
  return constrain((thrCm - distCm) / thrCm, 0.0f, 1.0f);
}

float pulseFor(float closeness, uint32_t now) {
  float freqHz = 0.5f + closeness * 4.5f;
  float phase = fmodf((now / 1000.0f) * freqHz, 1.0f);
  return (closeness >= 0.9f) ? closeness : closeness * (0.5f + 0.5f * sinf(phase * 2.0f * PI));
}

void computeRadar(const SensorState &s, float thrCm, uint32_t now, float &r, float &g, float &b) {
  float closenessL = closenessFor(s.left.filteredCm, thrCm);
  float closenessR = closenessFor(s.right.filteredCm, thrCm);
  float worst = max(closenessL, closenessR);

  /* verde -> amarelo -> vermelho conforme o lado mais critico se aproxima do limiar */
  if (worst < 0.5f) {
    float t = worst / 0.5f;
    r = t; g = 1.0f; b = 0.0f;
  } else {
    float t = (worst - 0.5f) / 0.5f;
    r = 1.0f; g = 1.0f - t; b = 0.0f;
  }

  /* pisca mais rapido/forte quanto mais perto; sem nada no alcance fica num brilho baixo e fixo */
  float pulse = (worst > 0.0f) ? pulseFor(worst, now) : 0.25f;
  r *= pulse; g *= pulse; b *= pulse;
}

void computeSelftest(uint32_t now, float &r, float &g, float &b) {
  int phase = (now / 600) % 4;
  switch (phase) {
    case 0: r = 1; g = 0; b = 0; break;
    case 1: r = 0; g = 1; b = 0; break;
    case 2: r = 0; g = 0; b = 1; break;
    default: r = 1; g = 1; b = 1; break;
  }
}

void computeCrashFlash(float &r, float &g, float &b) {
  r = 1.0f; g = 1.0f; b = 1.0f;
}

/*=====================================================*/
/* Task 1 - Sensores (2x HC-SR04, potenciometro)         */
/*=====================================================*/
void updateSide(SideState &side, float raw) {
  if (raw < 0) {
    /* eco perdido isolado e comum no HC-SR04: mantem o ultimo valor filtrado por algumas
       leituras em vez de "piscar" para nada detectado (no painel, na vibracao e no NEAR_MISS) */
    side.rawCm = -1;
    if (side.misses < SENSOR_DROPOUT_HOLD) side.misses++;
    if (side.misses >= SENSOR_DROPOUT_HOLD) side.filteredCm = -1;
  } else {
    side.misses = 0;
    side.rawCm = raw;
    side.filteredCm = (side.filteredCm < 0) ? raw : (side.filteredCm * 0.7f + raw * 0.3f);
  }

  /* liga/desliga da vibracao usa a leitura bruta (sem atraso do filtro), com histerese
     e confirmacao por leituras seguidas para ignorar ecos isolados */
  float limit = side.inRange ? (ALERT_START_CM + runtimeHystCm) : ALERT_START_CM;
  bool near = (raw >= 0 && raw <= limit);
  if (near) {
    side.farHits = 0;
    if (side.nearHits < ALERT_CONFIRM_SAMPLES) side.nearHits++;
    if (side.nearHits >= ALERT_CONFIRM_SAMPLES) side.inRange = true;
  } else {
    side.nearHits = 0;
    if (side.farHits < ALERT_CONFIRM_SAMPLES) side.farHits++;
    if (side.farHits >= ALERT_CONFIRM_SAMPLES) side.inRange = false;
  }
}

/* quase colisao por TTC (include/ttc_detector.h): cada lado tem o seu detector, com mediana,
   velocidade de aproximacao e cooldown proprios. So o critico vira ocorrencia NEAR_MISS. */
static const TtcConfig TTC_CFG = {TTC_V_MIN_CM_S, TTC_CRITICAL_S,      TTC_MAX_DIST_CM, TTC_CLOSE_CM,
                                  TTC_CLOSE_SAMPLES, TTC_STATIC_MAX_CM, TTC_COOLDOWN_MS, TTC_CONFIRM_SAMPLES,
                                  TTC_MAX_GAP_MS,  TTC_DROPOUT_RESET};

void reportNearMiss(const TtcResult &r, char side) {
  if (!r.report) return;
  AppEvent evt = makeEvent(EVT_NEAR_MISS, r.distCm, side);
  evt.ttc = r.reason == TtcReason::Ttc ? r.ttcS : -1.0f;
  evt.vel = r.velocityCmS;
  evt.cause = (uint8_t)r.reason;
  xQueueSend(eventQueue, &evt, 0);
  if (r.reason == TtcReason::Ttc) haptic(HapticPattern::FastApproach, side == 'L' ? HAPTIC_LEFT : HAPTIC_RIGHT);
}

void TaskSensors(void * /* pvParameters */) {
  TtcDetector ttcL(TTC_CFG), ttcR(TTC_CFG);

  for (;;) {
    if (sensorsPaused) {
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    /* leitura sequencial com intervalo para evitar eco cruzado entre os dois HC-SR04 */
    float rawL = readDistanceCm(PIN_TRIG_L, PIN_ECHO_L);
    uint32_t tL = millis();
    vTaskDelay(pdMS_TO_TICKS(SENSOR_GAP_MS));
    float rawR = readDistanceCm(PIN_TRIG_R, PIN_ECHO_R);
    uint32_t tR = millis();
    TtcResult resL = ttcL.update(rawL, tL);
    TtcResult resR = ttcR.update(rawR, tR);

    int potRaw = analogRead(PIN_POT);

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    updateSide(sensorState.left, rawL);
    updateSide(sensorState.right, rawR);
    calibrator.addEcho(0, rawL); /* so registra durante a calibracao */
    calibrator.addEcho(1, rawR);
    sensorState.left.level = resL.level;
    sensorState.right.level = resR.level;
    sensorState.potNormalized = potRaw / 4095.0f;
    xSemaphoreGive(stateMutex);

    reportNearMiss(resL, 'L');
    reportNearMiss(resR, 'R');

    /* em economia, 1 leitura por segundo; acordar (movimento ou botao) interrompe a espera na hora */
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(powerIdle ? SENSOR_IDLE_PERIOD_MS : SENSOR_PERIOD_MS));
  }
}

/*=====================================================*/
/* Task 2 - Botao (clique curto = modo, longo = CRASH)   */
/*=====================================================*/
/* 2 cliques: ancora rapida (zona segura dinamica) no ponto atual; o servidor liga ou desliga */
void requestQuickAnchor() {
  AppEvent evt = makeEvent(EVT_ANCHOR, 0, '-');
#if ENABLE_GPS
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  if (gpsState.hasFix) {
    evt.lat = (float)gpsState.lat;
    evt.lon = (float)gpsState.lon;
    evt.cause = 1; /* tem posicao */
  }
  xSemaphoreGive(stateMutex);
#endif
  xQueueSend(eventQueue, &evt, 0);
  haptic(HapticPattern::Confirm);
  confirmFeedbackUntil = millis() + 400;
  Serial.printf("[ANCORA] 2 cliques: pedindo a ancora rapida %s.\n", evt.cause ? "na posicao do GPS" : "(sem GPS: o servidor usa a ultima posicao)");
}

void handleGesture(ClickGesture g) {
  if (g == ClickGesture::Single) {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    appState.mode = (Mode)((appState.mode + 1) % MODE_COUNT);
    xSemaphoreGive(stateMutex);
  } else if (g == ClickGesture::Double) {
    requestQuickAnchor();
  } else if (g == ClickGesture::Triple) {
    netRequestPortal();
  }
}

void TaskButton(void * /* pvParameters */) {
  ClickClassifier clicks(CLICK_GAP_MS);
  for (;;) {
    /* espera um aperto, mas acorda a cada 20 ms para fechar 1 ou 2 cliques quando a janela passa */
    if (xSemaphoreTake(buttonSemaphore, pdMS_TO_TICKS(20)) != pdTRUE) {
      handleGesture(clicks.tick(millis()));
      continue;
    }
    vTaskDelay(pdMS_TO_TICKS(BUTTON_DEBOUNCE_MS));
    if (digitalRead(PIN_BUTTON) != LOW) continue; /* ruido */
    wakeRequested = true; /* qualquer clique sai da economia de energia */

    /* o alerta do clique longo sai assim que completa 1,5 s, sem esperar soltar o botao */
    uint32_t pressStart = millis();
    bool longFired = false;
    while (digitalRead(PIN_BUTTON) == LOW) {
      if (!longFired && millis() - pressStart >= BUTTON_LONGPRESS_MS) {
        longFired = true;
        clicks.reset();
        AppEvent evt = makeEvent(EVT_CRASH, 0, '-');
        xQueueSend(eventQueue, &evt, 0);
        crashFlashUntil = millis() + CRASH_FLASH_MS;
      }
      vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (longFired) continue;

    /* durante o pre-alerta, o clique curto e o "Estou bem": cancela na hora, sem esperar a
       classificacao de 1/2/3 cliques, e nao troca o modo */
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    bool inPreAlert = alertFsm.inPreAlert();
    AlertAction action = inPreAlert ? alertFsm.cancel(millis()) : AlertAction::None;
    PendingAlert pending = alertFsm.pending();
    xSemaphoreGive(stateMutex);
    if (inPreAlert) {
      clicks.reset();
      queueAlertOutcome(action, pending);
      if (action == AlertAction::Dismiss) {
        confirmFeedbackUntil = millis() + 400; /* LED verde; a TaskHaptic toca a confirmacao */
        Serial.println("[ALERTA] Cancelado pelo botao (\"Estou bem\").");
      }
      continue;
    }
    handleGesture(clicks.click(millis())); /* 3 cliques sai aqui; 1 e 2 saem no tick */
  }
}

/*=====================================================*/
/* Task 3 - LED RGB (status / proximidade)               */
/*=====================================================*/
void TaskStatusLed(void * /* pvParameters */) {
  bootFlash();

  for (;;) {
    uint32_t now = millis();

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    SensorState s = sensorState;
    Mode mode = appState.mode;
    xSemaphoreGive(stateMutex);

    float thr = DIST_MIN_CM + s.potNormalized * (DIST_MAX_CM - DIST_MIN_CM);
    float r = 0, g = 0, b = 0;

    uint32_t preSince = preAlertSince;
    if (now < crashFlashUntil) {
      computeCrashFlash(r, g, b);
    } else if (preSince != 0) {
      /* ambar piscando cada vez mais rapido: queda/batida, aperte o botao se estiver tudo bem */
      float p = constrain((now - preSince) / (float)PRE_ALERT_MS, 0.0f, 1.0f);
      uint32_t half = 300 - (uint32_t)(p * 220.0f);
      float on = ((now / half) % 2) ? 1.0f : 0.05f;
      r = on; g = 0.45f * on; b = 0.0f;
    } else if ((int32_t)(confirmFeedbackUntil - now) > 0) {
      r = 0.0f; g = 1.0f; b = 0.0f; /* verde: alerta cancelado */
    } else if (calibrating) {
      /* azul pulsando rapido (2x por segundo): calibracao, pode andar */
      float p = 0.5f + 0.5f * sinf(now / 80.0f);
      r = 0.0f; g = 0.1f * p; b = 0.2f + 0.8f * p;
    } else if (netTesting()) {
      /* ciano piscando rapido: testando uma rede Wi-Fi nova */
      float on = ((now / 120) % 2) ? 1.0f : 0.1f;
      r = 0.0f; g = 0.6f * on; b = on;
    } else if (netPortalActive()) {
      /* azul "respirando": portal de configuracao de Wi-Fi aberto */
      float p = 0.15f + 0.85f * (0.5f + 0.5f * sinf(now / 400.0f));
      r = 0.0f; g = 0.25f * p; b = p;
    } else if (mode == MODE_RADAR) {
      computeRadar(s, thr, now, r, g, b);
    } else {
      computeSelftest(now, r, g, b);
    }

    setRGB(r, g, b);

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    appState.lastThr = thr;
    xSemaphoreGive(stateMutex);

    vTaskDelay(pdMS_TO_TICKS(STATUS_PERIOD_MS));
  }
}

/*=====================================================*/
/* Task 4 - Haptica (sequenciador de padroes -> motores) */
/*=====================================================*/
/* PWM dos dois MV50 (timer configurado antes do attach: o ledcWrite(canal, 0) nao grava duty 1) */
void motorSetup() {
  ledcSetup(MOTOR_CHANNEL_L, MOTOR_PWM_HZ, MOTOR_PWM_BITS);
  ledcSetup(MOTOR_CHANNEL_R, MOTOR_PWM_HZ, MOTOR_PWM_BITS);
  ledcWrite(MOTOR_CHANNEL_L, 0);
  ledcWrite(MOTOR_CHANNEL_R, 0);
  ledcAttachPin(PIN_MOTOR_L, MOTOR_CHANNEL_L);
  ledcAttachPin(PIN_MOTOR_R, MOTOR_CHANNEL_R);
}

/* intensidade 0..1: abaixo de MOTOR_MIN_DUTY o motor nao gira, entao 0..1 vira MIN..100% (0 = parado) */
void motorWrite(uint8_t channel, float level) {
  const uint32_t maxDuty = (1u << MOTOR_PWM_BITS) - 1;
  float duty = level <= 0.0f ? 0.0f : MOTOR_MIN_DUTY + constrain(level, 0.0f, 1.0f) * (1.0f - MOTOR_MIN_DUTY);
  ledcWrite(channel, (uint32_t)(duty * maxDuty));
}

/* fundo de cada lado conforme o detector de TTC: parado = pulso espacado e suave; aproximando = mais
   rapido e forte quanto mais perto (ALERT_START_CM .. ALERT_FULL_CM) */
void setSideAmbient(HapticEngine &engine, uint8_t side, const SideState &s) {
  float closeness = s.filteredCm < 0 ? 0.0f
      : constrain((ALERT_START_CM - s.filteredCm) / (ALERT_START_CM - ALERT_FULL_CM), 0.0f, 1.0f);
  HapticPattern p = HapticPattern::None;
  if (s.level == TtcLevel::Critical || s.level == TtcLevel::Approaching) p = HapticPattern::Proximity;
  /* parado: a faixa de aviso tem histerese (liga a ALERT_START_CM, desliga so depois de + runtimeHystCm,
     calibrada pelo ruido do eco), para o aviso nao piscar com alguem parado na borda */
  else if (s.inRange) p = HapticPattern::StaticObstacle;
  engine.setAmbient(side, p, closeness);
}

void TaskHaptic(void * /* pvParameters */) {
  const HapticConfig cfg = {PRE_ALERT_MS, LOCATE_MS};
  HapticEngine engine(cfg);
  float shownL = 0.0f, shownR = 0.0f; /* para a telemetria: pico que decai, nao pisca a cada pulso */

  for (;;) {
    uint32_t now = millis();
    HapticRequest rq;
    while (xQueueReceive(hapticQueue, &rq, 0) == pdTRUE) {
      if (rq.stop) engine.stop(rq.pattern, rq.sides);
      else engine.play(rq.pattern, rq.sides, now);
    }

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    SideState left = sensorState.left;
    SideState right = sensorState.right;
    xSemaphoreGive(stateMutex);
    setSideAmbient(engine, HAPTIC_LEFT, left);
    setSideAmbient(engine, HAPTIC_RIGHT, right);

    HapticOutput out = engine.tick(now);
    motorWrite(MOTOR_CHANNEL_L, out.left);
    motorWrite(MOTOR_CHANNEL_R, out.right);

    shownL = max(out.left, shownL * 0.95f);
    shownR = max(out.right, shownR * 0.95f);
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    appState.vibL = shownL;
    appState.vibR = shownR;
    xSemaphoreGive(stateMutex);

    vTaskDelay(pdMS_TO_TICKS(HAPTIC_PERIOD_MS));
  }
}

/*=====================================================*/
/* Task 6 - GPS NEO-6M (UART2, sentencas NMEA)           */
/*=====================================================*/
#if ENABLE_GPS
void TaskGps(void * /* pvParameters */) {
  Serial2.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);

  for (;;) {
    while (Serial2.available() > 0) {
      gps.encode((char)Serial2.read());
    }

    bool fresh = gps.location.isValid() && gps.location.age() < GPS_MAX_AGE_MS;

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    gpsState.charsRx = gps.charsProcessed();
    gpsState.sats = gps.satellites.isValid() ? gps.satellites.value() : 0;
    gpsState.hasFix = fresh;
    if (fresh) {
      gpsState.lat = gps.location.lat();
      gpsState.lon = gps.location.lng();
      gpsState.hdop = gps.hdop.isValid() ? (float)gps.hdop.hdop() : 0.0f;
      gpsState.accuracyM = gpsState.hdop * GPS_UERE_M;
      gpsState.speedMps = gps.speed.isValid() ? (float)gps.speed.mps() : 0.0f;
      gpsState.fixAtMs = millis() - gps.location.age();
    }
    xSemaphoreGive(stateMutex);

    vTaskDelay(pdMS_TO_TICKS(20)); /* a 9600 baud chegam ~20 bytes a cada 20 ms; o buffer da UART segura 256 */
  }
}
#endif

/*=====================================================*/
/* Task 7 - MPU-6050: queda, impacto e equilibrio        */
/*=====================================================*/
#if ENABLE_IMU
/* registradores do MPU-6050 */
static const uint8_t MPU_REG_SMPLRT_DIV = 0x19;
static const uint8_t MPU_REG_CONFIG = 0x1A;
static const uint8_t MPU_REG_GYRO_CONFIG = 0x1B;
static const uint8_t MPU_REG_ACCEL_CONFIG = 0x1C;
static const uint8_t MPU_REG_ACCEL_XOUT_H = 0x3B;
static const uint8_t MPU_REG_PWR_MGMT_1 = 0x6B;
static const uint8_t MPU_REG_WHO_AM_I = 0x75;
static const float MPU_ACCEL_LSB_PER_G = 4096.0f;  /* faixa de +-8 g */
static const float MPU_GYRO_LSB_PER_DPS = 65.5f;   /* faixa de +-500 graus/s */

static uint8_t mpuAddr = MPU_ADDR; /* 0x68 ou 0x69, detectado no boot */
static uint8_t mpuWhoAmI = 0;

/* responde no barramento? (ACK do endereco) */
bool i2cProbe(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

/* lista tudo que responde no I2C: mostra se o modulo esta em outro endereco ou se nada responde */
void i2cScan() {
  int found = 0;
  Serial.print("[IMU] Varredura I2C (SDA 26, SCL 27):");
  for (uint8_t a = 0x08; a < 0x78; a++) {
    if (i2cProbe(a)) {
      Serial.printf(" 0x%02X", a);
      found++;
    }
  }
  if (found) {
    Serial.println();
    return;
  }
  Serial.println(" nenhum dispositivo.");

  /* fio de SDA e SCL invertido e o erro mais comum: testa com os pinos trocados */
  Wire.end();
  Wire.begin(PIN_I2C_SCL, PIN_I2C_SDA, 100000);
  bool swapped = i2cProbe(MPU_ADDR) || i2cProbe(MPU_ADDR ^ 0x01);
  Wire.end();
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_FREQ_HZ);
  if (swapped) {
    Serial.printf("[IMU] >>> Achei o MPU com os fios INVERTIDOS: troque os fios (SDA do modulo -> GPIO %d, SCL -> GPIO %d).\n",
                  PIN_I2C_SDA, PIN_I2C_SCL);
  } else {
    Serial.println("[IMU] Nem com SDA/SCL trocados. Confira: LED do modulo aceso? VCC e GND certos? "
                   "pinos do modulo soldados? fios nos furos D26/D27 da placa?");
  }
}

const char *mpuChipName(uint8_t who) {
  switch (who) {
    case 0x68: return "MPU-6050";
    case 0x70: return "MPU-6500";
    case 0x71: return "MPU-9250";
    case 0x73: return "MPU-9255";
    case 0x12: return "ICM-20602";
    default: return "compativel/clone";
  }
}

bool mpuWrite(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool mpuRead(uint8_t reg, uint8_t *buf, size_t len) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint16_t)mpuAddr, (uint8_t)len) != len) return false;
  for (size_t i = 0; i < len; i++) buf[i] = (uint8_t)Wire.read();
  return true;
}

bool mpuInit() {
  /* testa 0x68 (AD0 no GND) e 0x69 (AD0 em 3V3 ou solto em alguns modulos) */
  if (i2cProbe(MPU_ADDR)) mpuAddr = MPU_ADDR;
  else if (i2cProbe(MPU_ADDR ^ 0x01)) mpuAddr = MPU_ADDR ^ 0x01;
  else return false;

  /* placas "ITG/MPU" podem trazer MPU-6050, 6500, 9250 ou clones: os registradores usados aqui sao iguais */
  if (!mpuRead(MPU_REG_WHO_AM_I, &mpuWhoAmI, 1)) return false;
  if (!mpuWrite(MPU_REG_PWR_MGMT_1, 0x80)) return false; /* reset: o ESP32 pode reiniciar sem o modulo desligar */
  vTaskDelay(pdMS_TO_TICKS(100));
  return mpuWrite(MPU_REG_PWR_MGMT_1, 0x01) &&   /* acorda, clock do giroscopio X */
         mpuWrite(MPU_REG_SMPLRT_DIV, MPU_SMPLRT_DIV) &&
         mpuWrite(MPU_REG_CONFIG, MPU_DLPF_CFG) &&
         mpuWrite(MPU_REG_GYRO_CONFIG, 0x08) &&  /* +-500 graus/s */
         mpuWrite(MPU_REG_ACCEL_CONFIG, 0x10);   /* +-8 g: impactos passam facilmente de 2 g */
}

/* le aceleracao (g) e giro (graus/s) brutos */
bool mpuReadMotion(float &ax, float &ay, float &az, float &gx, float &gy, float &gz) {
  uint8_t b[14];
  if (!mpuRead(MPU_REG_ACCEL_XOUT_H, b, sizeof(b))) return false;
  auto i16 = [&](int i) { return (int16_t)((b[i] << 8) | b[i + 1]); };
  ax = i16(0) / MPU_ACCEL_LSB_PER_G;
  ay = i16(2) / MPU_ACCEL_LSB_PER_G;
  az = i16(4) / MPU_ACCEL_LSB_PER_G;
  /* b[6..7] = temperatura (nao usada) */
  gx = i16(8) / MPU_GYRO_LSB_PER_DPS;
  gy = i16(10) / MPU_GYRO_LSB_PER_DPS;
  gz = i16(12) / MPU_GYRO_LSB_PER_DPS;
  return true;
}

void TaskImu(void * /* pvParameters */) {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_FREQ_HZ);

  while (!mpuInit()) {
    Serial.println("[IMU] MPU nao respondeu em 0x68 nem 0x69. Tentando de novo em 3 s...");
    i2cScan();
    vTaskDelay(pdMS_TO_TICKS(3000));
  }
  Serial.printf("[IMU] %s encontrado em 0x%02X (WHO_AM_I 0x%02X), %d amostras/s.\n",
                mpuChipName(mpuWhoAmI), mpuAddr, mpuWhoAmI, 1000 / IMU_PERIOD_MS);

  /* Calibracao: com o dispositivo parado na posicao de uso, mede o offset do
     giroscopio e a direcao da gravidade (referencia para a inclinacao). */
  Serial.println("[IMU] Calibrando: mantenha o dispositivo parado...");
  float sum[6] = {0, 0, 0, 0, 0, 0};
  int n = 0;
  uint32_t start = millis();
  while (millis() - start < IMU_CALIBRATION_MS) {
    float m[6];
    if (mpuReadMotion(m[0], m[1], m[2], m[3], m[4], m[5])) {
      for (int i = 0; i < 6; i++) sum[i] += m[i];
      n++;
    }
    vTaskDelay(pdMS_TO_TICKS(IMU_PERIOD_MS));
  }
  if (n == 0) n = 1;
  float gravityRef[3] = {sum[0] / n, sum[1] / n, sum[2] / n};
  float gyroBias[3] = {sum[3] / n, sum[4] / n, sum[5] / n};
  float lp[3] = {gravityRef[0], gravityRef[1], gravityRef[2]}; /* aceleracao filtrada para a inclinacao */

  /* Normalizacao: parado, o modulo deveria medir exatamente 1 g. Modulos e clones costumam ler
     0,95-1,08 g; dividir pela gravidade medida no boot deixa os limiares iguais em qualquer placa. */
  float restG = sqrtf(gravityRef[0] * gravityRef[0] + gravityRef[1] * gravityRef[1] + gravityRef[2] * gravityRef[2]);
  float gScale = 1.0f;
  if (restG > 0.8f && restG < 1.25f) {
    gScale = 1.0f / restG;
  } else {
    Serial.printf("[IMU] Gravidade medida %.2f g (esperado ~1): o modulo mexeu na calibracao? Sem normalizacao.\n", restG);
  }
  Serial.printf("[IMU] Pronto. Gravidade de referencia: %.2f %.2f %.2f g (escala x%.3f)\n",
                gravityRef[0], gravityRef[1], gravityRef[2], gScale);

  const ImuDetectorConfig cfg = {FREEFALL_G, FREEFALL_MIN_MS, FALL_WINDOW_MS, FALL_IMPACT_G,
                                 IMPACT_G, IMU_PEAK_WINDOW_MS, IMU_EVENT_COOLDOWN_MS,
                                 FALL_CONFIRM_MS, FALL_TILT_DEG, HARD_IMPACT_G};
  ImuDetector detector(cfg);
  const PowerConfig pwrCfg = {POWER_MOTION_G, POWER_MOTION_STD_G, POWER_MOTION_GYRO_DPS, POWER_VAR_ALPHA, POWER_IDLE_AFTER_MS};
  PowerManager power(pwrCfg);
  uint32_t readErrors = 0;
  TickType_t lastWake = xTaskGetTickCount();

  for (;;) {
    float ax, ay, az, gx, gy, gz;
    if (mpuReadMotion(ax, ay, az, gx, gy, gz)) {
      readErrors = 0;
      gx -= gyroBias[0];
      gy -= gyroBias[1];
      gz -= gyroBias[2];
      ax *= gScale;
      ay *= gScale;
      az *= gScale;
      float g = sqrtf(ax * ax + ay * ay + az * az);

      /* inclinacao antes do detector: ela confirma (ou descarta) a queda */
      lp[0] += TILT_FILTER_ALPHA * (ax - lp[0]);
      lp[1] += TILT_FILTER_ALPHA * (ay - lp[1]);
      lp[2] += TILT_FILTER_ALPHA * (az - lp[2]);
      float tilt = tiltFromReferenceDeg(gravityRef, lp[0], lp[1], lp[2]);
#if IMU_DEBUG
      static float dbgMin = 99, dbgMax = 0;
      static uint32_t dbgAt = 0;
      dbgMin = min(dbgMin, g);
      dbgMax = max(dbgMax, g);
      if (millis() - dbgAt >= 500) {
        Serial.printf("[IMU] g agora %.2f  min %.2f  max %.2f  (queda livre < %.1f, queda >= %.1f, impacto >= %.1f)\n",
                      g, dbgMin, dbgMax, FREEFALL_G, FALL_IMPACT_G, IMPACT_G);
        dbgAt = millis();
        dbgMin = 99;
        dbgMax = 0;
      }
#endif

      /* economia de energia: parado por POWER_IDLE_AFTER_MS -> economia; qualquer movimento ou clique acorda */
      float gyroMag = sqrtf(gx * gx + gy * gy + gz * gz);
      if (wakeRequested) {
        wakeRequested = false;
        applyPowerChange(power.wake(millis()));
      }
      applyPowerChange(power.update(g, gyroMag, millis()));
      if (detector.impactG() != runtimeImpactG) detector.setImpactG(runtimeImpactG); /* calibracao ou "padrao" */

      float peak, evtTilt;
      ImuEvent evt = detector.update(g, tilt, millis(), peak, evtTilt);
      if (evt == ImuEvent::Jump) {
        Serial.printf("[IMU] Pulo/passo forte ignorado (pico %.2f g, inclinacao %.0f graus: continuou de pe).\n", peak, evtTilt);
      }

      /* queda/batida confirmada abre o pre-alerta "Estou bem"; o alerta so sai depois de PRE_ALERT_MS */
      uint32_t nowMs = millis();
      xSemaphoreTake(stateMutex, portMAX_DELAY);
      bool opened = false;
      if (evt == ImuEvent::Fall || evt == ImuEvent::Impact) {
        opened = alertFsm.trigger(evt == ImuEvent::Fall ? AlertCause::Fall : AlertCause::Impact, peak,
                                  evt == ImuEvent::Fall ? evtTilt : -1.0f, nowMs);
        if (opened) {
          preAlertSince = nowMs | 1;
          haptic(HapticPattern::PreAlert);
        }
      }
      AlertAction action = alertFsm.tick(nowMs);
      PendingAlert pending = alertFsm.pending();
      xSemaphoreGive(stateMutex);
      if (opened) {
        Serial.printf("[ALERTA] %s (%.2f g). Aperte o botao 1 vez em %d s se estiver tudo bem.\n",
                      evt == ImuEvent::Fall ? "Queda detectada" : "Batida detectada", peak, PRE_ALERT_MS / 1000);
      }
      queueAlertOutcome(action, pending);

      xSemaphoreTake(stateMutex, portMAX_DELAY);
      imuState.ready = true;
      calibrator.addAccel(g, millis()); /* so registra durante a calibracao */
      imuState.ax = ax; imuState.ay = ay; imuState.az = az;
      imuState.gx = gx; imuState.gy = gy; imuState.gz = gz;
      imuState.g = g;
      if (g > imuState.gMax) imuState.gMax = g;
      imuState.tiltDeg = tilt;
      xSemaphoreGive(stateMutex);
    } else if (++readErrors == 1000 / IMU_PERIOD_MS) {
      Serial.println("[IMU] Falha de leitura no I2C (1 s sem dados). Confira os fios do MPU-6050.");
      xSemaphoreTake(stateMutex, portMAX_DELAY);
      imuState.ready = false;
      xSemaphoreGive(stateMutex);
    }
    if (readErrors > 0) {
      /* sem leitura do MPU, o pre-alerta que ja estava aberto ainda precisa vencer e mandar o alerta */
      xSemaphoreTake(stateMutex, portMAX_DELAY);
      AlertAction action = alertFsm.tick(millis());
      PendingAlert pending = alertFsm.pending();
      xSemaphoreGive(stateMutex);
      queueAlertOutcome(action, pending);
    }

    vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(IMU_PERIOD_MS));
  }
}
#endif

/*=====================================================*/
/* Task 5 - Comunicacao (Serial JSON + rede em net.cpp)  */
/*=====================================================*/
/* toda mensagem sai pela Serial (USB) e, com rede, pelo MQTT */
void publishLine(NetChannel ch, const char *json) {
  Serial.println(json);
  netPublish(ch, json);
}

const char *modeToString(Mode m) {
  switch (m) {
    case MODE_RADAR: return "RADAR";
    default: return "SELFTEST";
  }
}

void publishTelemetry() {
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  SensorState s = sensorState;
  Mode mode = appState.mode;
  float thr = appState.lastThr;
  float volL = appState.vibL;
  float volR = appState.vibR;
  xSemaphoreGive(stateMutex);

  /* "near" = NEAR_MISS_CM: o painel desenha a faixa de quase colisao com o mesmo valor do firmware */
  char buf[220];
  snprintf(buf, sizeof(buf),
           "{\"t\":%lu,\"mode\":\"%s\","
           "\"distL\":%.1f,\"rawL\":%.1f,"
           "\"distR\":%.1f,\"rawR\":%.1f,"
           "\"vibL\":%.2f,\"vibR\":%.2f,"
           "\"thr\":%.0f,\"pot\":%.2f,\"near\":%.0f}",
           (unsigned long)millis(), modeToString(mode),
           s.left.filteredCm, s.left.rawCm,
           s.right.filteredCm, s.right.rawCm,
           volL, volR,
           thr, s.potNormalized, NEAR_MISS_CM);

  publishLine(CH_TELEMETRY, buf);
}

const char *alertCauseName(uint8_t cause) {
  return cause == (uint8_t)AlertCause::Fall ? "FALL" : "IMPACT";
}

void emitEvent(const AppEvent &evt) {
  char buf[160];
  if (evt.type == EVT_NEAR_MISS && evt.cause == (uint8_t)TtcReason::Ttc) {
    snprintf(buf, sizeof(buf),
             "{\"event\":\"NEAR_MISS\",\"side\":\"%c\",\"value\":%.1f,\"reason\":\"ttc\",\"ttc\":%.2f,\"v\":%.0f,\"t\":%lu}",
             evt.side, evt.value, evt.ttc, evt.vel, (unsigned long)evt.t);
  } else if (evt.type == EVT_NEAR_MISS) {
    snprintf(buf, sizeof(buf), "{\"event\":\"NEAR_MISS\",\"side\":\"%c\",\"value\":%.1f,\"reason\":\"close\",\"t\":%lu}",
             evt.side, evt.value, (unsigned long)evt.t);
  } else if (evt.type == EVT_ANCHOR && evt.cause) {
    /* 2 cliques: liga/desliga a ancora rapida (o servidor decide: cria se nao houver, remove se houver) */
    snprintf(buf, sizeof(buf), "{\"event\":\"ANCHOR_TOGGLE\",\"type\":\"quick_anchor_toggle\",\"lat\":%.6f,\"lng\":%.6f,\"t\":%lu}",
             evt.lat, evt.lon, (unsigned long)evt.t);
  } else if (evt.type == EVT_ANCHOR) {
    snprintf(buf, sizeof(buf), "{\"event\":\"ANCHOR_TOGGLE\",\"type\":\"quick_anchor_toggle\",\"t\":%lu}", (unsigned long)evt.t);
  } else if (evt.type == EVT_DISMISSED) {
    /* queda/batida cancelada pelo usuario ("Estou bem"): o painel registra sem alarme */
    snprintf(buf, sizeof(buf), "{\"event\":\"DISMISSED\",\"cause\":\"%s\",\"value\":%.2f,\"unit\":\"g\",\"t\":%lu}",
             alertCauseName(evt.cause), evt.value, (unsigned long)evt.t);
  } else if (evt.type == EVT_FALL && evt.tilt >= 0) {
    snprintf(buf, sizeof(buf), "{\"event\":\"FALL\",\"value\":%.2f,\"unit\":\"g\",\"tilt\":%.0f,\"t\":%lu}",
             evt.value, evt.tilt, (unsigned long)evt.t);
  } else if (evt.type == EVT_FALL || evt.type == EVT_IMPACT) {
    snprintf(buf, sizeof(buf), "{\"event\":\"%s\",\"value\":%.2f,\"unit\":\"g\",\"t\":%lu}",
             evt.type == EVT_FALL ? "FALL" : "IMPACT", evt.value, (unsigned long)evt.t);
  } else {
    snprintf(buf, sizeof(buf), "{\"event\":\"CRASH\",\"t\":%lu}", (unsigned long)evt.t);
  }

  Serial.println(buf);
  netPublishEvent(buf); /* evento nao pode se perder: sem broker, fica guardado e sai na reconexao */
}

/* versao, tempo ligado, memoria livre e rede (sinal, IP, rede, servidor, fila de eventos) */
void publishStatus() {
  char buf[640];
  int n = snprintf(buf, sizeof(buf), "{\"fw\":\"%s\",\"up\":%lu,\"heap\":%lu",
                   FW_VERSION, (unsigned long)(millis() / 1000), (unsigned long)ESP.getFreeHeap());
  n += snprintf(buf + n, sizeof(buf) - n, ",\"pwr\":\"%s\",\"impG\":%.2f,\"hyst\":%.1f,\"cal\":%s",
                powerIdle ? "idle" : "active",
                runtimeImpactG, runtimeHystCm, calibrating ? "true" : "false");
  n += netStatusAppend(buf + n, sizeof(buf) - n - 24);
  snprintf(buf + n, sizeof(buf) - n, ",\"t\":%lu}", (unsigned long)millis());
  publishLine(CH_STATUS, buf);
}

#if ENABLE_IMU
/* aceleracao, giro e inclinacao; "g" e o maior modulo desde a ultima publicacao,
   para o painel nao perder o pico de uma pancada */
void publishImu() {
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  ImuState s = imuState;
  imuState.gMax = 0;
  xSemaphoreGive(stateMutex);
  if (!s.ready) return;

  char buf[200];
  snprintf(buf, sizeof(buf),
           "{\"ax\":%.2f,\"ay\":%.2f,\"az\":%.2f,"
           "\"gx\":%.1f,\"gy\":%.1f,\"gz\":%.1f,"
           "\"gMax\":%.2f,\"tilt\":%.0f,\"t\":%lu}",
           s.ax, s.ay, s.az, s.gx, s.gy, s.gz, s.gMax > 0 ? s.gMax : s.g, s.tiltDeg, (unsigned long)millis());
  publishLine(CH_IMU, buf);
}
#endif

#if ENABLE_GPS
void publishLocation() {
  static uint32_t lastStatusLog = 0;

  xSemaphoreTake(stateMutex, portMAX_DELAY);
  GpsState s = gpsState;
  xSemaphoreGive(stateMutex);

  if (!s.hasFix) {
    if (millis() - lastStatusLog >= GPS_STATUS_LOG_MS) {
      lastStatusLog = millis();
      if (s.charsRx == 0) {
        Serial.println("[GPS] Nenhum dado do modulo: confira TX do GPS -> GPIO16, 3V3 e GND.");
      } else {
        Serial.printf("[GPS] Sem posicao ainda (%lu satelites). Leve para perto de uma janela/ceu aberto.\n",
                      (unsigned long)s.sats);
      }
    }
    return;
  }

  char buf[160];
  snprintf(buf, sizeof(buf),
           "{\"lat\":%.6f,\"lon\":%.6f,\"acc\":%.1f,\"hdop\":%.2f,\"sats\":%lu,\"speed\":%.2f,\"t\":%lu}",
           s.lat, s.lon, s.accuracyM, s.hdop, (unsigned long)s.sats, s.speedMps, (unsigned long)millis());
  publishLine(CH_LOCATION, buf);
}
#endif

/* comandos do painel (echomap/<id>/cmd); ping e portal sao tratados em net.cpp */
/*=====================================================*/
/* Teste dos ultrassonicos ("sensores" / "Testar sensores") */
/*=====================================================*/
/* Para cada lado: o ECHO fica em LOW parado? Dispara o TRIG e mede o eco. Se o pino do ECHO
   tem ADC (GPIO33 no lado direito), mede tambem a tensao que chega do divisor: ~3,3 V e o
   certo, ~1,7 V indica resistores invertidos, ~0 V indica que nada chega. E ve se o eco
   apareceu no pino do OUTRO lado (fios de ECHO trocados entre os sensores). */
struct SideDiag {
  bool idleHigh = false;
  bool echo = false;
  float cm = -1;
  int peakMv = -1; /* -1 = pino sem ADC */
  bool cross = false;
};

static void fireTrig(uint8_t trig) {
  digitalWrite(trig, LOW);
  delayMicroseconds(2);
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);
}

static SideDiag diagSide(uint8_t trig, uint8_t echo, uint8_t otherEcho) {
  SideDiag d;
  int highs = 0;
  for (int i = 0; i < 20; i++) {
    highs += digitalRead(echo);
    delayMicroseconds(100);
  }
  d.idleHigh = highs > 15;

  for (int attempt = 0; attempt < 3 && !d.echo; attempt++) {
    fireTrig(trig);
    uint32_t t0 = micros(), rise = 0;
    while (micros() - t0 < 30000) {
      int e = digitalRead(echo);
      if (!rise && e) rise = micros();
      if (rise && !e) {
        d.echo = true;
        d.cm = (micros() - rise) * 0.0343f / 2.0f;
        break;
      }
      if (digitalRead(otherEcho)) d.cross = true;
    }
    vTaskDelay(pdMS_TO_TICKS(60)); /* deixa o eco anterior morrer */
  }

  int ch = digitalPinToAnalogChannel(echo);
  if (ch >= 0 && ch < 10) { /* ADC1 (funciona com o Wi-Fi ligado) */
    fireTrig(trig);
    uint32_t t0 = millis();
    int peak = 0;
    while (millis() - t0 < 30) {
      int mv = analogReadMilliVolts(echo);
      if (mv > peak) peak = mv;
    }
    d.peakMv = peak;
    pinMode(echo, INPUT); /* devolve o pino para leitura digital */
  }
  return d;
}

static void diagJson(char *buf, size_t len, const char *side, uint8_t trig, uint8_t echo, const SideDiag &d) {
  snprintf(buf, len, "\"%s\":{\"trig\":%u,\"echo\":%u,\"idleHigh\":%s,\"echoOk\":%s,\"cm\":%.1f,\"mv\":%d,\"cross\":%s}", side,
           trig, echo, d.idleHigh ? "true" : "false", d.echo ? "true" : "false", d.cm, d.peakMv, d.cross ? "true" : "false");
}

static void printDiag(const char *name, uint8_t trig, uint8_t echo, const SideDiag &d) {
  Serial.printf("[DIAG] %s (TRIG %u, ECHO %u): ", name, trig, echo);
  if (d.echo) Serial.printf("OK, eco a %.0f cm", d.cm);
  else if (d.idleHigh) Serial.print("ECHO preso em nivel alto (confira o divisor)");
  else if (d.cross) Serial.print("sem eco aqui, mas o eco apareceu no pino do OUTRO lado (fios de ECHO trocados)");
  else if (d.peakMv >= 2400) Serial.printf("sinal chega (%d mV) mas sem pulso valido", d.peakMv);
  else if (d.peakMv >= 600) Serial.printf("sinal FRACO no pino (%d mV): resistores do divisor invertidos ou errados", d.peakMv);
  else if (d.peakMv >= 0) Serial.printf("nenhum sinal no pino (%d mV): sensor sem 5 V/GND, TRIG solto ou ECHO sem chegar ao divisor", d.peakMv);
  else Serial.print("sem eco: confira 5 V, GND, TRIG e ECHO (divisor)");
  if (d.peakMv >= 0 && d.echo) Serial.printf(", %d mV no pino", d.peakMv);
  Serial.println();
}

static void runSensorDiag() {
  sensorsPaused = true;
  vTaskDelay(pdMS_TO_TICKS(120)); /* termina a leitura que estava em andamento */
  Serial.println("[DIAG] Testando os ultrassonicos (aponte para uma parede a 30-100 cm)...");
  SideDiag l = diagSide(PIN_TRIG_L, PIN_ECHO_L, PIN_ECHO_R);
  vTaskDelay(pdMS_TO_TICKS(60));
  SideDiag r = diagSide(PIN_TRIG_R, PIN_ECHO_R, PIN_ECHO_L);
  sensorsPaused = false;

  printDiag("Esquerdo", PIN_TRIG_L, PIN_ECHO_L, l);
  printDiag("Direito", PIN_TRIG_R, PIN_ECHO_R, r);
  char a[150], b[150], out[340];
  diagJson(a, sizeof(a), "L", PIN_TRIG_L, PIN_ECHO_L, l);
  diagJson(b, sizeof(b), "R", PIN_TRIG_R, PIN_ECHO_R, r);
  snprintf(out, sizeof(out), "{\"diag\":{%s,%s},\"t\":%lu}", a, b, (unsigned long)millis());
  publishLine(CH_DIAG, out);
}

/* comandos do painel (MQTT ou cabo) e da Serial que nao sao de rede */
/*=====================================================*/
/* Calibracao assistida                                  */
/*=====================================================*/
volatile bool statusNow = false; /* publicar o status no proximo ciclo (limiares mudaram) */

void saveCalibration() {
  Preferences prefs;
  if (!prefs.begin(CFG_NAMESPACE, false)) return;
  prefs.putFloat("impactG", runtimeImpactG);
  prefs.putFloat("hystCm", runtimeHystCm);
  prefs.end();
}

/* no boot: limiares calibrados (se houver e estiverem numa faixa valida) */
void loadCalibration() {
  Preferences prefs;
  if (!prefs.begin(CFG_NAMESPACE, false)) return;
  float impact = prefs.getFloat("impactG", IMPACT_G);
  float hyst = prefs.getFloat("hystCm", ALERT_HYST_CM);
  prefs.end();
  if (impact >= CAL_MIN_IMPACT_G && impact <= CAL_MAX_IMPACT_G) runtimeImpactG = impact;
  if (hyst >= CAL_HYST_MIN_CM && hyst <= CAL_HYST_MAX_CM) runtimeHystCm = hyst;
  if (runtimeImpactG != IMPACT_G || runtimeHystCm != ALERT_HYST_CM) {
    Serial.printf("[CALIB] Limiares calibrados: batida %.2f g, histerese %.1f cm.\n", runtimeImpactG, runtimeHystCm);
  }
}

void startCalibration(uint32_t durationS) {
  if (durationS < CAL_MIN_DURATION_S) durationS = CAL_MIN_DURATION_S;
  if (durationS > CAL_MAX_DURATION_S) durationS = CAL_MAX_DURATION_S;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  calibrator.start(millis(), durationS * 1000UL);
  xSemaphoreGive(stateMutex);
  calibrating = true;
  wakeRequested = true; /* sai da economia: precisa dos sensores no ritmo normal */
  haptic(HapticPattern::Confirm);
  statusNow = true;
  Serial.printf("[CALIB] Calibrando por %lu s: ande em linha reta num corredor livre, no seu passo normal.\n",
                (unsigned long)durationS);
}

void publishCalibState(const char *state) {
  char buf[96];
  snprintf(buf, sizeof(buf), "{\"calib\":\"%s\",\"impG\":%.2f,\"hyst\":%.1f,\"t\":%lu}", state, runtimeImpactG,
           runtimeHystCm, (unsigned long)millis());
  publishLine(CH_CALIB, buf);
}

void stopCalibration() {
  if (!calibrating) return;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  calibrator.cancel();
  xSemaphoreGive(stateMutex);
  calibrating = false;
  statusNow = true;
  Serial.println("[CALIB] Calibracao cancelada; os limiares nao mudaram.");
  publishCalibState("cancelled");
}

/* "Restaurar padroes de fabrica": limiares do config.h e NVS limpa */
void resetCalibration() {
  stopCalibration();
  float impactBefore = runtimeImpactG, hystBefore = runtimeHystCm;
  runtimeImpactG = IMPACT_G;
  runtimeHystCm = ALERT_HYST_CM;
  Preferences prefs;
  if (prefs.begin(CFG_NAMESPACE, false)) {
    prefs.remove("impactG");
    prefs.remove("hystCm");
    prefs.end();
  }
  haptic(HapticPattern::Confirm);
  statusNow = true;
  Serial.printf("[CALIB] Padroes de fabrica: batida %.2f g, histerese %.1f cm.\n", runtimeImpactG, runtimeHystCm);
  char buf[200];
  snprintf(buf, sizeof(buf),
           "{\"calib\":\"reset\",\"type\":\"calibration_result\",\"ok\":true,\"impactBefore\":%.2f,\"impactAfter\":%.2f,"
           "\"hystBefore\":%.1f,\"hystAfter\":%.1f,\"t\":%lu}",
           impactBefore, runtimeImpactG, hystBefore, runtimeHystCm, (unsigned long)millis());
  publishLine(CH_CALIB, buf);
}

/* chamado pela TaskComms a cada ciclo: progresso a cada 1 s e o resultado no fim */
void serviceCalibration(uint32_t now) {
  static uint32_t lastProgress = 0;
  if (!calibrating) return;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  bool due = calibrator.due(now);
  uint32_t elapsed = calibrator.elapsedMs(now), duration = calibrator.durationMs();
  uint16_t steps = calibrator.steps();
  CalibResult r;
  if (due) r = calibrator.finish(runtimeImpactG, runtimeHystCm);
  xSemaphoreGive(stateMutex);

  if (!due) {
    if (now - lastProgress >= CAL_PROGRESS_MS) {
      lastProgress = now;
      char buf[112];
      snprintf(buf, sizeof(buf), "{\"calib\":\"running\",\"elapsed\":%.1f,\"duration\":%lu,\"steps\":%u,\"t\":%lu}",
               elapsed / 1000.0f, (unsigned long)(duration / 1000), steps, (unsigned long)now);
      publishLine(CH_CALIB, buf);
    }
    return;
  }

  calibrating = false;
  statusNow = true;
  bool ok = r.status == CalibStatus::Done;
  if (ok) {
    runtimeImpactG = r.impactAfter; /* a TaskImu aplica no detector na proxima amostra */
    runtimeHystCm = r.hystAfter;
    saveCalibration();
    haptic(HapticPattern::Confirm);
    Serial.printf("[CALIB] Pronto: %u passos (pico %.2f g). Batida %.2f -> %.2f g, histerese %.1f -> %.1f cm.\n", r.steps,
                  r.stepMax, r.impactBefore, r.impactAfter, r.hystBefore, r.hystAfter);
  } else {
    Serial.printf("[CALIB] Nao deu: so %u passos (minimo %d). Ande no seu passo normal durante toda a calibracao.\n",
                  r.steps, CAL_MIN_STEPS);
  }
  char buf[360];
  snprintf(buf, sizeof(buf),
           "{\"calib\":\"%s\",\"type\":\"calibration_result\",\"ok\":%s,\"reason\":\"%s\",\"duration\":%lu,"
           "\"steps\":%u,\"stepMean\":%.2f,\"stepStd\":%.3f,\"stepMax\":%.2f,\"noiseL\":%.2f,\"noiseR\":%.2f,"
           "\"impactBefore\":%.2f,\"impactAfter\":%.2f,\"hystBefore\":%.1f,\"hystAfter\":%.1f,\"t\":%lu}",
           ok ? "done" : "failed", ok ? "true" : "false", r.reason, (unsigned long)(duration / 1000), r.steps, r.stepMean,
           r.stepStd, r.stepMax, r.noiseL, r.noiseR, r.impactBefore, r.impactAfter, r.hystBefore, r.hystAfter,
           (unsigned long)now);
  publishLine(CH_CALIB, buf);
}

/* assinatura de Wi-Fi: a TaskComms decide (GPS ruim ha 15 s, a cada 30 s); o painel pode pedir na hora */
static const FingerprintConfig FP_CFG = {WIFI_FP_GPS_LOST_MS, WIFI_FP_EVERY_MS, WIFI_FP_MIN_SATS};
FingerprintScheduler fingerprint(FP_CFG); /* so a TaskComms usa (comandos tambem rodam nela) */

/* nome do padrao (JSON "pattern" ou Serial "vibrar <nome>"), em ingles ou portugues */
HapticPattern patternByName(const char *n) {
  if (!strcmp(n, "static") || !strcmp(n, "estatico")) return HapticPattern::StaticObstacle;
  if (!strcmp(n, "proximity") || !strcmp(n, "proximidade")) return HapticPattern::Proximity;
  if (!strcmp(n, "approach") || !strcmp(n, "aproximacao")) return HapticPattern::FastApproach;
  if (!strcmp(n, "prealert") || !strcmp(n, "prealerta")) return HapticPattern::PreAlert;
  if (!strcmp(n, "heartbeat") || !strcmp(n, "batimento")) return HapticPattern::Heartbeat;
  if (!strcmp(n, "confirm") || !strcmp(n, "confirmacao")) return HapticPattern::Confirm;
  if (!strcmp(n, "locate") || !strcmp(n, "localizar")) return HapticPattern::Locate;
  return HapticPattern::None;
}

bool onPanelCommand(const char *cmd, const char *json) {
  if (strcmp(cmd, "locate") == 0) {
    haptic(HapticPattern::Locate);
    Serial.println("[APP] Painel pediu para localizar (vibracao forte por 4 s).");
    return true;
  }
  /* testar um padrao da linguagem haptica: {"cmd":"haptic","pattern":"approach"} ou "vibrar approach" */
  if (strcmp(cmd, "haptic") == 0 || strncmp(cmd, "vibrar", 6) == 0) {
    char name[16] = "";
    if (json) netJsonField(json, "pattern", name, sizeof(name));
    else if (cmd[6] == ' ') snprintf(name, sizeof(name), "%s", cmd + 7);
    HapticPattern p = patternByName(name);
    if (p == HapticPattern::None) {
      Serial.println("[HAPTICA] Padroes: static, proximity, approach, prealert, heartbeat, confirm, locate");
    } else {
      haptic(p);
      Serial.printf("[HAPTICA] Tocando \"%s\".\n", name);
    }
    return true;
  }
  /* calibracao: {"cmd":"calibrate_start","duration_s":30}, calibrate_stop, calibrate_reset;
     na Serial: "calibrar", "calibrar 20", "calibrar parar", "calibrar padrao" */
  if (strcmp(cmd, "calibrate_start") == 0) {
    char dur[8] = "";
    if (json) netJsonField(json, "duration_s", dur, sizeof(dur));
    startCalibration(dur[0] ? (uint32_t)atoi(dur) : CAL_DEFAULT_DURATION_S);
    return true;
  }
  if (strcmp(cmd, "calibrate_stop") == 0) { stopCalibration(); return true; }
  /* varredura de Wi-Fi agora (para cadastrar o local atual no painel), mesmo com GPS bom */
  if (strcmp(cmd, "wifi_scan") == 0 || strcmp(cmd, "escanear") == 0) {
    fingerprint.force();
    Serial.println("[WIFI-FP] Varredura pedida.");
    return true;
  }
  if (strcmp(cmd, "calibrate_reset") == 0) { resetCalibration(); return true; }
  if (strncmp(cmd, "calibrar", 8) == 0 && (cmd[8] == '\0' || cmd[8] == ' ')) {
    const char *arg = cmd[8] == ' ' ? cmd + 9 : "";
    if (!strcmp(arg, "parar")) stopCalibration();
    else if (!strcmp(arg, "padrao")) resetCalibration();
    else startCalibration(arg[0] ? (uint32_t)atoi(arg) : CAL_DEFAULT_DURATION_S);
    return true;
  }
  if (strcmp(cmd, "diag") == 0 || strcmp(cmd, "sensores") == 0) {
    diagRequested = true; /* roda no ciclo da TaskComms, fora do callback do MQTT */
    return true;
  }
  return false;
}

void TaskComms(void * /* pvParameters */) {
  TickType_t lastWake = xTaskGetTickCount();
  uint32_t lastTelemetry = 0;
  uint32_t lastStatus = 0;
  uint32_t lastHeartbeat = millis();
#if ENABLE_GPS
  uint32_t lastLocation = 0;
#endif

  netOnCommand(onPanelCommand);
  Serial.println("[APP] Digite \"sensores\" para testar os ultrassonicos.");
  netBegin(bootPortalRequested);

  /* ciclo curto (20 ms): rede, comandos e alertas sao atendidos rapido;
     telemetria, posicao e status saem nos seus proprios periodos */
  /* comandos digitados na Serial (ou mandados pelo painel pelo USB): wifi, portal, rede, esquecer... */
  static char line[160];
  static size_t lineLen = 0;

  for (;;) {
    uint32_t now = millis();
    netService(); /* nunca bloqueia */

    while (Serial.available() > 0) {
      char c = (char)Serial.read();
      if (c == '\r') continue;
      if (c == '\n') {
        line[lineLen] = '\0';
        netHandleLine(line);
        lineLen = 0;
      } else if (lineLen + 1 < sizeof(line)) {
        line[lineLen++] = c;
      }
    }

    AppEvent evt;
    while (xQueueReceive(eventQueue, &evt, 0) == pdTRUE) {
      emitEvent(evt);
    }

    if (diagRequested) {
      diagRequested = false;
      runSensorDiag();
    }

    serviceCalibration(now);

    /* GPS sem sinal (ou pedido do painel): varre o Wi-Fi e manda as 3 redes mais fortes */
    static uint32_t lastFpCheck = 0;
    if (now - lastFpCheck >= 1000) {
      lastFpCheck = now;
      bool fix = false;
      uint32_t sats = 0;
#if ENABLE_GPS
      xSemaphoreTake(stateMutex, portMAX_DELAY);
      fix = gpsState.hasFix;
      sats = gpsState.sats;
      xSemaphoreGive(stateMutex);
#endif
      if (fingerprint.shouldScan(now, fix, sats)) netRequestWifiScan();
    }
    static char fpBuf[360];
    if (netTakeWifiScan(fpBuf, sizeof(fpBuf)) > 0) publishLine(CH_WIFI, fpBuf);
    if (statusNow) {
      statusNow = false;
      lastStatus = 0; /* sai no fim deste ciclo */
    }

    /* batimento: a cada 10 min, so com Wi-Fi e servidor conectados e sem pre-alerta (sinal de "tudo ok") */
    if (now - lastHeartbeat >= HEARTBEAT_PERIOD_MS) {
      lastHeartbeat = now;
      if (netMqttConnected() && preAlertSince == 0) haptic(HapticPattern::Heartbeat);
    }

    if (now - lastTelemetry >= TELEMETRY_PERIOD_MS) {
      lastTelemetry = now;
      publishTelemetry();
#if ENABLE_IMU
      publishImu();
#endif
    }

#if ENABLE_GPS
    if (now - lastLocation >= LOCATION_PERIOD_MS) {
      lastLocation = now;
      publishLocation();
    }
#endif

    /* a cada 5 s, ou na hora quando a rede muda (queda, teste, portal) ou alguem digita "status" na Serial */
    if (netTakeStatusRequest() || lastStatus == 0 || now - lastStatus >= NET_STATUS_PERIOD_MS) {
      lastStatus = now | 1;
      publishStatus();
    }

    vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(COMMS_TICK_MS));
  }
}

/*=====================================================*/
/* Setup                                                 */
/*=====================================================*/
void setup() {
  Serial.begin(115200);

  pinMode(PIN_TRIG_L, OUTPUT);
  pinMode(PIN_ECHO_L, INPUT);
  pinMode(PIN_TRIG_R, OUTPUT);
  pinMode(PIN_ECHO_R, INPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_RGB_R, OUTPUT);
  pinMode(PIN_RGB_G, OUTPUT);
  pinMode(PIN_RGB_B, OUTPUT);

  motorSetup();
  /* remove a chave "actuator" do firmware antigo (escolha de atuador), se ainda estiver na NVS */
  Preferences prefs;
  if (prefs.begin(CFG_NAMESPACE, false)) {
    if (prefs.isKey("actuator")) prefs.remove("actuator");
    prefs.end();
  }
  loadCalibration();

  stateMutex = xSemaphoreCreateMutex();
  eventQueue = xQueueCreate(10, sizeof(AppEvent));
  hapticQueue = xQueueCreate(8, sizeof(HapticRequest));
  buttonSemaphore = xSemaphoreCreateBinary();

  if (stateMutex == NULL || eventQueue == NULL || buttonSemaphore == NULL || hapticQueue == NULL) {
    Serial.println("[ERRO] Falha ao criar primitivos do FreeRTOS.");
    while (true) delay(1000);
  }

  /* segurar o botao ao ligar (2 s) abre o portal de Wi-Fi; o LED fica azul enquanto segura */
  if (digitalRead(PIN_BUTTON) == LOW) {
    setRGB(0, 0, 1);
    uint32_t start = millis();
    while (digitalRead(PIN_BUTTON) == LOW && millis() - start < PORTAL_BUTTON_HOLD_MS) delay(10);
    bootPortalRequested = millis() - start >= PORTAL_BUTTON_HOLD_MS;
    while (digitalRead(PIN_BUTTON) == LOW) delay(10); /* espera soltar para nao virar troca de modo */
    setRGB(0, 0, 0);
  }

  attachInterrupt(digitalPinToInterrupt(PIN_BUTTON), buttonISR, FALLING);

  /* Core 1: leitura de sensores e atuacao (timing critico, longe do Wi-Fi) */
  xTaskCreatePinnedToCore(TaskSensors, "TaskSensors", 3072, NULL, 2, &sensorTaskHandle, 1);
  xTaskCreatePinnedToCore(TaskStatusLed, "TaskStatusLed", 3072, NULL, 1, NULL, 1);
  xTaskCreatePinnedToCore(TaskHaptic, "TaskHaptic", 3072, NULL, 1, NULL, 1);

  /* Core 0: botao, IMU, GPS e comunicacao (serial/MQTT).
     A IMU fica no core 0 para nao interromper o pulseIn() dos HC-SR04 no core 1. */
  xTaskCreatePinnedToCore(TaskButton, "TaskButton", 2048, NULL, 2, NULL, 0);
#if ENABLE_IMU
  xTaskCreatePinnedToCore(TaskImu, "TaskImu", 4096, NULL, 3, NULL, 0);
#endif
#if ENABLE_GPS
  xTaskCreatePinnedToCore(TaskGps, "TaskGps", 3072, NULL, 1, NULL, 0);
#endif
  xTaskCreatePinnedToCore(TaskComms, "TaskComms", 8192, NULL, 1, NULL, 0); /* 8 KB: portal web usa String */

  Serial.printf("[APP] EchoMap fw %s iniciado: RGB + 2 motores de vibracao%s%s%s.\n", FW_VERSION,
                ENABLE_GPS ? " + GPS" : "", ENABLE_IMU ? " + MPU-6050" : "", ENABLE_MQTT ? " + MQTT" : "");
}

void loop() {
  vTaskDelay(pdMS_TO_TICKS(1000));
}
