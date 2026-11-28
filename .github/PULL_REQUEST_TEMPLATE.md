## O que muda

<!-- Uma ou duas frases: o que este PR faz e por quê. Cite a issue (ex.: Closes #12). -->

## Como testei

- [ ] Testes C++ do firmware (`esp32-esp8266/no-principal/host_test`, `g++ -Wall -Wextra`)
- [ ] Build do PlatformIO sem avisos novos (RAM/Flash: ___ / ___)
- [ ] `npm test` em `applications/dashboard`
- [ ] `npm run check:all` (higiene do repositório, sem segredos rastreados)
- [ ] Testado na placa ou com o simulador (`npm run simulate:all`)

## Documentação

- [ ] READMEs atualizados (e `docs/protocol.md`, se mudou mensagem, comando ou ocorrência)
- [ ] Nenhum segredo, `.env`, `secrets.h` ou banco `.db` no commit
