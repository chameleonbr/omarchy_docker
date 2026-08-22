// Container registry for the avila.docker plugin.
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

Item {
  id: root

  // ------------------------------------------------------------- state

  property var containers: []
  property var statsById: ({})
  property bool daemonOk: true
  property string errorText: ""
  property bool hasCompose: false
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
    logTail = Math.max(20, Number(settings.logTail || 200))
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
    return Docker.sortGroups(Docker.groupByProject(Docker.applyFilters(containers, settings)))
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

  function applyPs(text, exitCode) {
    root.loaded = true

    if (exitCode !== 0) {
      // A daemon that is down is not the same as a machine with no containers,
      // and painting the second when the first is true makes the widget lie.
      root.daemonOk = false
      root.errorText = describeFailure(exitCode)
      root.containers = []
      return
    }

    root.daemonOk = true
    root.errorText = ""
    root.containers = Docker.parsePs(text)
  }

  function describeFailure(exitCode) {
    // 126/127 are the shell's "cannot execute"; anything else from docker with
    // no output is almost always the socket.
    if (exitCode === 127) return "docker não encontrado"
    return "sem acesso ao Docker — o usuário está no grupo 'docker'?"
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
      if (lastExit === 0) root.statsById = Docker.parseStats(pendingText)
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

  function runStack(action, group) {
    if (isBusy(group.project)) return
    markBusy(group.project, action)
    actionQueue.push({
      key: group.project,
      command: Docker.stackCommand(action, group.project, root.hasCompose && !group.loose, group.containers)
    })
    pump()
  }

  property var actionQueue: []
  property string actionKey: ""

  function pump() {
    if (actionProcess.running || actionQueue.length === 0) return
    var next = actionQueue.shift()
    actionKey = next.key
    actionProcess.command = next.command
    actionProcess.running = true
  }

  Process {
    id: actionProcess

    onExited: {
      root.markBusy(root.actionKey, "")
      root.actionKey = ""
      // No optimistic update: a restart can fail, and the screen would be
      // lying until the next poll. The truth arrives via docker events.
      root.refresh()
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
    launch(Docker.lazydockerCommand(group))
  }

  readonly property string askAgentScript: scriptPath("bin/omarchy-docker-ask-agent")

  function scriptPath(relative) {
    return decodeURIComponent(
      String(Qt.resolvedUrl(relative)).replace(/^file:\/\//, ""))
  }

  // The agent opens its own terminal, so this needs the same monitor treatment
  // as the other launches.
  function askAgent(container, monitor) {
    focusMonitor(monitor)
    launch(Docker.askAgentCommand(root.askAgentScript, container, root.logTail))
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

  // ------------------------------------------------------ compose check

  Process {
    id: composeCheck
    command: ["docker", "compose", "version"]
    running: true
    onExited: function(exitCode) { root.hasCompose = exitCode === 0 }
  }

  Component.onCompleted: {
    refresh()
    eventsProcess.running = true
  }
}
