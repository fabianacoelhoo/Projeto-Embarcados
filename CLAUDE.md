# Regras do projeto EchoMap

- **Sempre atualizar os READMEs** junto com qualquer mudança de funcionamento, configuração, comandos, pinos ou telas:
  - `README.md` (raiz): como rodar, como conectar o EchoMap ao Wi-Fi, status do projeto;
  - `esp32-esp8266/README.md`: firmware (tasks, tópicos MQTT, comandos, limiares);
  - `applications/dashboard/README.md`: servidor, contrato de dados, API e telas;
  - `schematics/README.md`: tabela de pinos (quando mudar o `config.h`).
- Firmware: o core Arduino da ESP32 compila em **C++11** (sem valor padrão em campo de struct inicializada com `{...}`).
- No Windows os arquivos ficam com fim de linha **CRLF**; o `.gitattributes` (`* text=auto`) guarda LF dentro do repositório, então trocar CRLF/LF não aparece como mudança.
- A pasta `Claude outputs/` nunca entra no Git.
- Textos para o usuário em português do Brasil.
- Lógica nova do firmware (detectores, máquinas de estado, cálculos) vai em header C++ puro em `include/` (sem `Arduino.h`/FreeRTOS), com teste em `host_test/`.
- Banco do painel: mudança de schema só em `migrate()` (`server/db.js`), sempre idempotente (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` só se a coluna não existir).
