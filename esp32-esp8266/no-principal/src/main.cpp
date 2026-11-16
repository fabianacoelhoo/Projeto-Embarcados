/*=====================================================*/
/* EchoMap - No Principal (prototipo de bancada)         */
/* ESP32 + FreeRTOS                                      */
/* 2x HC-SR04 + potenciometro + botao + LED RGB + 2 buzzers */
/* + GPS NEO-6M (UART2) + MPU-6050 (I2C)                    */
/*=====================================================*/

#include <Arduino.h>
#include <math.h>
#include "config.h"
#include "imu_detector.h"

#if ENABLE_GPS
#include <TinyGPS++.h>
#endif

#if ENABLE_IMU
#include <Wire.h>
#endif

#if ENABLE_MQTT
#include <WiFi.h>
#include <PubSubClient.h>
#endif

/*=====================================================*/
/* Tipos                                                 */
/*=====================================================*/
enum Mode { MODE_RADAR = 0, MODE_SIM360 = 1, MODE_SELFTEST = 2 };
enum EventType { EVT_NEAR_MISS, EVT_CRASH, EVT_FALL, EVT_IMPACT };

struct SideState {
  float rawCm = -1;
  float filteredCm = -1;
  bool inRange = false; /* alguem confirmado dentro de BUZZER_START_CM */
  uint8_t nearHits = 0;
  uint8_t farHits = 0;
};

struct SensorState {
  SideState left;
  SideState right;
  float potNormalized = 0;
};

/* menor distancia valida entre os dois lados (-1 se nenhum detectou nada) */
float closestCm(const SensorState &s) {
  if (s.left.filteredCm < 0) return s.right.filteredCm;
  if (s.right.filteredCm < 0) return s.left.filteredCm;
  return min(s.left.filteredCm, s.right.filteredCm);
}

struct AppState {
  Mode mode = MODE_RADAR;
  float lastThr = DIST_MIN_CM;
  float lastAngle = 0;
  float buzzVolL = 0; /* volume atual de cada buzzer (0..1), so para telemetria */
  float buzzVolR = 0;
};

struct AppEvent {
  EventType type;
  float value;  /* cm para NEAR_MISS, g para FALL/IMPACT */
  uint32_t t;
  char side; /* 'L'/'R' para NEAR_MISS, '-' quando nao se aplica */
};

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

#if ENABLE_MQTT
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
#endif

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

