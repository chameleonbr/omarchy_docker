# avila.docker — Omarchy shell plugin

Mosaico de containers na área do ícone do bar, uma célula por container, com
CPU e memória rodando ao lado.

## Problema

`docker ps` numa máquina de dev não cabe numa tela. Esta máquina roda 20
containers em 6 projetos compose:

| Projeto compose | Containers |
|---|---|
| `web-shop` | chatbot-api, api, redis, azurite, chatbot-ui, nginx, adminer |
| `metrics` | agent, collector, sidekiq, flaky, redis |
| `metrics` | api, docling |
| `metrics` | app (collector), qdrant |
| `web-shop` | database, redis |
| _(sem projeto)_ | scratchpad, scratchpad |

Um container em `Restarting` no meio disso passa despercebido por horas. É
exatamente o que o widget resolve: ver sem procurar, sem ler número nenhum.

## Escopo

**v1 faz:** mosaico de estado, CPU/memória agregada rodando, agrupamento por
stack, restart/stop/start por container, log e shell por container, e abrir o
lazydocker já escopado no stack clicado.

**v1 não faz:** hosts remotos, Swarm/Kubernetes, `exec` de shell, gestão de
imagens/volumes/redes, editar compose, histórico/gráfico de métrica.

## Widget do bar — mosaico

Ocupa a área de ícone do bar, do mesmo tamanho que o ícone do relógio ocupa.
Essa área é **particionada em uma célula por container**. Nada de número,
nada de texto: a forma do mosaico já diz quantos containers existem, e a cor
de cada célula diz o estado de cada um.

### Regra de partição

O bar é uma faixa horizontal, então o mosaico cresce para os lados, não em
quadrado. Grade quadrada desperdiça a largura e encolhe as células.

```
linhas = min(maxLinhas, ceil(sqrt(N / 3)))
maxLinhas = floor((altura + gap) / (celulaMin + gap))   // celulaMin = 5px
```

Com os ~16px de área de ícone de um bar de 26px, `maxLinhas` dá 2. As células
são distribuídas de forma **balanceada** entre as linhas — nunca com buraco,
nunca com uma célula esticada sozinha.

| N | Distribuição |
|---|---|
| 1, 2, 3 | uma linha (2 containers = 2 barras) |
| 4 | 2 e 2 (quatro quadrados) |
| 5 | 3 e 2 |
| 7 | 4 e 3 |
| 20 | 10 e 10 |

A primeira versão usava grade quadrada: 7 células viravam linhas de 3, 3 e 1, e
aquela célula solitária esticada na largura inteira era o que fazia o widget
parecer acidental.

### Ordem das células — estável, sempre

Ordenadas por `(projeto, serviço, nome)`. **Nunca** por estado.

Ordenar por estado faz as células trocarem de lugar toda vez que algo muda, e
aí o mosaico vira ruído: não dá pra aprender "a célula de baixo à direita é o
redis". A posição fixa é o que torna o widget legível de relance.

Container que aparece ou some re-particiona a grade — inevitável, e por isso o
refresh é debounced.

### Cor da célula

| Estado | Cor |
|---|---|
| running, healthy ou sem healthcheck | `Color.foreground` |
| unhealthy, restarting, paused | `Color.accent` |
| exited ≠ 0, dead | `Color.urgent` |
| exited 0, created | `Color.foreground` a 35% de opacidade |

Célula em `restarting` pulsa devagar (2s). É o único movimento do widget —
justamente para o caso que mais passa despercebido hoje.

### Limite de células

`maxCells` (default 24). Acima disso, cada célula passa a valer um **stack**
em vez de um container, com a cor do pior estado do grupo. 20 containers em 6
stacks vira uma grade 3×2 legível em vez de 5×4 de células de 4px.

Se mesmo assim a célula ficar abaixo de 3px, cai pra bloco único com a cor do
pior estado global. Mosaico ilegível é pior que ausência de mosaico.

`groupBy: auto | container | stack` deixa forçar qualquer um dos dois.

## Widget do bar — métrica rodando

Ao lado do mosaico, um label curto que **alterna** entre as métricas ativas a
cada `metricRotateMs` (default 4000):

```
15%  →  3.2GB  →  15%  →  ...
```

`metrics` é lista ordenada, default `["cpu","mem"]`. Disponíveis: `cpu`
(soma de `CPUPerc`), `mem` (soma do usado em `MemUsage`), `memPerc`, `net`,
`count` (`19/20`).

