#pragma once
/* Modelo: copie para include/secrets.h e preencha. O secrets.h fica fora do git.
 * Opcional: sem ele, configure o Wi-Fi pelo portal do proprio EchoMap (rede "EchoMap-XXXX"). */
#define WIFI_SSID "SUA_REDE_WIFI"
#define WIFI_PASSWORD "SUA_SENHA_WIFI"
#define MQTT_BROKER_IP "auto" /* "auto" = descobre o PC do dashboard; ou o IP dele */
/* Broker com senha: os mesmos MQTT_USER/MQTT_PASS do applications/dashboard/.env.
 * Deixe vazios ("") se o broker estiver aberto (o painel avisa no terminal qual e o caso). */
#define MQTT_USER ""
#define MQTT_PASS ""