void computeSim360(const SensorState &s, float &r, float &g, float &b) {
  float closest = closestCm(s);
  float magnitude = 0.0f;
  if (closest >= 0) {
    float ref = DIST_MAX_CM * 0.5f;
    magnitude = constrain((ref - closest) / ref, 0.0f, 1.0f);
  }

  if (magnitude > 0.5f) {
    r = 1.0f; g = 0.0f; b = 1.0f; /* magenta: obstaculo perto */
  } else {
    r = 0.0f; g = 0.0f; b = 1.0f; /* azul: varredura normal */
  }
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
/* Saida: buzzers (1 por sensor, canal LEDC dedicado)    */
/*=====================================================*/
/* frequencia fixa (configurada no setup); o volume muda pelo duty. A amplitude da
   fundamental de uma onda quadrada e proporcional a sin(pi * duty): 50% e o maximo */
void setBuzzerVolume(uint8_t channel, float volume) {
  uint32_t duty = 0;
  if (volume > 0.0f) {
    float dutyFraction = asinf(constrain(volume, 0.0f, 1.0f)) / PI; /* 0..0.5 */
    duty = (uint32_t)(dutyFraction * 1024.0f);
  }
  ledcWrite(channel, duty);
}

float buzzerVolume(const SideState &side, float prevVolume) {
  if (!side.inRange) return 0.0f;
  if (side.filteredCm < 0) return prevVolume; /* leitura perdida isolada: mantem o volume */
  float t = (BUZZER_START_CM - side.filteredCm) / (BUZZER_START_CM - BUZZER_FULL_CM);
  t = constrain(t, 0.0f, 1.0f);
  return BUZZER_MIN_VOLUME + t * (1.0f - BUZZER_MIN_VOLUME);
}

/*=====================================================*/
/* Task 1 - Sensores (2x HC-SR04, potenciometro)         */
/*=====================================================*/
void updateSide(SideState &side, float raw) {
  if (raw < 0) {
    side.rawCm = -1;
    side.filteredCm = -1;
  } else {
    side.rawCm = raw;
    side.filteredCm = (side.filteredCm < 0) ? raw : (side.filteredCm * 0.7f + raw * 0.3f);
  }

  /* liga/desliga do buzzer usa a leitura bruta (sem atraso do filtro), com histerese
     e confirmacao por leituras seguidas para ignorar ecos isolados */
  float limit = side.inRange ? (BUZZER_START_CM + BUZZER_HYST_CM) : BUZZER_START_CM;
  bool near = (raw >= 0 && raw <= limit);
  if (near) {
    side.farHits = 0;
    if (side.nearHits < BUZZER_CONFIRM_SAMPLES) side.nearHits++;
    if (side.nearHits >= BUZZER_CONFIRM_SAMPLES) side.inRange = true;
  } else {
    side.nearHits = 0;
    if (side.farHits < BUZZER_CONFIRM_SAMPLES) side.farHits++;
    if (side.farHits >= BUZZER_CONFIRM_SAMPLES) side.inRange = false;
  }
}

void TaskSensors(void *pvParameters) {
  bool wasNearL = false;
  bool wasNearR = false;

  for (;;) {
    /* leitura sequencial com intervalo para evitar eco cruzado entre os dois HC-SR04 */
    float rawL = readDistanceCm(PIN_TRIG_L, PIN_ECHO_L);
    vTaskDelay(pdMS_TO_TICKS(SENSOR_GAP_MS));
    float rawR = readDistanceCm(PIN_TRIG_R, PIN_ECHO_R);

    int potRaw = analogRead(PIN_POT);

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    updateSide(sensorState.left, rawL);
    updateSide(sensorState.right, rawR);
    sensorState.potNormalized = potRaw / 4095.0f;
    float filteredL = sensorState.left.filteredCm;
    float filteredR = sensorState.right.filteredCm;
    xSemaphoreGive(stateMutex);

    bool isNearL = (filteredL >= 0 && filteredL < NEAR_MISS_CM);
    if (isNearL && !wasNearL) {
      AppEvent evt{EVT_NEAR_MISS, filteredL, millis(), 'L'};
      xQueueSend(eventQueue, &evt, 0);
    }
    wasNearL = isNearL;

    bool isNearR = (filteredR >= 0 && filteredR < NEAR_MISS_CM);
    if (isNearR && !wasNearR) {
      AppEvent evt{EVT_NEAR_MISS, filteredR, millis(), 'R'};
      xQueueSend(eventQueue, &evt, 0);
    }
    wasNearR = isNearR;

    vTaskDelay(pdMS_TO_TICKS(SENSOR_PERIOD_MS));
  }
}

/*=====================================================*/
/* Task 2 - Botao (clique curto = modo, longo = CRASH)   */
/*=====================================================*/
void TaskButton(void *pvParameters) {
  for (;;) {
    if (xSemaphoreTake(buttonSemaphore, portMAX_DELAY) == pdTRUE) {
      vTaskDelay(pdMS_TO_TICKS(BUTTON_DEBOUNCE_MS));
      if (digitalRead(PIN_BUTTON) != LOW) continue; /* ruido */

      uint32_t pressStart = millis();
      while (digitalRead(PIN_BUTTON) == LOW) {
        vTaskDelay(pdMS_TO_TICKS(10));
      }
      uint32_t heldMs = millis() - pressStart;

      if (heldMs >= BUTTON_LONGPRESS_MS) {
        AppEvent evt{EVT_CRASH, 0, millis(), '-'};
        xQueueSend(eventQueue, &evt, 0);
        crashFlashUntil = millis() + CRASH_FLASH_MS;
      } else {
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        appState.mode = (Mode)((appState.mode + 1) % 3);
        xSemaphoreGive(stateMutex);
      }
    }
  }
}

/*=====================================================*/
/* Task 3 - LED RGB (status / proximidade)               */
/*=====================================================*/
void TaskStatusLed(void *pvParameters) {
  bootFlash();

  for (;;) {
    uint32_t now = millis();

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    SensorState s = sensorState;
    Mode mode = appState.mode;
    xSemaphoreGive(stateMutex);

    float thr = DIST_MIN_CM + s.potNormalized * (DIST_MAX_CM - DIST_MIN_CM);
    float angle = 0.0f;
    float r = 0, g = 0, b = 0;

    if (now < crashFlashUntil) {
      computeCrashFlash(r, g, b);
    } else if (mode == MODE_RADAR) {
      computeRadar(s, thr, now, r, g, b);
    } else if (mode == MODE_SIM360) {
      angle = s.potNormalized * 360.0f;
      computeSim360(s, r, g, b);
    } else {
      computeSelftest(now, r, g, b);
    }

    setRGB(r, g, b);

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    appState.lastThr = thr;
    appState.lastAngle = angle;
    xSemaphoreGive(stateMutex);

    vTaskDelay(pdMS_TO_TICKS(STATUS_PERIOD_MS));
  }
}

/*=====================================================*/
/* Task 4 - Buzzers (1 por sensor)                       */
/*=====================================================*/
void TaskBuzzer(void *pvParameters) {
  /* cada buzzer responde so ao ultrassonico do seu lado; mais perto = mais alto */
  float volL = 0.0f;
  float volR = 0.0f;

  for (;;) {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    SideState left = sensorState.left;
    SideState right = sensorState.right;
    xSemaphoreGive(stateMutex);

    volL = buzzerVolume(left, volL);
    volR = buzzerVolume(right, volR);
    setBuzzerVolume(BUZZER_CHANNEL_L, volL);
    setBuzzerVolume(BUZZER_CHANNEL_R, volR);

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    appState.buzzVolL = volL;
    appState.buzzVolR = volR;
    xSemaphoreGive(stateMutex);

    vTaskDelay(pdMS_TO_TICKS(STATUS_PERIOD_MS));
  }
}

/*=====================================================*/
/* Task 6 - GPS NEO-6M (UART2, sentencas NMEA)           */
/*=====================================================*/
#if ENABLE_GPS
void TaskGps(void *pvParameters) {
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

bool mpuWrite(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool mpuRead(uint8_t reg, uint8_t *buf, size_t len) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint16_t)MPU_ADDR, (uint8_t)len) != len) return false;
  for (size_t i = 0; i < len; i++) buf[i] = (uint8_t)Wire.read();
  return true;
}

