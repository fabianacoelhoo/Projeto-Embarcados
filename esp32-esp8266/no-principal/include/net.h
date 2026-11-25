#pragma once
/*=====================================================*/
/* EchoMap - rede (Wi-Fi, MQTT, portal de configuracao) */
/*                                                       */
/* Jeitos de conectar o EchoMap a um Wi-Fi:              */
/*  1. Pelo painel (placa no USB ou ja no Wi-Fi):        */
/*     Dispositivo -> Wi-Fi, digita rede e senha.        */
/*  2. Pelo celular: 3 cliques rapidos no botao abrem a  */
/*     rede "EchoMap-<id>"; a pagina abre sozinha.       */
/*  3. Pela Serial: wifi "Minha rede" "minha senha".     */
/* Toda rede nova e TESTADA antes de salvar: se nao      */
/* conectar, o EchoMap volta para a anterior e diz o     */
/* motivo (senha incorreta, rede nao encontrada...).     */
/* O servidor e achado sozinho (anuncio UDP) e lembrado. */
/* Credenciais: NVS (o que foi salvo) > secrets.h.       */
/* Sem conectar em 15 s: abre o portal sozinho, e a      */
/* Serial segue aceitando comandos (status em JSON).     */
/* Nada aqui bloqueia: netService() a cada ~20 ms.       */
/*=====================================================*/
#include <stddef.h>
#include <stdint.h>

enum NetChannel : uint8_t { CH_TELEMETRY, CH_EVENTS, CH_LOCATION, CH_IMU, CH_STATUS, CH_PONG, CH_DIAG, CH_COUNT };

/* comando que nao e de rede (ex.: "locate", "diag"); ping, portal, wifi e esquecer ficam aqui dentro.
   json e nullptr quando veio como texto digitado na Serial. Devolve true se reconheceu o comando. */
typedef bool (*NetCommandHandler)(const char *cmd, const char *json);

void netBegin(bool forcePortal);
void netService();
bool netPublish(NetChannel ch, const char *json);
void netPublishEvent(const char *json); /* guarda e reenvia se o servidor estiver fora */
void netOnCommand(NetCommandHandler handler);
void netRequestPortal();                /* seguro de chamar de qualquer task (ex.: clique triplo) */
void netHandleLine(const char *line);   /* linha digitada na Serial (comandos de texto ou JSON) */
bool netPortalActive();
bool netTesting();
bool netTakeStatusRequest();            /* true quando o status deve sair agora (comando "status" ou mudanca de rede) */
bool netMqttConnected();
const char *netDeviceId();
/* acrescenta ,"ip":...,"rssi":... ao JSON de status; devolve quantos caracteres escreveu */
int netStatusAppend(char *buf, size_t len);
