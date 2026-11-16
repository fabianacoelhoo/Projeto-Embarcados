# Planejamento até a entrega final

As tarefas são acompanhadas nas [Issues](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues), divididas em dois marcos: [Check Point (17/11)](https://github.com/fabianacoelhoo/Projeto-Embarcados/milestone/1) (concluídas) e [Entrega final](https://github.com/fabianacoelhoo/Projeto-Embarcados/milestone/2) (abertas).

Etiquetas: `firmware`, `hardware`, `back-end`, `front-end`, `infra`, `documentação`.

## Concluído até o check point ([issues #1–#8](https://github.com/fabianacoelhoo/Projeto-Embarcados/milestone/1?closed=1))

- [x] Firmware do nó principal com FreeRTOS (5 tasks em 2 núcleos, mutex, fila e semáforo)
- [x] Leitura dos 2 HC-SR04 com filtro e proteção contra eco cruzado
- [x] Buzzers com volume proporcional à distância, LED RGB de status, botão com modos e `CRASH`
- [x] Telemetria e eventos em JSON (Serial e MQTT)
- [x] Back-end com broker MQTT embutido, API REST, WebSocket e SQLite
- [x] Regras de zona segura, impacto, bateria baixa e dispositivo offline
- [x] Dashboard web em tempo real e simulador da ESP32
- [x] Protótipo de média fidelidade do app dos responsáveis
- [x] Esquemático (diagrama de ligações) e diagrama de arquitetura
- [x] Organização do repositório e READMEs

## A fazer

| Issue | Tarefa | Etiqueta |
|---|---|---|
| [#9](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/9) | Testar a publicação MQTT por Wi-Fi com a placa real (`ENABLE_MQTT 1`) e o dashboard | firmware |
| [#10](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/10) | Integrar o GPS NEO-6M (UART2, GPIO 16/17) e publicar em `echomap/<id>/location` | firmware |
| [#11](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/11) | Integrar o MPU-6050 (I²C, GPIO 26/27), publicar em `echomap/<id>/imu` e gerar o evento `FALL` | firmware |
| [#12](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/12) | Assinar `echomap/<id>/cmd` e tocar o buzzer por comando do painel | firmware |
| [#13](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/13) | Publicar `echomap/<id>/status` (bateria, RSSI, versão) | firmware |
| [#14](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/14) | Alimentação por bateria e medição do nível de carga | hardware |
| [#15](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/15) | Montar o circuito completo e atualizar a foto e o esquemático | hardware |
| [#16](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/16) | Cadastrar zonas seguras e limiares pela API (hoje ficam no `config.json`) | back-end |
| [#17](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/17) | Notificar os responsáveis fora do navegador (push, e-mail ou SMS) | back-end |
| [#18](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/18) | Botão "Tocar buzzer" e tela de ajustes no dashboard, conforme o protótipo | front-end |
| [#19](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/19) | Versão mobile do painel seguindo o protótipo | front-end |
| [#20](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/20) | Avaliar a hospedagem do back-end/broker na nuvem (AWS) | infra |
| [#21](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/21) | Todos os integrantes com commits e o README final | documentação |