bool mpuInit() {
  uint8_t who = 0;
  if (!mpuRead(MPU_REG_WHO_AM_I, &who, 1)) return false;
  if (who != 0x68) {
    /* clones do GY-521 as vezes respondem 0x70/0x72/0x98 mas funcionam igual */
    Serial.printf("[IMU] WHO_AM_I = 0x%02X (esperado 0x68), seguindo mesmo assim.\n", who);
  }
  return mpuWrite(MPU_REG_PWR_MGMT_1, 0x01) &&   /* acorda, clock do giroscopio X */
         mpuWrite(MPU_REG_SMPLRT_DIV, 9) &&      /* 1 kHz / (1 + 9) = 100 Hz */
         mpuWrite(MPU_REG_CONFIG, 0x03) &&       /* filtro passa-baixa ~44 Hz */
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

void TaskImu(void *pvParameters) {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_FREQ_HZ);

  while (!mpuInit()) {
    Serial.println("[IMU] MPU-6050 nao respondeu (confira SDA 26, SCL 27, 3V3 e GND). Tentando de novo em 2 s...");
    vTaskDelay(pdMS_TO_TICKS(2000));
  }

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
  Serial.printf("[IMU] Pronto. Gravidade de referencia: %.2f %.2f %.2f g\n", gravityRef[0], gravityRef[1], gravityRef[2]);

  const ImuDetectorConfig cfg = {FREEFALL_G, FREEFALL_MIN_MS, FALL_WINDOW_MS, FALL_IMPACT_G,
                                 IMPACT_G, IMU_PEAK_WINDOW_MS, IMU_EVENT_COOLDOWN_MS};
  ImuDetector detector(cfg);
  uint32_t readErrors = 0;
  TickType_t lastWake = xTaskGetTickCount();

  for (;;) {
    float ax, ay, az, gx, gy, gz;
    if (mpuReadMotion(ax, ay, az, gx, gy, gz)) {
      readErrors = 0;
      gx -= gyroBias[0];
      gy -= gyroBias[1];
      gz -= gyroBias[2];
      float g = sqrtf(ax * ax + ay * ay + az * az);

      float peak;
      ImuEvent evt = detector.update(g, millis(), peak);
      if (evt != ImuEvent::None) {
        AppEvent e{evt == ImuEvent::Fall ? EVT_FALL : EVT_IMPACT, peak, (uint32_t)millis(), '-'};
        xQueueSend(eventQueue, &e, 0);
      }

      lp[0] += TILT_FILTER_ALPHA * (ax - lp[0]);
      lp[1] += TILT_FILTER_ALPHA * (ay - lp[1]);
      lp[2] += TILT_FILTER_ALPHA * (az - lp[2]);
      float tilt = tiltFromReferenceDeg(gravityRef, lp[0], lp[1], lp[2]);

      xSemaphoreTake(stateMutex, portMAX_DELAY);
      imuState.ready = true;
      imuState.ax = ax; imuState.ay = ay; imuState.az = az;
      imuState.gx = gx; imuState.gy = gy; imuState.gz = gz;
      imuState.g = g;
      if (g > imuState.gMax) imuState.gMax = g;
      imuState.tiltDeg = tilt;
      xSemaphoreGive(stateMutex);
    } else if (++readErrors == 100) {
      Serial.println("[IMU] Falha de leitura no I2C (1 s sem dados). Confira os fios do MPU-6050.");
      xSemaphoreTake(stateMutex, portMAX_DELAY);
      imuState.ready = false;
      xSemaphoreGive(stateMutex);
    }

    vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(IMU_PERIOD_MS));
  }
}
#endif

