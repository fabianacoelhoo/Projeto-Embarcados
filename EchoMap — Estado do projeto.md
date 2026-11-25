# EchoMap — Estado do projeto

Nov 24, 2026 · @Jerônimo

## Resumo

O EchoMap funciona de ponta a ponta na bancada: a placa lê os dois ultrassônicos, o MPU e o GPS e manda tudo ao painel, que mostra as 7 telas do protótipo. Em 24/11, com o firmware 1.3.0 gravado, o painel registrou 5.188 leituras de distância, 953 posições de GPS (7 satélites, precisão de 5 m) e 568 ocorrências.

Três pontos impedem chamar de pronto:

- **O Wi-Fi conecta, mas o MQTT não.** A placa está na rede JBR&INGRID e continua procurando o servidor no IP fixo da rede antiga (172.26.121.65). Hoje os dados chegam só pelo cabo USB, e 8 alertas estão parados na fila da placa.
- **Nada foi commitado.** Cerca de 2.900 linhas novas em 22 arquivos, mais 8 arquivos novos, existem só na pasta local.
- **Não há acesso remoto nem login.** O painel só funciona na mesma rede do computador, e qualquer aparelho nessa rede pode mandar comandos à placa.

## Arquitetura e organização

&#91;embedded content: arquitetura: placa, computador, painel e celular\]

A placa e o computador conversam por dois caminhos: MQTT pelo Wi-Fi e Serial pelo cabo USB. Hoje só o cabo funciona, porque a placa procura o servidor no IP da rede anterior.

| Pasta | O que tem |
| --- | --- |
| `esp32-esp8266/no-principal/` | Firmware PlatformIO: `src/main.cpp` (tarefas e sensores), `src/net.cpp` (rede), `include/config.h` (pinos e limiares), `host_test/` (testes da queda) |
| `applications/dashboard/` | Servidor Node.js (`server/`), painel (`public/`), simulador e testes (`tools/`), `config.json` |
| `schematics/` | Diagrama de ligações e tabela de pinos |
| `docs/` | Arquitetura, protótipo de 7 telas, relatório do checkpoint |
| Raiz | `README.md` (como rodar e conectar o Wi-Fi) e `CLAUDE.md` (regra de manter os READMEs atualizados) |

## Funcionalidades

A placa tem 7 tarefas FreeRTOS. O código de rede fica em `net.cpp`, separado do `main.cpp`. A situação de cada parte vem do que o painel registrou em 24/11.

| Parte | O que faz | Situação |
| --- | --- | --- |
| Ultrassônicos (2× HC-SR04) | Distância à esquerda e à direita, filtro, histerese de 10 cm no alerta de quase colisão | Funcionando na placa |
| Buzzers | Volume sobe de 120 cm até 30 cm, um por lado; "Tocar buzzer" pelo painel | Funcionando na placa |
| LED RGB, botão, potenciômetro | Modos Radar, 360° e Autoteste; clique longo envia alerta; 3 cliques abrem o portal de Wi-Fi | Funcionando na placa |
| MPU-6050 (queda e batida) | 200 leituras/s; queda confirmada pela postura 2 s depois, para não confundir com pulo ou corrida | Funcionando na placa |
| GPS NEO-6M | Posição 1×/s, precisão estimada, satélites | Funcionando na placa |
| Teste dos sensores | Comando `sensores` e botão "Testar sensores": mede eco, tensão no divisor e fios trocados | Pronto, falta usar na placa |
| Wi-Fi configurável | Pelo painel (cabo ou Wi-Fi), pelo portal do celular ou pela Serial; testa a rede antes de salvar | Funcionando na placa |
| Conexão MQTT com o painel | Reconexão sem travar, fila de alertas, latência baixa | Com problema |
| Servidor achado sozinho | Anúncio UDP do painel; a placa usa "auto" e lembra o último servidor | Pronto, falta usar na placa |
| Medição de latência | Ping a cada 5 s, mostrado na tela Dispositivo | Só testado em simulação |
| Servidor: broker, banco, regras | Broker MQTT embutido, SQLite, zonas seguras, sem sinal, bateria | Funcionando na placa |
| Servidor: cabo USB automático | Acha a placa nas portas USB, troca de porta, "Liberar a porta" para gravar | Funcionando na placa |
| Servidor: rede do computador | Preenche o nome da rede e a senha salva do Windows, avisa sobre 5 GHz | Só testado em simulação |
| Painel: 7 telas | Início, Ao vivo, Ocorrências e detalhe, Mapa, Movimento, Dispositivo | Funcionando na placa |
| Painel: configurar Wi-Fi | Selo do canal, formulário só com conexão, QR code do portal | Só testado em simulação |
| Ocorrências | Quase colisão, queda, batida, botão, sem sinal; "Ciente" e linha do tempo | Funcionando na placa |
| Mapa e trajeto | Posição e trajeto no mapa | Funcionando na placa |
| Zonas seguras | Alerta ao sair do círculo definido no `config.json` | Só testado em simulação |
| Simulador | Imita a placa (Wi-Fi, comandos, teste de sensores) para trabalhar sem hardware | Pronto, falta usar na placa |