Transição por fade curto, sem deslizar. Largura do label é fixa (reservada
pela maior string possível de cada métrica) — label que muda de largura
empurra todos os outros widgets do bar a cada 4 segundos.

`metrics: []` desliga o label e deixa só o mosaico.

## Interações

- esquerdo: abre/fecha o popup (ou vai direto ao lazydocker, se
  `primaryAction = lazydocker`)
- meio: lazydocker do daemon inteiro
- direito: abre `dockerUrl` no navegador, ou refresh se não houver URL
- scroll sobre o widget: adianta a rotação da métrica

Tooltip: uma linha por stack degradada — `metrics: flaky restarting`.

## Popup

Uma seção por projeto compose, ordenada: stacks degradadas primeiro, depois
alfabética. Containers sem label de projeto caem num grupo `(avulsos)` no fim.

Cada linha: ponto de estado · nome do serviço · imagem (encurtada) · uptime ·
**CPU% · memória** · portas publicadas.

Ações por linha: **restart**, **stop**/**start**, **logs**. Ações no cabeçalho
da seção aplicam ao stack inteiro. Cabeçalho mostra `5/6`, o pior estado do
grupo e a soma de CPU/memória do stack.

## Dados

Duas fontes, com custos muito diferentes. Misturar as duas é o erro que mata
o plugin.

### Estado — barato, em tempo real

```
docker ps -a --no-trunc --format '{{json .}}'
```

Campos usados (verificados nesta máquina): `Names`, `State`, `Status`,
`HealthStatus`, `Image`, `Ports`, `RunningFor`, `Labels`, `ID`.

Agrupamento vem dos labels, nunca de heurística sobre o nome:
`com.docker.compose.project` e `com.docker.compose.service`. Nesta máquina
`web-shop-db` pertence a `web-shop` e `collector` a `metrics` —
qualquer parsing de nome erraria os dois.

Atualização híbrida:

1. `docker events --format '{{json .}}'` num `Process` longo — stream de
   mudanças, custo ~zero em repouso.
2. Evento chega → refresh com debounce de 300ms (um `docker compose up` dispara
   dezenas de eventos em rajada; um refresh só resolve).
3. Timer de segurança a cada 60s, caso o stream morra silenciosamente.
4. Reconexão com backoff 1s → 2s → 4s, teto 30s.

### Métricas — caro, cadência própria

```
docker stats --no-stream --format '{{json .}}'
```

Campos: `Name`, `ID`, `CPUPerc`, `MemUsage`, `MemPerc`, `NetIO`, `BlockIO`, `PIDs`.

**Medido nesta máquina: 2.1 segundos para 20 containers.** Isto não é um
detalhe de performance, é a restrição central do desenho:

- intervalo default **30s** (`statsIntervalMs`, mínimo 10s)
- **nunca** no caminho do `docker events` — evento muda estado, não métrica
- **nunca** enquanto a chamada anterior ainda roda (trava reentrada)
- pausa quando o widget não está visível
- pausa na bateria se `statsOnBattery` estiver desligado (default: desligado)
- popup aberto **não** acelera stats, só o refresh de estado

Enquanto não há amostra, o label mostra `—`, não `0%`. Zero é uma medição;
travessão é a ausência dela.

Parsing tem que ser consciente de unidade: `MemUsage` vem como
`"33.53MiB / 31.08GiB"` — usado e limite, MiB/GiB/KiB misturados na mesma
lista de containers.

## Ações

`docker restart|stop|start <id>`. Sempre por ID, nunca por nome — nome muda,
ID não. Usuário já está no grupo `docker`; sem sudo, sem pkexec.

Ação de stack usa `docker compose -p <projeto> restart`; sem o binário compose,
cai pra loop nos containers do grupo.

Log abre no terminal: `docker logs -f --tail 200 <id>`.

Toda ação: estado "em progresso" na célula e na linha, trava reentrada, e o
refresh vem do próprio `docker events`. Não atualizar a UI de forma otimista —
restart falha, e a tela mentiria.

## Integração com lazydocker

A CLI do lazydocker 0.25.2 aceita `-f/--file` e `-p/--project`, e nada além
disso. **Não existe** forma de abri-lo focado num container, nem IPC. Então o
plugin oferece exatamente o que a ferramenta suporta, e resolve o resto com
docker puro.

| Alvo | Comando | Onde fica |
|---|---|---|
| daemon inteiro | `lazydocker` | clique do meio no bar, e botão no cabeçalho do popup |
| um stack | `lazydocker -p <projeto> -f <cada arquivo>` | botão no cabeçalho do stack |
| um container | não é possível | logs e shell abrem em docker puro |

O `-p` e o `-f` saem dos labels que o compose grava em todo container que
inicia: `com.docker.compose.project`, `.project.working_dir` e
`.project.config_files` (separado por vírgula quando há mais de um arquivo).
Container iniciado fora do compose não tem nenhum deles, não pode ser escopado,
e cai no daemon inteiro.

Tudo passa por `omarchy launch or focus tui`, então clicar duas vezes no mesmo
botão **foca** a janela já aberta em vez de empilhar outro terminal. Cada escopo
tem id de janela próprio, então o lazydocker de um stack e o de outro são duas
janelas que não se atrapalham.

### Duas armadilhas verificadas na máquina

**O padrão de foco casa por fronteira de palavra.** `omarchy-launch-or-focus`
procura a janela com `/\bPADRÃO\b/i` contra a classe. Um id genérico
`org.omarchy.lazydocker` casa com **toda** janela escopada, e um
`...stack-web-shop` casa com a janela de `...stack-web-shop-dev`, porque `-`
é fronteira de palavra. Por isso os ids usam `_` como separador, que é caractere
de palavra: um id mais longo não casa com um mais curto. Há teste de regressão
para isso.

**O launcher passa argv por `eval`.** `omarchy-launch-or-focus-tui` remonta os
argumentos numa string e avalia. Caminho com espaço precisa chegar já entre
aspas, ou parte no meio. Um dos stacks desta máquina vive em
`/srv/Projetos/...`; o próximo pode ter espaço.

## Configuração (`manifest.json`)

| Chave | Tipo | Default | Para quê |
|---|---|---|---|
| `primaryAction` | string | `popup` | `popup` ou `lazydocker` no clique esquerdo |
| `groupBy` | string | `auto` | `auto`/`container`/`stack` |
| `maxCells` | integer | 24 | acima disso colapsa pra stack (4–64) |
| `cellGap` | integer | 1 | px entre células (0–4) |
| `pulseRestarting` | boolean | true | pulsar célula em restarting |
| `metrics` | string | `cpu,mem` | ordem da rotação; vazio esconde o label |
| `metricRotateMs` | integer | 4000 | troca da métrica (1500–30000) |
| `statsIntervalMs` | integer | 30000 | coleta do `docker stats` (10s–300s) |
| `statsOnBattery` | boolean | false | coletar métrica na bateria |
| `pollIntervalMs` | integer | 60000 | rede de segurança do stream (10s–300s) |
| `openPollIntervalMs` | integer | 3000 | refresh de estado com popup aberto |
| `showStopped` | boolean | true | inclui containers parados no mosaico |
| `hideProjects` | string | `""` | projetos ocultos, separados por vírgula |
| `dockerUrl` | string | `""` | UI web aberta no clique direito |
| `logTail` | integer | 200 | linhas de log abertas pelo botão |

## Arquivos

Mesmo padrão de `avila.wled` e `avila.cameras`:

```
avila.docker/
├── manifest.json     kinds: ["service","bar-widget"]
├── Service.qml       events, refresh, stats, ações, estado
├── Panel.qml         entryPoint barWidget: mosaico + label + popup
├── Mosaic.qml        grade particionada, isolada pra poder testar sozinha
├── Docker.js         lógica pura: parse, agrupamento, rollup, partição, comandos
├── test_docker.js    node test_docker.js
├── README.md
├── CLAUDE.md
├── LICENSE           MIT
├── preview.png
└── .gitignore
```

`Docker.js` não tem `export` (é resource QML) — `test_docker.js` faz `eval` do
arquivo, igual `test_wled.js`.

## Checks

`node test_docker.js`, sem framework, sem rede, sem daemon. Cobre:

**Partição da grade** (o núcleo novo)
- `N = 1,2,3` → uma linha, `N` colunas
- `N = 4` → 2×2 · `N = 6` → 3×2 · `N = 9` → 3×3 · `N = 20` → 5×4
- `N = 5,7,8` → última linha estica, sem buraco
- `N = 0` → grade vazia, sem divisão por zero
- `N > maxCells` → colapsa pra stack; ainda acima → bloco único
- célula abaixo de 3px na largura disponível → colapsa

**Ordem estável**
- mesma lista em ordem de entrada diferente → mesma ordem de células
- container mudar de estado **não** muda a posição da célula

**Parse de estado**
- linha `{{json .}}` real de cada estado: running, running+healthy, restarting,
  exited 0, exited ≠ 0, paused, created
- agrupamento pelos labels de compose, container sem label → `(avulsos)`
- rollup do stack e global: pior estado vence
- `hideProjects` filtrando sem quebrar a contagem total

**Parse de métrica**
- `CPUPerc` `"0.08%"` e `"2.50%"` → soma correta
- `MemUsage` `"33.53MiB / 31.08GiB"` → usado e limite separados, unidade certa
- MiB, GiB, KiB e B na mesma lista → soma em uma unidade só
- formatação do label: `3.2GB`, `15%`, `19/20`
- sem amostra → `—`, nunca `0%`

**Rotação**
- `metrics` vazio → sem label
- ciclo respeita a ordem e volta ao início
- largura reservada é a da maior string possível de cada métrica

**Degenerado**
- stdout vazio, JSON inválido no meio do stream, daemon fora
- forma exata dos comandos de ação (container vs stack)

Fixtures: capturas reais de `docker ps -a` e `docker stats --no-stream` desta
máquina, salvas no repo. Sem inventar payload.

## Bugs encontrados durante a implementação

Nenhum destes aparece em log de erro. Todos foram achados por teste ou por
screenshot, e por isso viraram teste de regressão ou nota no `CLAUDE.md`.

| Sintoma | Causa |
|---|---|
| Métrica em `—` para sempre | `docker stats` reporta id de 12 chars, `docker ps --no-trunc` de 64; o join nunca casava |
| Máquina saudável mostrada como daemon morto | `exitCode` lido dentro de `onStreamFinished`, onde ainda não é válido |
| Métrica nunca amostrada | `service` ainda é null em `Component.onCompleted` — o host injeta `bar` depois, e a visibilidade nunca era registrada |
| Popup abre invisível | filhos de `Flickable` são reparentados no `contentItem`, cuja largura é 0; a coluna colapsava |
| Botões que simplesmente não existem | glifos Font Awesome ausentes na fonte; um glifo faltando renderiza como nada |
| Foco na janela errada do lazydocker | `\b` trata `-` como fronteira, então `stack-x` casa com `stack-x-dev` |
| Terminal do container morre ao abrir | `exec bash \|\| exec sh`: quando `exec` falha, o shell não-interativo **encerra** — o `\|\|` nunca roda |
| Clique parece não fazer nada | clique no bar não move foco de teclado; a janela abria em outro monitor |
| Widget some do bar | `IpcHandler` sem `import Quickshell.Io` derruba o `Panel.qml` inteiro |

## O que vai morder

- **`docker stats` custa 2.1s aqui.** Chamar junto com o refresh de estado
  transforma um plugin leve num que trava o shell a cada evento. As duas
  cadências são separadas por decisão, não por acaso.
- **Ordenar células por estado** destrói o widget. Posição fixa é o que faz o
  mosaico ser lido de relance.
- **Largura variável** do label empurra o bar inteiro a cada rotação. Reservar
  a maior largura possível.
- **Daemon fora** ≠ **zero containers**. Estado distinto, cor distinta, texto
  distinto no popup. Confundir faz o widget mentir.
- **Permissão**: usuário fora do grupo `docker` dá erro de socket. Mostrar
  "sem acesso ao Docker", nunca ficar em branco.
- **Rajada de eventos**: `docker compose up` de um stack grande dispara dezenas
  de eventos em segundos. Sem debounce vira dezenas de `docker ps` simultâneos.
- **`Ports` é string livre**, não lista. Parsear com cuidado e nunca deixar o
  parse derrubar a linha inteira.
- **Container em loop de restart** gera evento infinito. Debounce protege, e o
  teto de 30s do backoff também precisa existir.
- **Célula de 4px** não comunica nada. O colapso pra stack não é otimização, é
  requisito de legibilidade.
- **Glifo de fonte não é garantido.** Os estados vazio e de erro no bar são
  retângulos desenhados, não ícones — glifo ausente some, e o widget parece
  quebrado em vez de vazio.
- **O plugin instalado por symlink não é observado** pelo watcher do shell.
  Editar o repo não recarrega nada; só `omarchy restart shell` carrega.