/*=====================================================*/
/* Task 5 - Comunicacao (serial JSON + MQTT opcional)    */
/*=====================================================*/
#if ENABLE_MQTT
void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.println("[WiFi] Iniciando conexao...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    vTaskDelay(pdMS_TO_TICKS(500));
  }
  Serial.print("[WiFi] Conectado. IP local: ");
  Serial.println(WiFi.localIP());
}

void conectarMQTT() {
  if (mqttClient.connected()) return;

  mqttClient.setServer(MQTT_BROKER_IP, MQTT_BROKER_PORT);
  String clientId = "echomap-node1-" + String((uint32_t)ESP.getEfuseMac(), HEX);

  if (mqttClient.connect(clientId.c_str())) {
    Serial.println("[MQTT] Conectado ao broker.");
  } else {
    Serial.print("[MQTT] Falha na conexao. Estado: ");
    Serial.println(mqttClient.state());
  }
}
#endif

const char *modeToString(Mode m) {
  switch (m) {
    case MODE_RADAR: return "RADAR";
    case MODE_SIM360: return "SIM360";
    default: return "SELFTEST";
  }
}

void publishTelemetry() {
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  SensorState s = sensorState;
  Mode mode = appState.mode;
  float thr = appState.lastThr;
  float angle = appState.lastAngle;
  float volL = appState.buzzVolL;
  float volR = appState.buzzVolR;
  xSemaphoreGive(stateMutex);

  char buf[220];
  snprintf(buf, sizeof(buf),
           "{\"t\":%lu,\"mode\":\"%s\","
           "\"distL\":%.1f,\"rawL\":%.1f,"
           "\"distR\":%.1f,\"rawR\":%.1f,"
           "\"bzL\":%.2f,\"bzR\":%.2f,"
           "\"thr\":%.0f,\"angle\":%.0f,\"pot\":%.2f}",
           (unsigned long)millis(), modeToString(mode),
           s.left.filteredCm, s.left.rawCm,
           s.right.filteredCm, s.right.rawCm,
           volL, volR,
           thr, angle, s.potNormalized);

  Serial.println(buf);

#if ENABLE_MQTT
  if (mqttClient.connected()) {
    mqttClient.publish(MQTT_TOPIC_TELEMETRY, buf);
  }
#endif
}

void emitEvent(const AppEvent &evt) {
  char buf[96];
  if (evt.type == EVT_NEAR_MISS) {
    snprintf(buf, sizeof(buf), "{\"event\":\"NEAR_MISS\",\"side\":\"%c\",\"value\":%.1f,\"t\":%lu}",
             evt.side, evt.value, (unsigned long)evt.t);
  } else if (evt.type == EVT_FALL || evt.type == EVT_IMPACT) {
    snprintf(buf, sizeof(buf), "{\"event\":\"%s\",\"value\":%.2f,\"unit\":\"g\",\"t\":%lu}",
             evt.type == EVT_FALL ? "FALL" : "IMPACT", evt.value, (unsigned long)evt.t);
  } else {
    snprintf(buf, sizeof(buf), "{\"event\":\"CRASH\",\"t\":%lu}", (unsigned long)evt.t);
  }

  Serial.println(buf);

#if ENABLE_MQTT
  if (mqttClient.connected()) {
    mqttClient.publish(MQTT_TOPIC_EVENTS, buf);
  }
#endif
}

