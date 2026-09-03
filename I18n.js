.pragma library

// Shared, deliberately.
//
// Without `.pragma library` every QML file that imports a .js resource gets its
// OWN copy of it: Service.qml would switch the language on its instance and
// Panel.qml would keep rendering from an untouched one. The symptom is a
// setting that visibly does nothing, with every individual piece working when
// tested on its own.

// Strings, in one place.
//
// English is the default and the fallback: an untranslated key shows the
// English rather than the key itself, because a panel reading "state.failed" is
// worse than one reading it in the wrong language.
//
// Rules that keep this honest:
//   - No sentence is assembled by concatenating translated fragments. Word
//     order is not universal, and a table of fragments cannot express that.
//     Anything with a value in it is a template with a placeholder.
//   - No flags. A flag is a country, and a language is not.
//   - Docker's own output is translated where it is a fixed vocabulary
//     (`5 weeks`), and left alone where it is free text (an error message).

var LANGUAGE = "en"

var STRINGS = {
  en: {
    // states
    "state.running": "running",
    "state.unhealthy": "unhealthy",
    "state.starting": "starting",
    "state.restarting": "restarting",
    "state.paused": "paused",
    "state.removing": "removing",
    "state.dead": "dead",
    "state.created": "created",
    "state.stopped": "stopped",
    "state.failed": "failed",

    // the same states, said in full for the tooltip
    "state.long.running": "running",
    "state.long.unhealthy": "running, but the healthcheck is failing",
    "state.long.starting": "starting — the healthcheck has not passed yet",
    "state.long.restarting": "in a restart loop",
    "state.long.paused": "paused",
    "state.long.removing": "being removed",
    "state.long.dead": "dead — the engine could not clean it up",
    "state.long.created": "created, never started",
    "state.long.stopped": "stopped without error",
    "state.long.failed": "exited with an error (code {code})",

    // durations, as docker spells them
    "age.second": "second", "age.seconds": "seconds",
    "age.minute": "minute", "age.minutes": "minutes",
    "age.hour": "hour", "age.hours": "hours",
    "age.day": "day", "age.days": "days",
    "age.week": "week", "age.weeks": "weeks",
    "age.month": "month", "age.months": "months",
    "age.year": "year", "age.years": "years",
    "age.about": "about",
    "age.less": "less than a second",

    // rows and controls
    "detail.code": "code {code}",
    "restarts.one": "1 restart",
    "restarts.many": "{count} restarts",
    "select.hint": "click to select",
    "selected.one": "1 selected",
    "selected.many": "{count} selected",
    "action.clear": "clear",
    "action.remove": "remove",
    "action.start": "start",
    "action.stop": "stop",
    "action.restart": "restart",
    "action.logs": "logs",
    "action.clean": "clean up",
    "action.show": "show",
    "action.cancel": "cancel",
    "action.hide": "hide",

    // tooltips
    "tip.logs": "Logs",
    "tip.agent": "Analyse the log with the default agent",
    "tip.agentStack": "Analyse the whole stack with the agent",
    "tip.compose": "Open the compose file in the editor",
    "tip.composeMissing": "No compose file known",
    "tip.shell": "Shell into the container",
    "tip.unpause": "Unpause",
    "tip.start": "Start",
    "tip.stop": "Stop",
    "tip.restart": "Restart",
    "tip.removeContainer": "Remove the container",
    "tip.removeResource": "Remove",
    "tip.protectedNetwork": "The engine's own network — not removable",
    "tip.refresh": "Refresh",
    "tip.lazydocker": "Open lazydocker",
    "tip.lazydockerStack": "lazydocker scoped to this stack",
    "tip.lazydockerLoose": "lazydocker (no stack to scope to)",
    "tip.stackStart": "Start the whole stack",
    "tip.stackStop": "Stop the whole stack",
    "tip.stackRestart": "Restart the whole stack",
    "tip.daemonStart": "Start the daemon",
    "tip.daemonStop": "Stop the daemon (and its socket)",
    "tip.autostartOn": "Starts with the system — click to turn off",
    "tip.autostartOff": "Does not start with the system — click to turn on",

    // tabs and filters
    "tab.containers": "containers",
    "tab.images": "images",
    "tab.volumes": "volumes",
    "tab.networks": "networks",
    "view.all": "all",
    "view.running": "running",
    "view.stopped": "stopped",
    "search.placeholder": "service, stack, container or image",

    // empty and error states
    "empty.containers": "No containers.",
    "empty.containersFiltered": "No container matches that filter.",
    "empty.resources": "Nothing here.",
    "empty.resourcesFiltered": "Nothing matches that filter.",
    "count.containers": "{running}/{total} containers",
    "count.filtered": "{shown} of {total} containers",
    "daemon.unavailable": "unavailable",
    // Three states, because they send you to three different places. The old
    // noAccess text asked "is your user in the 'docker' group?", which on
    // Omarchy's default is coaching someone towards passwordless root — the
    // exact thing the shell stopped doing by default, and it named plugins as
    // the reason.
    "daemon.down": "the Docker daemon is not running",
    "daemon.noAccess": "no access to the Docker daemon",
    "daemon.noAccessHint": "Rootless Docker gives this widget full access without granting root. Or opt in at Setup > Security > Sudoless Docker — that adds you to the docker group, which is passwordless root.",
    "daemon.missing": "docker not found",
    "daemon.stopConfirm": "Stop the {engine} daemon?\nEvery running container stops with it.",

    // notifications
    //
    // These leave through notify-send rather than through a Text, so none of
    // the QML translation rules reach them. They were Portuguese for everyone
    // until someone running the panel in English noticed.
    "notify.restarting": "is in a restart loop",
    "notify.unhealthy": "turned unhealthy",
    "notify.failed": "exited with an error",
    "notify.degraded": "changed state",
    "notify.recovered": "is back to normal",

    // gauges
    //
    // CPU and RAM are the same word in both tables, which is exactly why the
    // third one shipped as "DISCO" to English users for months: two of the
    // three needed no translation, so nobody looked at the one that did.
    "gauge.cpu": "CPU",
    "gauge.ram": "RAM",
    "gauge.disk": "DISK",

    // cleanup
    "cleanup.title": "Reclaimable space",
    "cleanup.reclaimable": "{size} reclaimable",
    "cleanup.pressure": "disk {percent}% full — {size} reclaimable",
    "cleanup.volumes": "volumes",
    "cleanup.volumesNote": "not removed from here",
    "prune.buildCache": "build cache",
    "prune.danglingImages": "dangling images",
    "prune.unusedImages": "unused images",
    "prune.stoppedContainers": "stopped containers",
    "prune.detail.buildCache": "Rebuilt on the next build.",
    "prune.detail.danglingImages": "Untagged layers left behind by rebuilds.",
    "prune.detail.unusedImages": "Every image no container uses. They will be pulled again when needed.",
    "prune.detail.stoppedContainers": "Their logs and filesystem changes go with them.",
    "prune.confirm": "Remove {label} ({size})?\n{detail}",
    "prune.confirmUnknown": "Remove {label}?\n{detail}",

    // removal
    "remove.container": "Remove {name}?\nThe container and its logs go with it. The image stays.",
    "remove.one": "Remove {kind} {name}?",
    "remove.many": "Remove {count} items ({size})?",
    "remove.manyNoSize": "Remove {count} items?",

    // resources
    "resource.inUse": "in use",
    "resource.anonymous": "anonymous",
    "group.loose": "(loose)",

    // ------------------------------------------------------- settings
    //
    // Only the screen's own prose lives here. Every field's label and help
    // text comes from `manifest.json`, which already carries both in English
    // and is the single description of what each key does. Copying them into
    // this table would create a second place to edit and one of them would go
    // stale — so `settings.label.*` and `settings.help.*` appear in the `pt`
    // table ONLY, and English falls through to the manifest. This is the one
    // documented exception to "both tables carry the same keys", and the
    // tests assert the exception rather than ignoring it.
    "settings.title": "Settings",
    "settings.close": "Done",
    "settings.reset": "Reset to default",
    "settings.resetAll": "Reset everything",
    "settings.resetAllConfirm": "Reset all {count} changed settings to their defaults?",
    "settings.changed": "{count} changed",
    "settings.unchanged": "All at their defaults",
    "settings.writeFailed": "Could not save: {error}",
    "settings.readOnly": "This shell does not let a widget save its own settings. Use: omarchy bar set {id} <key> <value>",
    "settings.section.look": "Appearance",
    "settings.section.content": "What is shown",
    "settings.section.label": "Rotating label",
    "settings.section.actions": "Clicks and actions",
    "settings.section.system": "Engine and sampling",
    "settings.section.other": "Not filed yet",
    "settings.hint.paletteCustom": "Three hex values: healthy, warning, broken.",
    "settings.keys": "Tab moves between sections · 1…{count} jumps to one · s closes · Esc goes back",
    "keys.hint": "f to find · s for settings · 1…4 sections · r refresh",
    "settings.tip.settings": "Settings (s)"
  },

  pt: {
    "state.running": "rodando",
    "state.unhealthy": "unhealthy",
    "state.starting": "subindo",
    "state.restarting": "reiniciando",
    "state.paused": "pausado",
    "state.removing": "removendo",
    "state.dead": "morto",
    "state.created": "criado",
    "state.stopped": "parado",
    "state.failed": "falhou",

    "state.long.running": "rodando",
    "state.long.unhealthy": "rodando, mas o healthcheck falha",
    "state.long.starting": "subindo — o healthcheck ainda não passou",
    "state.long.restarting": "em loop de restart",
    "state.long.paused": "pausado",
    "state.long.removing": "sendo removido",
    "state.long.dead": "morto — o engine não conseguiu limpar",
    "state.long.created": "criado, nunca iniciado",
    "state.long.stopped": "parado sem erro",
    "state.long.failed": "saiu com erro (código {code})",

    "age.second": "segundo", "age.seconds": "segundos",
    "age.minute": "minuto", "age.minutes": "minutos",
    "age.hour": "hora", "age.hours": "horas",
    "age.day": "dia", "age.days": "dias",
    "age.week": "semana", "age.weeks": "semanas",
    "age.month": "mês", "age.months": "meses",
    "age.year": "ano", "age.years": "anos",
    "age.about": "cerca de",
    "age.less": "menos de um segundo",

    "detail.code": "código {code}",
    "restarts.one": "1 restart",
    "restarts.many": "{count} restarts",
    "select.hint": "clique para selecionar",
    "selected.one": "1 selecionado",
    "selected.many": "{count} selecionados",
    "action.clear": "limpar",
    "action.remove": "remover",
    "action.start": "iniciar",
    "action.stop": "parar",
    "action.restart": "reiniciar",
    "action.logs": "logs",
    "action.clean": "limpar",
    "action.show": "ver",
    "action.cancel": "cancelar",
    "action.hide": "fechar",

    "tip.logs": "Logs",
    "tip.agent": "Analisar o log com o agente padrão",
    "tip.agentStack": "Analisar o stack inteiro com o agente",
    "tip.compose": "Abrir o compose no editor",
    "tip.composeMissing": "Sem compose conhecido",
    "tip.shell": "Shell no container",
    "tip.unpause": "Despausar",
    "tip.start": "Iniciar",
    "tip.stop": "Parar",
    "tip.restart": "Reiniciar",
    "tip.removeContainer": "Remover o container",
    "tip.removeResource": "Remover",
    "tip.protectedNetwork": "Rede do próprio engine — não removível",
    "tip.refresh": "Atualizar",
    "tip.lazydocker": "Abrir lazydocker",
    "tip.lazydockerStack": "lazydocker neste stack",
    "tip.lazydockerLoose": "lazydocker (sem stack para escopar)",
    "tip.stackStart": "Iniciar o stack inteiro",
    "tip.stackStop": "Parar o stack inteiro",
    "tip.stackRestart": "Reiniciar o stack",
    "tip.daemonStart": "Iniciar o daemon",
    "tip.daemonStop": "Parar o daemon (e o socket)",
    "tip.autostartOn": "Inicia junto com o sistema — clique para desligar",
    "tip.autostartOff": "Não inicia com o sistema — clique para ligar",

    "tab.containers": "containers",
    "tab.images": "imagens",
    "tab.volumes": "volumes",
    "tab.networks": "redes",
    "view.all": "todos",
    "view.running": "rodando",
    "view.stopped": "parados",
    "search.placeholder": "serviço, stack, container ou imagem",

    "empty.containers": "Nenhum container.",
    "empty.containersFiltered": "Nenhum container com esse filtro.",
    "empty.resources": "Nada aqui.",
    "empty.resourcesFiltered": "Nada com esse filtro.",
    "count.containers": "{running}/{total} containers",
    "count.filtered": "{shown} de {total} containers",
    "daemon.unavailable": "indisponível",
    "daemon.down": "o daemon do Docker não está rodando",
    "daemon.noAccess": "sem acesso ao daemon do Docker",
    "daemon.noAccessHint": "O Docker rootless dá acesso completo a este widget sem conceder root. Ou habilite em Setup > Security > Sudoless Docker — isso adiciona você ao grupo docker, que é root sem senha.",
    "daemon.missing": "docker não encontrado",
    "daemon.stopConfirm": "Parar o daemon do {engine}?\nTodo container em execução para junto.",

    "notify.restarting": "está em loop de restart",
    "notify.unhealthy": "ficou unhealthy",
    "notify.failed": "saiu com erro",
    "notify.degraded": "mudou de estado",
    "notify.recovered": "voltou ao normal",

    "gauge.cpu": "CPU",
    "gauge.ram": "RAM",
    "gauge.disk": "DISCO",

    "cleanup.title": "Espaço recuperável",
    "cleanup.reclaimable": "{size} recuperáveis",
    "cleanup.pressure": "disco em {percent}% — {size} recuperáveis",
    "cleanup.volumes": "volumes",
    "cleanup.volumesNote": "não removido daqui",
    "prune.buildCache": "cache de build",
    "prune.danglingImages": "imagens soltas",
    "prune.unusedImages": "imagens sem uso",
    "prune.stoppedContainers": "containers parados",
    "prune.detail.buildCache": "Reconstruído no próximo build.",
    "prune.detail.danglingImages": "Camadas sem tag deixadas por rebuilds.",
    "prune.detail.unusedImages": "Toda imagem que nenhum container usa. Serão baixadas de novo quando precisar.",
    "prune.detail.stoppedContainers": "Os logs e as mudanças no filesystem vão junto.",
    "prune.confirm": "Remover {label} ({size})?\n{detail}",
    "prune.confirmUnknown": "Remover {label}?\n{detail}",

    "remove.container": "Remover {name}?\nO container e os logs dele vão junto. A imagem fica.",
    "remove.one": "Remover {kind} {name}?",
    "remove.many": "Remover {count} itens ({size})?",
    "remove.manyNoSize": "Remover {count} itens?",

    "resource.inUse": "em uso",
    "resource.anonymous": "anônimo",
    "group.loose": "(soltos)",

    // settings — a tela em si
    "settings.title": "Configurações",
    "settings.close": "Pronto",
    "settings.reset": "Voltar ao padrão",
    "settings.resetAll": "Restaurar tudo",
    "settings.resetAllConfirm": "Restaurar as {count} configurações alteradas para o padrão?",
    "settings.changed": "{count} alteradas",
    "settings.unchanged": "Tudo no padrão",
    "settings.writeFailed": "Não consegui salvar: {error}",
    "settings.readOnly": "Este shell não deixa o widget salvar as próprias configurações. Use: omarchy bar set {id} <chave> <valor>",
    "settings.section.look": "Aparência",
    "settings.section.content": "O que aparece",
    "settings.section.label": "Rótulo rotativo",
    "settings.section.actions": "Cliques e ações",
    "settings.section.system": "Engine e amostragem",
    "settings.section.other": "Ainda sem seção",
    "settings.hint.paletteCustom": "Três valores hex: saudável, atenção, quebrado.",
    "settings.keys": "Tab muda de seção · 1…{count} pula direto · s fecha · Esc volta",
    "keys.hint": "f para buscar · s para configurações · 1…4 seções · r atualiza",
    "settings.tip.settings": "Configurações (s)",

    // settings — rótulos e ajuda dos campos.
    //
    // O inglês NÃO está aqui: vem do `manifest.json`, que já descreve cada
    // chave. Uma chave sem tradução cai no inglês do manifesto, que é a
    // política de fallback deste arquivo aplicada a outra tabela.
    "settings.label.palette": "Cores das células",
    "settings.help.palette": "theme segue o tema do Omarchy e muda junto com ele. As paletas com nome são fixas. custom lê o campo abaixo.",
    "settings.label.paletteCustom": "Cores personalizadas",
    "settings.help.paletteCustom": "Três valores hex, nesta ordem: saudável, atenção, quebrado. Ex.: #3fb950,#d29922,#f85149. Qualquer outra coisa volta para o tema.",
    "settings.label.cellSize": "Tamanho da célula (px)",
    "settings.help.cellSize": "Célula menor cabe mais linhas na mesma barra, então o mosaico fica bem mais estreito — não só menor.",
    "settings.label.cellGap": "Espaço entre células",
    "settings.help.cellGap": "Mantenha em 2 ou mais: a barra pode cair em meio pixel, e um espaço de 1px some entre algumas células, que parecem grudadas.",
    "settings.label.stackGap": "Espaço entre stacks (px)",
    "settings.help.stackGap": "O espaço extra que marca onde uma stack do compose termina e a próxima começa.",
    "settings.label.groupStacks": "Agrupar containers por stack",
    "settings.help.groupStacks": "Desligado espalha todos os containers em linhas simples, sem fronteira entre stacks.",
    "settings.label.maxWidth": "Largura máxima (px)",
    "settings.help.maxWidth": "Acima disso o mosaico colapsa para uma célula por stack, e depois para um bloco só.",
    "settings.label.pulseRestarting": "Pulsar containers reiniciando",
    "settings.help.pulseRestarting": "O único movimento do widget, guardado para o estado que passaria despercebido.",
    "settings.label.groupBy": "Uma célula por",
    "settings.help.groupBy": "auto troca para stacks quando há mais containers do que o limite de células.",
    "settings.label.stackOrder": "Ordem das stacks",
    "settings.help.stackOrder": "Como o popup lista as stacks. O mosaico da barra continua alfabético em qualquer opção, para que uma célula nunca mude de lugar quando um container reinicia.",
    "settings.label.showStopped": "Mostrar containers parados",
    "settings.label.hideProjects": "Projetos escondidos",
    "settings.help.hideProjects": "Nomes de projeto do compose, separados por vírgula.",
    "settings.label.metricCpu": "Rotacionar: CPU",
    "settings.help.metricCpu": "CPU somada de todos os containers rodando.",
    "settings.label.metricMem": "Rotacionar: memória usada",
    "settings.help.metricMem": "Memória total em bytes.",
    "settings.label.metricMemPerc": "Rotacionar: memória %",
    "settings.help.metricMemPerc": "Memória usada contra os limites dos próprios containers.",
    "settings.label.metricNet": "Rotacionar: rede recebida",
    "settings.help.metricNet": "Bytes recebidos desde que cada container subiu.",
    "settings.label.metricCount": "Rotacionar: quantos rodando",
    "settings.help.metricCount": "rodando / total. A única métrica que não custa nada para amostrar.",
    "settings.label.metricRotateMs": "Rotação do rótulo (ms)",
    "settings.label.primaryAction": "Clique esquerdo abre",
    "settings.help.primaryAction": "popup mostra stacks e ações; lazydocker vai direto para o TUI. Clique do meio sempre abre o lazydocker.",
    "settings.label.dockerUrl": "Clique direito abre esta URL",
    "settings.help.dockerUrl": "Qualquer web UI que você use para containers — Portainer, Dozzle, um dashboard do compose. Abre no navegador. Vazio faz o clique direito apenas atualizar o estado.",
    "settings.label.logTail": "Linhas de log",
    "settings.label.notifications": "Notificações no desktop",
    "settings.help.notifications": "Quando um container fica unhealthy, entra em loop de restart ou sai com erro — e uma vez quando se recupera.",
    "settings.label.language": "Idioma",
    "settings.help.language": "auto segue o LANG. O que não estiver traduzido cai no inglês.",
    "settings.label.engine": "Engine de containers",
    "settings.help.engine": "auto prefere o docker quando os dois estão instalados.",
    "settings.label.statsIntervalMs": "Amostragem de CPU/memória (ms)",
    "settings.help.statsIntervalMs": "docker stats custa segundos numa máquina ocupada. Amostrar mais rápido que isso não compra nada.",
    "settings.label.statsOnBattery": "Amostrar CPU/memória na bateria",
    "settings.label.pollIntervalMs": "Poll de segurança do estado (ms)",
    "settings.help.pollIntervalMs": "Rede de proteção caso o stream do docker events morra em silêncio.",
    "settings.label.openPollIntervalMs": "Poll do estado com o painel aberto (ms)",

    // settings — valores das listas
    "settings.option.palette.theme": "tema (segue o Omarchy)",
    "settings.option.palette.traffic": "semáforo",
    "settings.option.palette.ember": "brasa",
    "settings.option.palette.ocean": "oceano",
    "settings.option.palette.violet": "violeta",
    "settings.option.palette.mono": "cinzas",
    "settings.option.palette.custom": "personalizada",
    "settings.option.stackOrder.failed": "quebradas primeiro",
    "settings.option.stackOrder.name": "A-Z",
    "settings.option.stackOrder.running": "ligadas primeiro",
    "settings.option.groupBy.auto": "auto",
    "settings.option.groupBy.container": "container",
    "settings.option.groupBy.stack": "stack",
    "settings.option.primaryAction.popup": "popup",
    "settings.option.primaryAction.lazydocker": "lazydocker",
    "settings.option.language.auto": "auto",
    "settings.option.language.en": "inglês",
    "settings.option.language.pt": "português",
    "settings.option.engine.auto": "auto",
    "settings.option.engine.docker": "docker",
    "settings.option.engine.podman": "podman"
  }
}