## Validação

A lógica de queda e o cabo USB têm testes automáticos que rodam sem placa. O resto foi validado com a placa na bancada ou com o simulador, sem rotina repetível.

| Teste | Como roda | Resultado |
| --- | --- | --- |
| Detector de queda e batida | `host_test/test_imu_detector.cpp` no PC (g++) | 17 cenários passam, incluindo pulo, corrida, degrau e queda de lado |
| Cabo USB e rede do computador | `npm test` no painel | 20 cenários passam: detecção, hot-plug, várias placas, porta ocupada, saídas reais do `netsh` e do `nmcli` |
| Compilação do firmware | Build no PlatformIO | 1.3.0 compila e roda na placa (RAM 14%, flash cerca de 61%) |
| Painel e servidor ponta a ponta | Simulador + navegador automatizado | Telas sem erros no computador e no celular, temas claro e escuro |
| Configurar Wi-Fi pelo cabo | Placa falsa numa porta serial virtual | Rede errada, rede certa e mensagens da placa em tempo real funcionaram |
| Sensores, MPU e GPS | Placa real, dados do painel em 24/11 | Distâncias, quedas (3), batidas (6) e 953 posições registradas |

**Ainda não exercitado na placa real:** o teste dos sensores, o portal pelo celular com 3 cliques, a descoberta automática do servidor e a medição de latência. As duas últimas dependem do MQTT, que hoje não conecta.

## Gaps e riscos

O maior risco imediato é perder o trabalho: nada foi commitado. O maior gap de produto é o MQTT fora do ar, que deixa o painel dependente do cabo.

| Gap | Efeito hoje | Gravidade |
| --- | --- | --- |
| Servidor fixo no IP da rede antiga (`172.26.121.65` no `secrets.h`) | MQTT não conecta na rede JBR\&INGRID; sem latência, sem comandos pelo Wi-Fi; 8 alertas presos na fila | Alta |
| Trabalho não commitado | Cerca de 2.900 linhas e 8 arquivos novos só na pasta local; o `git diff` sem filtro mostra todos os arquivos alterados por causa do fim de linha (CRLF) | Alta |
| Painel e API sem login | Qualquer aparelho na mesma rede abre o painel e manda comandos, inclusive trocar o Wi-Fi da placa; o broker MQTT não tem senha | Alta |
| Excesso de alertas de quase colisão | 546 em cerca de 8 h; quando a leitura falha e volta, o alerta dispara de novo | Alta |
| Sem acesso remoto | O painel só funciona na rede do computador; não dá para acompanhar de outro lugar | Média |
| Zona segura de exemplo (São Paulo) | Com o GPS real em Recife, o mapa sempre diz "fora das zonas"; zonas só se editam no `config.json` | Média |
| Sem bateria nem medição de carga | A placa vive no USB; o modo de baixa latência gasta cerca de 80 mA a mais | Média |
| Alerta tátil (motores de vibração) | Ainda são buzzers; a troca está planejada desde o checkpoint | Média |
| GPS só ao ar livre | Dentro de casa não há posição; a localização do celular como segunda fonte não foi feita | Média |
| Queda calibrada para o tronco | Preso no pulso, a confirmação pela postura falha; precisa de `FALL_TILT_DEG 0` | Baixa |
| Documentação em `docs/` desatualizada | Diagrama de arquitetura e relatório não mostram portal, descoberta, cabo automático nem as 7 telas | Baixa |
| Pasta `Claude outputs/` na raiz | Não está no `.gitignore`; entra no repositório num `git add .` | Baixa |

## Pendências e próximos passos

Os dois primeiros itens levam minutos e destravam o resto: reconectar o MQTT e commitar.

**Agora (minutos)**

- [ ] Ligar o servidor automático: digitar `servidor auto` no Serial Monitor e trocar `MQTT_BROKER_IP` para `"auto"` no `secrets.h`
- [ ] Commitar em um branch, com um `.gitattributes` para fixar o fim de linha e a pasta `Claude outputs/` no `.gitignore`
- [ ] Trocar a zona segura de exemplo pelas coordenadas reais no `config.json`
- [ ] Rodar "Testar sensores" e o portal pelo celular (3 cliques) uma vez na placa real

**Esta semana**

- [ ] Limitar o alerta de quase colisão: intervalo mínimo por lado e alerta só se o obstáculo continuar perto
- [ ] Senha no painel e no broker MQTT; comandos como trocar o Wi-Fi só para quem entrou no painel
- [ ] Editar zonas seguras pela tela Mapa, sem mexer no `config.json`
- [ ] Atualizar `docs/` (diagrama de arquitetura e relatório) com o estado atual

**Próxima etapa**

- [ ] Acesso remoto: broker MQTT na nuvem (HiveMQ ou EMQX) ou túnel do PC (Tailscale), com TLS e menos dados por hora no 4G
- [ ] Motores de vibração no lugar dos buzzers
- [ ] Bateria, regulador e medição de carga (o painel já gera "bateria baixa")
- [ ] Localização do celular como segunda fonte, para quando o GPS não tiver sinal
