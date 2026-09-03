// Container registry for the avila.ultra-docker plugin.
//
// Loaded once per shell session (kind: "service"), so the bar widget — which
// the shell instantiates once per monitor — reads one shared container list
// instead of every copy shelling out to docker on its own.
//
// Two data sources with very different costs live here, and keeping them apart
// is the whole point of this file:
//
//   state    `docker ps` driven by the `docker events` stream. Cheap, and as
//            close to live as the daemon gets.
//   metrics  `docker stats --no-stream`, which measured 2.1s for 20 containers
//            on the machine this was written for. It runs on its own slow
//            timer, never on the event path, and never twice at once.

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.UPower
import "Docker.js" as Docker
import "I18n.js" as I18n

Item {
  id: root

  // ------------------------------------------------------------- state

  property var containers: []
  property var statsById: ({})
  property bool daemonOk: true
  property string errorText: ""
  // Container id -> action currently in flight, so the UI can show progress
  // and refuse a second click without guessing.
  property var busy: ({})

  readonly property bool ready: containers.length > 0 || !daemonOk || loaded
  property bool loaded: false

  // ---------------------------------------------------------- settings
  //
  // Pushed in by the bar widget, which is where shell.json puts per-widget
  // config. Every monitor's copy pushes the same values, so last writer wins
  // with an identical payload.

  property int pollIntervalMs: 60000
  property int openPollIntervalMs: 3000
  property int statsIntervalMs: 30000
  property bool statsOnBattery: false
  property int logTail: 200

  // Widgets register while they are on screen. No visible widget means nobody
  // is looking, which is the cheapest possible reason not to sample.
  property int visibleWidgets: 0
  property int openPanels: 0

  function configure(settings) {
    pollIntervalMs = Math.max(10000, Number(settings.pollIntervalMs || 60000))
    openPollIntervalMs = Math.max(1000, Number(settings.openPollIntervalMs || 3000))
    statsIntervalMs = Math.max(10000, Number(settings.statsIntervalMs || 30000))
    statsOnBattery = settings.statsOnBattery === true
    notificationsEnabled = settings.notifications !== false
    logTail = Math.max(20, Number(settings.logTail || 200))

    applyLanguage(String(settings.language || "auto"))

    var wanted = String(settings.engine || "auto")
    if (wanted !== enginePreference) {
      enginePreference = wanted
      if (wanted !== "auto") applyEngine(wanted)
      else engineCheck.running = true
    }
  }

  function setWidgetVisible(visible) {
    visibleWidgets = Math.max(0, visibleWidgets + (visible ? 1 : -1))
  }

  function setPanelOpen(open) {
    openPanels = Math.max(0, openPanels + (open ? 1 : -1))
  }

  // --------------------------------------------------------- derived

  readonly property var summary: Docker.rollup(containers)
  readonly property var aggregate: Docker.aggregateStats(containers, statsById)
  readonly property bool hasSample: aggregate.samples > 0

  function groupsFor(settings) {
    return Docker.orderGroups(
      Docker.groupByProject(Docker.applyFilters(containers, settings)),
      settings ? settings.stackOrder : "failed")
  }

  function statsFor(id) {
    return Docker.lookupStats(statsById, id)
  }

  // ------------------------------------------------------- state reads

  function refresh() {
    if (psProcess.running) return
    psProcess.command = Docker.psCommand()
    psProcess.running = true
  }

  Process {
    id: psProcess

    // The payload and the exit status arrive through different signals, and
    // neither one is complete on its own: at `exited` the collector may not
    // hold the whole payload yet, and at `streamFinished` the exit code is not
    // set. Reading exitCode from inside streamFinished reports a failure that
    // did not happen, which paints a healthy machine as a dead daemon. Wait for
    // both, then apply once.
    property string pendingText: ""
    property bool textReady: false
    property bool exitReady: false
    property int lastExit: 0

    function applyWhenComplete() {
      if (!textReady || !exitReady) return
      textReady = false
      exitReady = false
      root.applyPs(pendingText, lastExit)
    }

    stdout: StdioCollector {
      id: psStdout
      waitForEnd: true
      onStreamFinished: {
        psProcess.pendingText = psStdout.text
        psProcess.textReady = true
        psProcess.applyWhenComplete()
      }
    }

    onExited: function(exitCode) {
      psProcess.lastExit = exitCode
      psProcess.exitReady = true
      psProcess.applyWhenComplete()
    }
  }

  // Whether this session has to elevate to reach the daemon. Sampled from
  // omarchy-sudo-docker rather than by testing group membership, because that
  // is the contract the shell asks every one of its own tools to use — and it
  // answers for THIS session, which differs from the account's groups in the
  // window between opting in and the reboot that applies it.
  //
  // Defaults to false so a machine without the helper behaves as it always did.
  property bool needsSudo: false

  Process {
    id: accessCheck
    command: Docker.daemonAccessCommand()
    // Exit 0 means "sudo is needed". A missing helper is not an answer, so it
    // leaves the assumption alone rather than declaring the daemon unreachable.
    onExited: function(exitCode) {
      if (exitCode === 0 || exitCode === 1) root.needsSudo = exitCode === 0
    }
  }

  function checkAccess() {
    if (accessCheck.running) return
    accessCheck.running = true
  }

  function applyPs(text, exitCode) {
    root.loaded = true

    if (!Docker.readingSucceeded(exitCode)) {
      // A daemon that is down is not the same as a machine with no containers,
      // and painting the second when the first is true makes the widget lie.
      // 141 is neither: it is the byte ceiling closing the pipe, and what came
      // through before it still describes real containers.
      //
      // A socket we were never given is a third state again. Re-ask before
      // naming it: the read is how we find out, and the answer decides between
      // "your daemon is down" and "you do not have a key to it".
      root.daemonOk = false
      root.containers = []
      root.checkAccess()
      root.errorText = describeFailure(exitCode)
      return
    }

    root.daemonOk = true
    root.errorText = ""

    var next = Docker.parsePs(text)
    root.announceChanges(next)
    root.containers = next
    root.sampleRestarts()
  }

  function describeFailure(exitCode) {
    // 127 is the shell's "cannot execute". Everything else is either a daemon
    // that is not running or one this session may not talk to, and those two
    // send someone to fix entirely different things.
    return I18n.t(Docker.daemonFailureKey(exitCode, root.needsSudo))
  }

  // ------------------------------------------------------ event stream

  property int eventAttempt: 0

  Process {
    id: eventsProcess
    command: Docker.eventsCommand()

    stdout: SplitParser {
      onRead: function(line) {
        root.eventAttempt = 0
        if (Docker.shouldRefresh(line)) debounce.restart()
      }
    }

    onExited: {
      // Losing this stream is routine — a daemon restart does it. Reconnecting
      // in a tight loop afterwards is not.
      reconnect.interval = Docker.backoffMs(root.eventAttempt, 1000, 30000)
      root.eventAttempt++
      reconnect.restart()
    }
  }

  Timer {
    id: reconnect
    interval: 1000
    onTriggered: if (!eventsProcess.running) eventsProcess.running = true
  }

  Timer {
    id: debounce
    // One `docker compose up` emits dozens of events within a second. Without
    // this, each one would start its own `docker ps`.
    interval: 300
    onTriggered: root.refresh()
  }

  Timer {
    id: safetyPoll
    running: true
    repeat: true
    interval: root.openPanels > 0 ? root.openPollIntervalMs : root.pollIntervalMs
    onTriggered: root.refresh()
  }

  // ----------------------------------------------------------- metrics

  readonly property bool statsAllowed: root.daemonOk
    && root.visibleWidgets > 0
    && (root.statsOnBattery || !UPower.onBattery)

  function sampleStats() {
    if (!statsAllowed || statsProcess.running) return
    statsProcess.command = Docker.statsCommand()
    statsProcess.running = true
  }

  Process {
    id: statsProcess

    // Same two-signal problem as the ps read above.
    property string pendingText: ""
    property bool textReady: false
    property bool exitReady: false
    property int lastExit: 0

    function applyWhenComplete() {
      if (!textReady || !exitReady) return
      textReady = false
      exitReady = false
      if (Docker.readingSucceeded(lastExit)) root.statsById = Docker.parseStats(pendingText)
    }

    stdout: StdioCollector {
      id: statsStdout
      waitForEnd: true
      onStreamFinished: {
        statsProcess.pendingText = statsStdout.text
        statsProcess.textReady = true
        statsProcess.applyWhenComplete()
      }
    }

    onExited: function(exitCode) {
      statsProcess.lastExit = exitCode
      statsProcess.exitReady = true
      statsProcess.applyWhenComplete()
    }
  }

  Timer {
    id: statsTimer
    running: root.statsAllowed
    repeat: true
    interval: root.statsIntervalMs
    // A sample the moment sampling becomes allowed, rather than one interval of
    // an em dash after the widget appears.
    triggeredOnStart: true
    onTriggered: root.sampleStats()
  }

  // --------------------------------------------------------- disk usage
  //
  // Sampled when the popup opens rather than on a timer: nobody needs to know
  // how much build cache they have until they are looking at the panel, and
  // `docker system df` walks the whole image store to find out.

  property var dfRows: []
  readonly property var pruneTargets: Docker.pruneTargets(dfRows)
  readonly property real reclaimable: Docker.totalReclaimable(dfRows)
  readonly property var volumesRow: Docker.dfRow(dfRows, "Local Volumes")

  function sampleDf() {
    if (dfProcess.running || !daemonOk) return
    dfProcess.command = Docker.systemDfCommand()
    dfProcess.running = true
  }

  onOpenPanelsChanged: {
    if (openPanels <= 0) return
    // Everything the header needs, gathered only while someone is looking.
    sampleDf()
    sampleHostDisk()
    checkAutostart()
  }

  Process {
    id: dfProcess

    property string pendingText: ""
    property bool textReady: false
    property bool exitReady: false
    property int lastExit: 0

    function applyWhenComplete() {
      if (!textReady || !exitReady) return
      textReady = false
      exitReady = false
      if (Docker.readingSucceeded(lastExit)) root.dfRows = Docker.parseSystemDf(pendingText)
    }

    stdout: StdioCollector {
      id: dfStdout
      waitForEnd: true
      onStreamFinished: {
        dfProcess.pendingText = dfStdout.text
        dfProcess.textReady = true
        dfProcess.applyWhenComplete()
      }
    }

    onExited: function(exitCode) {
      dfProcess.lastExit = exitCode
      dfProcess.exitReady = true
      dfProcess.applyWhenComplete()
    }
  }

  function prune(target) {
    if (isBusy(target.id)) return
    markBusy(target.id, "prune")
    actionQueue.push({ key: target.id, command: target.command, resample: true })
    pump()
  }

  // ---------------------------------------------------------- resources
  //
  // Images, volumes and networks are read only for the tab being looked at:
  // three extra engine calls on every refresh, to populate lists nobody has
  // opened, is exactly the cost this plugin spends the rest of its effort
  // avoiding.

  property string activeTab: "containers"
  property var images: []
  property var volumes: []
  property var networks: []
  property string lastResourceError: ""

  onActiveTabChanged: refreshTab()

  // A stack coming up or going down changes which images belong where.
  onContainersChanged: if (activeTab === "images" && images.length > 0)
    images = Docker.attachProjects(images, containers)

  function refreshTab() {
    if (activeTab === "images") load("images")
    else if (activeTab === "volumes") load("volumes")
    else if (activeTab === "networks") load("networks")
  }

  function load(kind) {
    if (resourceProcess.running) return
    resourceProcess.kind = kind
    resourceProcess.command = kind === "images" ? Docker.imagesCommand()
      : (kind === "volumes" ? Docker.volumesCommand() : Docker.networksCommand())
    resourceProcess.running = true
  }

  Process {
    id: resourceProcess

    property string kind: ""
    property string pendingText: ""
    property bool textReady: false
    property bool exitReady: false
    property int lastExit: 0

    function applyWhenComplete() {
      if (!textReady || !exitReady) return
      textReady = false
      exitReady = false
      if (!Docker.readingSucceeded(lastExit)) return

      // Images carry no compose label; the containers on hand are what relate
      // them to a stack, so the panel groups the way the rest of it does.
      if (kind === "images") root.images =
        Docker.attachProjects(Docker.parseImages(pendingText), root.containers)
      else if (kind === "volumes") root.volumes = Docker.parseVolumes(pendingText)
      else if (kind === "networks") root.networks = Docker.parseNetworks(pendingText)
    }

    stdout: StdioCollector {
      id: resourceStdout
      waitForEnd: true
      onStreamFinished: {
        resourceProcess.pendingText = resourceStdout.text
        resourceProcess.textReady = true
        resourceProcess.applyWhenComplete()
      }
    }

    onExited: function(exitCode) {
      resourceProcess.lastExit = exitCode
      resourceProcess.exitReady = true
      resourceProcess.applyWhenComplete()
    }
  }

  function resourcesFor(tab) {
    if (tab === "images") return images
    if (tab === "volumes") return volumes
    if (tab === "networks") return networks
    return []
  }

  // The engine refuses to delete anything still in use, and that refusal is
  // information — it is surfaced rather than worked around with a force flag.
  function removeResources(resources) {
    lastResourceError = ""
    for (var i = 0; i < resources.length; i++) {
      if (!Docker.canRemoveResource(resources[i])) continue
      actionQueue.push({
        key: resources[i].id,
        command: Docker.resourceRemoveCommand(resources[i]),
        resample: true,
        reloadTab: true
      })
    }
    pump()
  }

  // ------------------------------------------------------- notifications

  property bool notificationsEnabled: true
  // The previous snapshot, kept only to diff against. Empty on the first read,
  // which is what stops a shell restart from announcing everything at once.
  // What each container was last announced as, and how many good reads it has
  // had since. Docker.notifications() owns the rules; this only holds the memory
  // they need, because two snapshots cannot tell a recovery from the pause
  // between two restarts.
  property var notifyMemo: ({})
  property bool seenFirstSnapshot: false

  function announceChanges(next) {
    // The first read after the shell starts is silent — otherwise every restart
    // of the shell announces everything that was already broken.
    if (!seenFirstSnapshot) {
      seenFirstSnapshot = true
      notifyMemo = Docker.notifications(next, {}).memo
      return
    }

    var result = Docker.notifications(next, notifyMemo)
    notifyMemo = result.memo

    // The memo advances either way: turning notifications off should silence
    // them, not bank them up for whenever they are turned back on.
    if (!notificationsEnabled) return

    for (var i = 0; i < result.announce.length; i++) {
      var notification = Docker.changeNotification(result.announce[i])
      // Docker.js hands over a key; the sentence is built here, where the
      // chosen language is known.
      if (notification) Quickshell.execDetached(
        Docker.notifyCommand(notification, I18n.t(notification.bodyKey)))
    }
  }

  // ----------------------------------------------------------- actions

  function markBusy(key, action) {
    var next = Object.assign({}, root.busy)
    if (action) next[key] = action
    else delete next[key]
    root.busy = next
  }

  function isBusy(key) {
    return root.busy[key] !== undefined
  }

  function runContainer(action, container) {
    if (isBusy(container.id)) return
    markBusy(container.id, action)
    actionQueue.push({ key: container.id, command: Docker.containerCommand(action, container.id) })
    pump()
  }

  function removeContainer(container) {
    if (isBusy(container.id)) return
    markBusy(container.id, "rm")
    actionQueue.push({ key: container.id, command: Docker.removeCommand(container.id), resample: true })
    pump()
  }

  function openPort(port, monitor) {
    focusMonitor(monitor)
    openUrl(Docker.portUrl(port))
  }

  function runStack(action, group) {
    if (isBusy(group.project)) return
    markBusy(group.project, action)
    actionQueue.push({
      key: group.project,
      command: Docker.stackCommand(action, group)
    })
    pump()
  }

  property var actionQueue: []
  property string actionKey: ""

  property bool actionResamples: false
  property bool actionReloadsTab: false

  function pump() {
    if (actionProcess.running || actionQueue.length === 0) return
    var next = actionQueue.shift()
    actionKey = next.key
    actionResamples = next.resample === true
    actionReloadsTab = next.reloadTab === true
    actionProcess.command = next.command
    actionProcess.running = true
  }

  Process {
    id: actionProcess

    stderr: StdioCollector {
      id: actionStderr
      waitForEnd: true
      onStreamFinished: {
        var text = actionStderr.text.trim()
        // "volume is in use", "image is being used by container" — the engine
        // saying no is the answer, not an obstacle to route around.
        if (text) root.lastResourceError = text.split("\n")[0]
      }
    }

    onExited: {
      root.markBusy(root.actionKey, "")
      root.actionKey = ""
      // No optimistic update: a restart can fail, and the screen would be
      // lying until the next poll. The truth arrives via docker events.
      root.refresh()
      // A prune or a remove changes what is on disk, and the panel is showing
      // the old number until this lands.
      if (root.actionResamples) root.sampleDf()
      if (root.actionReloadsTab) root.refreshTab()
      root.actionResamples = false
      root.actionReloadsTab = false
      root.pump()
    }
  }

  // ------------------------------------------------------- window launch

  // Detached on purpose: these open a terminal window that outlives the click,
  // and the shell must not wait on them.
  function launch(command) {
    if (!command || command.length === 0) return
    Quickshell.execDetached(command)
  }

  // group === null opens lazydocker for the whole daemon. Both paths go through
  // omarchy-launch-or-focus-tui, so a second click focuses the window that is
  // already open instead of stacking another terminal on top of it.
  function openLazydocker(group, monitor) {
    focusMonitor(monitor)
    launch(Docker.lazydockerCommand(group, root.needsSudo))
  }

  readonly property string askAgentScript: scriptPath("bin/omarchy-docker-ask-agent")
  readonly property string askAgentStackScript: scriptPath("bin/omarchy-docker-ask-agent-stack")

  function scriptPath(relative) {
    return decodeURIComponent(
      String(Qt.resolvedUrl(relative)).replace(/^file:\/\//, ""))
  }

  // The agent opens its own terminal, so this needs the same monitor treatment
  // as the other launches.
  function askAgent(container, monitor) {
    focusMonitor(monitor)
    launch(Docker.askAgentCommand(root.askAgentScript, container, root.logTail,
                                  I18n.language()))
  }

  function askAgentStack(group, monitor) {
    focusMonitor(monitor)
    launch(Docker.askAgentStackCommand(root.askAgentStackScript, group, root.logTail,
                                       I18n.language()))
  }

  function openCompose(group, monitor) {
    focusMonitor(monitor)
    launch(Docker.openComposeCommand(group))
  }

  function openContainerView(kind, container, monitor) {
    focusMonitor(monitor)
    launch(Docker.containerTuiCommand(kind, container, root.logTail))
  }

  // Sent just before the launch. Two calls rather than one chained command:
  // hyprctl returns in a millisecond and the terminal takes far longer than
  // that to map, so the ordering holds without a shell in the middle.
  function focusMonitor(monitor) {
    var command = Docker.focusMonitorCommand(monitor)
    if (command.length > 0) Quickshell.execDetached(command)
  }

  function openUrl(url) {
    if (!url) return
    launch(["omarchy-launch-browser", url])
  }

  // ----------------------------------------------------------- engine
  //
  // Podman answers the same commands; which one is present decides the prefix.
  // `auto` prefers docker when both are installed, because a machine with both
  // is nearly always a docker machine with podman along for the ride.

  // ------------------------------------------------------------ language

  property string languagePreference: "auto"
  readonly property string locale: Quickshell.env("LC_ALL")
    || Quickshell.env("LC_MESSAGES") || Quickshell.env("LANG") || ""
  // Bumped whenever the language changes, so every binding that renders a
  // string re-evaluates. I18n.t() is a function call, not a property, and QML
  // has no way to know the table underneath it moved.
  property int languageEpoch: 0

  function applyLanguage(name) {
    var wanted = name === "auto" ? I18n.detectLanguage(locale) : name
    if (I18n.language() === wanted) return
    I18n.setLanguage(wanted)
    languageEpoch++
  }

  property string enginePreference: "auto"
  readonly property string engineName: Docker.engine()
  readonly property string engineLabel: Docker.engineLabel()

  function applyEngine(name) {
    if (Docker.engine() === name) return
    Docker.setEngine(name)
    // Everything cached describes the other engine.
    containers = []
    statsById = ({})
    dfRows = []
    seenFirstSnapshot = false
    restartStream()
    refresh()
  }

  Process {
    id: engineCheck
    command: ["sh", "-c", "command -v docker >/dev/null && echo docker || (command -v podman >/dev/null && echo podman)"]
    running: true

    stdout: SplitParser {
      onRead: function(line) {
        var found = line.trim()
        if (!found) return
        root.applyEngine(root.enginePreference === "auto" ? found : root.enginePreference)
      }
    }
  }

  // ------------------------------------------------------------ host disk

  property var hostDisk: ({ used: 0, total: 0 })

  Process {
    id: diskProcess

    stdout: StdioCollector {
      id: diskStdout
      waitForEnd: true
      onStreamFinished: root.hostDisk = Docker.parseHostDisk(diskStdout.text)
    }
  }

  function sampleHostDisk() {
    if (diskProcess.running) return
    diskProcess.command = Docker.hostDiskCommand()
    diskProcess.running = true
  }

  readonly property var gauges: Docker.gauges(aggregate, dfRows, hostDisk)

  // -------------------------------------------------------- restart loops
  //
  // `docker ps` carries no restart count. Inspect is asked only about the
  // containers currently restarting — usually none — because inspecting
  // everything on every refresh is the cost avoided everywhere else here.

  property var restartCounts: ({})

  Process {
    id: restartProcess

    stdout: StdioCollector {
      id: restartStdout
      waitForEnd: true
      onStreamFinished: root.restartCounts = Docker.parseRestarts(restartStdout.text)
    }
  }

  function sampleRestarts() {
    if (restartProcess.running) return
    var command = Docker.inspectRestartsCommand(Docker.restartingIds(containers))
    if (command.length === 0) {
      if (Object.keys(restartCounts).length > 0) restartCounts = ({})
      return
    }
    restartProcess.command = command
    restartProcess.running = true
  }

  function restartsFor(id) {
    var count = restartCounts[id]
    return count === undefined ? -1 : count
  }

  // --------------------------------------------------------- disk pressure

  readonly property var pressure: Docker.diskPressure(dfRows, hostDisk, {})

  // ------------------------------------------------------- port conflicts

  readonly property var conflicts: Docker.portConflicts(containers)

  function conflictFor(id) {
    return conflicts[id] || null
  }

  // ------------------------------------------------------ daemon control

  property string daemonAutostart: "unknown"

  Process {
    id: autostartCheck

    stdout: StdioCollector {
      id: autostartStdout
      waitForEnd: true
      onStreamFinished: root.daemonAutostart = autostartStdout.text.trim() || "unknown"
    }
  }

  function checkAutostart() {
    if (autostartCheck.running) return
    autostartCheck.command = Docker.daemonStatusCommand()
    autostartCheck.running = true
  }

  // The daemon is the one action here that is not a container action, so it
  // gets its own slot rather than the queue — the queue exists to serialise
  // work against containers that may not survive it.
  Process { id: daemonProcess }

  function runDaemon(action) {
    if (daemonProcess.running) return
    var command = Docker.daemonCommand(action)
    if (command.length === 0) return
    daemonProcess.command = command
    daemonProcess.running = true
  }

  Connections {
    target: daemonProcess
    function onExited() {
      root.checkAutostart()
      root.refresh()
      root.restartStream()
    }
  }

  function restartStream() {
    eventAttempt = 0
    if (eventsProcess.running) eventsProcess.running = false
    eventsProcess.command = Docker.eventsCommand()
    eventsProcess.running = true
  }

  Component.onCompleted: {
    applyLanguage(languagePreference)
    checkAccess()
    refresh()
    eventsProcess.running = true
  }
}