function setLanguage(name) {
  LANGUAGE = STRINGS[name] ? name : "en"
  return LANGUAGE
}

// `auto` follows the environment, and falls back to English for anything not
// translated rather than guessing at a near neighbour.
function detectLanguage(locale) {
  var tag = String(locale || "").toLowerCase()
  if (tag.indexOf("pt") === 0) return "pt"
  return "en"
}

function language() {
  return LANGUAGE
}

// Whether a key exists at all, in the active table or in English.
//
// The settings screen needs this because it has a second source of text: the
// plugin manifest, which carries every field's English label and description
// already. `t()` returns the key itself when there is no entry, and a panel
// reading "settings.label.palette" is the exact failure this file exists to
// prevent — so the caller asks first and falls back to the manifest.
function has(key) {
  var table = STRINGS[LANGUAGE] || STRINGS.en
  return table[key] !== undefined || STRINGS.en[key] !== undefined
}

function tOr(key, fallback, values) {
  if (has(key)) return t(key, values)
  return String(fallback === undefined || fallback === null ? key : fallback)
}

// An untranslated key shows the English, not the key: a panel reading
// "state.failed" is worse than one reading it in the wrong language.
function t(key, values) {
  var table = STRINGS[LANGUAGE] || STRINGS.en
  var text = table[key]
  if (text === undefined) text = STRINGS.en[key]
  if (text === undefined) return key

  if (!values) return text

  return text.replace(/\{(\w+)\}/g, function(match, name) {
    return values[name] === undefined ? match : String(values[name])
  })
}