void publishLine(const char *topic, const char *json) {
  Serial.println(json);
#if ENABLE_MQTT
  if (mqttClient.connected()) {
    mqttClient.publish(topic, json);
  }
#endif
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
  publishLine(MQTT_TOPIC_IMU, buf);
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
  publishLine(MQTT_TOPIC_LOCATION, buf);
}
#endif

void TaskComms(void *pvParameters) {
  TickType_t lastWake = xTaskGetTickCount();
  uint32_t lastLocation = 0;

  for (;;) {
#if ENABLE_MQTT
    conectarWiFi();
    conectarMQTT();
    mqttClient.loop();
#endif

    AppEvent evt;
    while (xQueueReceive(eventQueue, &evt, 0) == pdTRUE) {
      emitEvent(evt);
    }

    publishTelemetry();

#if ENABLE_IMU
    publishImu();
#endif

#if ENABLE_GPS
    if (millis() - lastLocation >= LOCATION_PERIOD_MS) {
      lastLocation = millis();
      publishLocation();
    }
#endif

    vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(TELEMETRY_PERIOD_MS));
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

  /* timer dos buzzers configurado uma unica vez (frequencia fixa, 10 bits); dai em diante
     so o duty muda. Tambem evita o ledcWrite(canal, 0) gravar duty 1 em canal sem resolucao */
  ledcSetup(BUZZER_CHANNEL_L, BUZZER_FREQ_HZ, 10);
  ledcSetup(BUZZER_CHANNEL_R, BUZZER_FREQ_HZ, 10);
  ledcWrite(BUZZER_CHANNEL_L, 0);
  ledcWrite(BUZZER_CHANNEL_R, 0);
  ledcAttachPin(PIN_BUZZER_L, BUZZER_CHANNEL_L);
  ledcAttachPin(PIN_BUZZER_R, BUZZER_CHANNEL_R);

  stateMutex = xSemaphoreCreateMutex();
  eventQueue = xQueueCreate(10, sizeof(AppEvent));
  buttonSemaphore = xSemaphoreCreateBinary();

  if (stateMutex == NULL || eventQueue == NULL || buttonSemaphore == NULL) {
    Serial.println("[ERRO] Falha ao criar primitivos do FreeRTOS.");
    while (true) delay(1000);
  }

  attachInterrupt(digitalPinToInterrupt(PIN_BUTTON), buttonISR, FALLING);

  /* Core 1: leitura de sensores e atuacao (timing critico, longe do Wi-Fi) */
  xTaskCreatePinnedToCore(TaskSensors, "TaskSensors", 3072, NULL, 2, NULL, 1);
  xTaskCreatePinnedToCore(TaskStatusLed, "TaskStatusLed", 3072, NULL, 1, NULL, 1);
  xTaskCreatePinnedToCore(TaskBuzzer, "TaskBuzzer", 2048, NULL, 1, NULL, 1);

  /* Core 0: botao, IMU, GPS e comunicacao (serial/MQTT).
     A IMU fica no core 0 para nao interromper o pulseIn() dos HC-SR04 no core 1. */
  xTaskCreatePinnedToCore(TaskButton, "TaskButton", 2048, NULL, 2, NULL, 0);
#if ENABLE_IMU
  xTaskCreatePinnedToCore(TaskImu, "TaskImu", 4096, NULL, 3, NULL, 0);
#endif
#if ENABLE_GPS
  xTaskCreatePinnedToCore(TaskGps, "TaskGps", 3072, NULL, 1, NULL, 0);
#endif
  xTaskCreatePinnedToCore(TaskComms, "TaskComms", 6144, NULL, 1, NULL, 0);

  Serial.println("[APP] EchoMap no principal iniciado (RGB + buzzers + GPS + MPU-6050).");
}

void loop() {
  vTaskDelay(pdMS_TO_TICKS(1000));
}
