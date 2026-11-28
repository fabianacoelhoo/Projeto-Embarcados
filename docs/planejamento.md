# Planejamento até a entrega final

As tarefas são acompanhadas nas [Issues](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues), divididas em dois marcos: [Check Point (17/11)](https://github.com/fabianacoelhoo/Projeto-Embarcados/milestone/1) (concluídas) e [Entrega final](https://github.com/fabianacoelhoo/Projeto-Embarcados/milestone/2) (abertas).

Etiquetas: `firmware`, `hardware`, `back-end`, `front-end`, `infra`, `documentação`.

## Concluído até o check point ([issues #1–#8](https://github.com/fabianacoelhoo/Projeto-Embarcados/milestone/1?closed=1))

- [x] Firmware do nó principal com FreeRTOS (7 tasks em 2 núcleos, mutex, fila e semáforo)
- [x] Leitura dos 2 HC-SR04 com filtro e proteção contra eco cruzado
- [x] Vibração proporcional à distância (2 motores MV50), LED RGB de status, botão com modos e `CRASH`
- [x] Telemetria e eventos em JSON (Serial e MQTT)
- [x] Back-end com broker MQTT embutido, API REST, WebSocket e SQLite
- [x] Regras de zona segura, impacto, bateria baixa e dispositivo offline
- [x] Dashboard web em tempo real e simulador da ESP32
- [x] Protótipo de média fidelidade do app dos responsáveis
- [x] Esquemático (diagrama de ligações) e diagrama de arquitetura
- [x] Organização do repositório e READMEs

## Concluído depois do check point

- [x] GPS NEO-6M no firmware: posição 1×/s em `echomap/node1/location` ([#10](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/10), falta testar na placa)
- [x] MPU-6050 no firmware: queda (`FALL`), batida (`IMPACT`) e inclinação em `echomap/node1/imu` ([#11](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/11), falta testar na placa)

## A fazer

| Issue | Tarefa | Etiqueta |
|---|---|---|
| [#9](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/9) | Testar a publicação MQTT por Wi-Fi com a placa real (`ENABLE_MQTT 1`) e o dashboard | firmware |
| [#10](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/10) | Testar o GPS na placa (posição aparecendo no mapa) | firmware |
| [#11](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/11) | Testar queda e batida com o MPU-6050 montado e ajustar os limiares se precisar | firmware |
| [#24](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/24) | Motores de vibração MV50 no lugar do aviso sonoro (alerta tátil) — firmware 2.0 | firmware, hardware |
| [#12](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/12) | Assinar `echomap/<id>/cmd` e vibrar o dispositivo por comando do painel | firmware |
| [#13](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/13) | Publicar `echomap/<id>/status` (bateria, RSSI, versão) | firmware |
| [#14](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/14) | Alimentação por bateria e medição do nível de carga | hardware |
| [#15](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/15) | Montar o circuito completo e atualizar a foto e o esquemático | hardware |
| [#16](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/16) | Cadastrar zonas seguras e limiares pela API (hoje ficam no `config.json`) | back-end |
| [#17](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/17) | Notificar os responsáveis fora do navegador (push, e-mail ou SMS) | back-end |
| [#18](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/18) | Botão "Vibrar para localizar" e tela de ajustes no dashboard, conforme o protótipo | front-end |
| [#19](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/19) | Versão mobile do painel seguindo o protótipo | front-end |
| [#20](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/20) | Avaliar a hospedagem do back-end/broker na nuvem (AWS) | infra |
| [#21](https://github.com/fabianacoelhoo/Projeto-Embarcados/issues/21) | Todos os integrantes com commits e o README final | documentação |