// Durations arrive as a count and a unit, never as words to swap one by one.
//
// Translating "About an hour" word by word produced "cerca de an hora": the
// article does not survive, and putting articles in the table would be encoding
// grammar in a lookup, which is the thing this file promises not to do. Using
// the numeral sidesteps articles entirely — "cerca de 1 hora" — and works the
// same way in both languages.
function formatAge(parsed) {
  if (!parsed || !parsed.unit) return parsed && parsed.raw ? parsed.raw : ""

  var key = "age." + parsed.unit + (parsed.count === 1 ? "" : "s")
  var unit = t(key)
  var text = parsed.count + " " + unit

  return parsed.approx ? t("age.about") + " " + text : text
}

function plural(oneKey, manyKey, count) {
  return count === 1 ? t(oneKey) : t(manyKey, { count: count })
}

// Confirmations, assembled here rather than in Docker.js: the facts are data,
// the sentence is language.
function pruneConfirm(target, formatBytes) {
  var label = t(target.labelKey)
  var detail = t(target.detailKey)

  if (target.reclaimable >= 0) {
    return t("prune.confirm",
      { label: label, size: formatBytes(target.reclaimable), detail: detail })
  }
  return t("prune.confirmUnknown", { label: label, detail: detail })
}

function removeContainerConfirm(name) {
  return t("remove.container", { name: name })
}

function removeResourceConfirm(facts, formatBytes) {
  if (facts.count === 1) return t("remove.one", { kind: facts.kind, name: facts.name })
  if (facts.bytes > 0) return t("remove.many",
    { count: facts.count, size: formatBytes(facts.bytes) })
  return t("remove.manyNoSize", { count: facts.count })
}

function pressureText(pressure, formatBytes) {
  if (!pressure || pressure.bytes <= 0) return ""
  if (pressure.level === "urgent") return t("cleanup.pressure",
    { percent: pressure.percent, size: formatBytes(pressure.bytes) })
  return t("cleanup.reclaimable", { size: formatBytes(pressure.bytes) })
}
