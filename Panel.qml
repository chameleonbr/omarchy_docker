// Bar widget + popup for the avila.docker plugin.
//
// The bar half is a mosaic: one cell per container, coloured by state, with a
// metric label cycling beside it. Nothing in it is a number you have to read.
//
// The popup is the everyday half of managing a stack — is it up, restart it,
// look at a log. Anything deeper is lazydocker's job, and the buttons here open
// it already scoped to the stack you clicked rather than reimplementing it.

import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Docker.js" as Docker

Panel {
  id: root
  moduleName: "avila.docker"
  ipcTarget: "avila.docker"
  // Own handler instead of the base one: the extra methods below are the same
  // actions the widget offers, reachable from a Hyprland keybinding.
  manageIpc: false

  // The shell loads one bar widget per monitor but only one service, so every
  // copy reads the same container list.
  readonly property var service: bar && bar.shell
    ? bar.shell.serviceFor(root.moduleName) : null

  // Which monitor this copy of the widget lives on. A bar click does not move
  // keyboard focus, so without this a launched terminal lands on whatever
  // monitor was focused — often not the one that was clicked.
  //
  // It comes from the Quickshell window, not from `bar`: the bar host exposes
  // no `screen`, so reading `bar.screen.name` yields an empty string and every
  // monitor-aware behaviour silently turns into a no-op. That is exactly how it
  // shipped broken the first time — the code looked right and did nothing.
  readonly property var hostWindow: root.QsWindow ? root.QsWindow.window : null
  readonly property string monitorName: hostWindow && hostWindow.screen
    ? String(hostWindow.screen.name || "") : ""

  readonly property bool vertical: bar ? bar.vertical : false
  readonly property int barSize: bar ? bar.barSize : Style.bar.sizeHorizontal
  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // ---------------------------------------------------------- settings

  readonly property var filterSettings: ({
    hideProjects: setting("hideProjects", ""),
    showStopped: setting("showStopped", true) === true
  })
  readonly property string groupBy: String(setting("groupBy", "auto"))
  readonly property int cellSize: Math.max(2, Number(setting("cellSize", 4)))
  readonly property int cellGap: Math.max(1, Number(setting("cellGap", 2)))
  readonly property int stackGap: Math.max(0, Number(setting("stackGap", 3)))
  readonly property bool groupStacks: setting("groupStacks", true) === true
  readonly property int maxWidth: Math.max(20, Number(setting("maxWidth", 160)))
  readonly property bool pulseRestarting: setting("pulseRestarting", true) === true
  readonly property var metrics: Docker.metricList(setting("metrics", "cpu,mem"))
  readonly property int metricRotateMs: Math.max(1500, Number(setting("metricRotateMs", 4000)))
  readonly property string dockerUrl: String(setting("dockerUrl", ""))
  readonly property string primaryAction: String(setting("primaryAction", "popup"))

  function pushSettings() {
    if (service) service.configure(settings || ({}))
  }

  onSettingsChanged: pushSettings()

  // ----------------------------------------------------------- content

  readonly property var containers: service
    ? Docker.applyFilters(service.containers, filterSettings) : []
  readonly property var groups: service ? service.groupsFor(filterSettings) : []
  readonly property var summary: Docker.rollup(containers)
  readonly property var aggregate: service
    ? Docker.aggregateStats(containers, service.statsById)
    : { samples: 0 }
  readonly property bool daemonOk: service ? service.daemonOk : true

  // The mosaic fills the bar's icon area vertically and grows sideways. How far
  // sideways is capped by a width budget rather than a cell count: the budget
  // is the thing the user actually cares about, and it adapts on its own to a
  // shorter bar, where fewer rows fit and the mosaic would otherwise sprawl.
  // Rounded at the source: a fractional height makes the cell size and the row
  // offsets fractional too, and the whole grid rasterises unevenly.
  readonly property real mosaicHeight: Math.max(6, Math.round(barSize - Style.space(10)))

  readonly property var resolved: Docker.planMosaic(containers, {
    groupBy: root.groupBy,
    // Sizes are picked on the device grid, not the logical one: with
    // QT_SCALE_FACTOR set to anything but 1 the two do not line up, and cells
    // that are equal in logical pixels render at different sizes.
    devicePixelRatio: Screen.devicePixelRatio,
    heightPx: root.mosaicHeight,
    gapPx: root.cellGap,
    blockGapPx: root.stackGap,
    cellSizePx: root.cellSize,
    groupStacks: root.groupStacks,
    maxWidthPx: Style.space(root.maxWidth)
  })

  // ---------------------------------------------------- metric rotation

  property int metricIndex: 0

  readonly property string metricText: metrics.length > 0
    ? Docker.metricLabel(metrics[metricIndex % metrics.length], aggregate, summary)
    : ""

  // Reserved once, from the widest string each configured metric can produce.
  // Sizing to the current value instead would shove every widget to the right
  // of this one across the bar on every rotation.
  readonly property string metricWidthSample:
    Docker.metricWidthSample(metrics, summary)

  function advanceMetric() {
    if (metrics.length > 0) metricIndex = (metricIndex + 1) % metrics.length
  }

  Timer {
    running: root.metrics.length > 1 && root.visible
    repeat: true
    interval: root.metricRotateMs
    onTriggered: root.advanceMetric()
  }

  // ------------------------------------------------------------ tooltip

  readonly property string tooltipText: {
    if (!daemonOk) return service ? service.errorText : "Docker indisponível"
    if (containers.length === 0) return "Nenhum container"

    var lines = []
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i]
      if (group.worst === "ok" || group.worst === "idle") continue
      var bad = []
      for (var j = 0; j < group.containers.length; j++) {
        var container = group.containers[j]
        if (container.cell === "ok" || container.cell === "idle") continue
        bad.push(container.service + " " + container.state)
      }
      lines.push(group.project + ": " + bad.join(", "))
    }

    // What one cell means is not self-evident, especially once the mosaic
    // collapses to stacks — so the tooltip says it outright.
    var head = resolved.mode === "stack"
      ? resolved.cells.length + " stacks · " + summary.running + "/" + summary.total + " containers"
      : summary.running + "/" + summary.total + " containers em "
        + resolved.grid.blocks + " stacks"

    if (lines.length === 0) return head
    return head + "\n" + lines.join("\n")
  }

  // --------------------------------------------------------- lifecycle

  // What this widget has told the service, so a resync never double-counts.
  property bool registeredVisible: false

  // The host injects `bar` after the widget is constructed, so at
  // Component.onCompleted `service` is still null and a registration made there
  // is lost — the service then counts zero watchers forever and never samples
  // CPU or memory. Registering on every input instead, guarded so repeats are
  // free, is what makes it land.
  function syncVisibility() {
    if (!service) return
    var wanted = visible
    if (wanted === registeredVisible) return
    service.setWidgetVisible(wanted)
    registeredVisible = wanted
  }

  onServiceChanged: {
    pushSettings()
    syncVisibility()
  }

  Component.onCompleted: {
    pushSettings()
    syncVisibility()
  }

  onVisibleChanged: syncVisibility()
  onOpenedChanged: if (service) service.setPanelOpen(opened)

  Component.onDestruction: {
    if (!service) return
    if (registeredVisible) service.setWidgetVisible(false)
    if (opened) service.setPanelOpen(false)
  }

  IpcHandler {
    target: "avila.docker"

    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void { if (root.service) root.service.refresh() }

    // The bar runs one widget per monitor but only one IPC handler, so a plain
    // `open` always lands on whichever copy registered first. This finds the
    // copy that lives on the named monitor and opens that one instead — what a
    // keybinding wants, which is the panel on the screen you are looking at.
    function openOn(monitor: string): void {
      var widget = root.widgetOnMonitor(monitor)
      if (widget) widget.open()
      else root.open()
    }

    function toggleOn(monitor: string): void {
      var widget = root.widgetOnMonitor(monitor)
      if (widget) widget.toggle()
      else root.toggle()
    }
    function lazydocker(): void { if (root.service) root.service.openLazydocker(null) }

    // Scoped to one compose project, by name.
    function stack(project: string): void {
      if (!root.service) return
      var groups = root.groups
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].project === project) {
          root.service.openLazydocker(groups[i])
          return
        }
      }
      root.service.openLazydocker(null)
    }
  }

  // Anything that deletes goes through here. The message says what will be
  // removed and how much, because "are you sure?" teaches people to click yes.
  property var pendingConfirm: null

  function askConfirm(message, confirmText, action) {
    pendingConfirm = action
    confirmDialog.message = message
    confirmDialog.confirmText = confirmText
    confirmDialog.opened = true
  }

  ConfirmDialog {
    id: confirmDialog
    cancelText: "Cancelar"
    onConfirmed: {
      var action = root.pendingConfirm
      root.pendingConfirm = null
      confirmDialog.opened = false
      if (action) action()
    }
    onCanceled: {
      root.pendingConfirm = null
      confirmDialog.opened = false
    }
  }

  function widgetOnMonitor(monitor) {
    if (!monitor || !bar || typeof bar.moduleWidgets !== "function") return null
    var widgets = bar.moduleWidgets(root.moduleName) || []
    for (var i = 0; i < widgets.length; i++) {
      var widget = widgets[i]
      if (widget && widget.monitorName === monitor) return widget
    }
    return null
  }

  // ------------------------------------------------------- bar widget

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    // The mosaic is the content; the button's own text label is unused.
    hasVisualContent: true
    active: root.opened
    useActiveColor: false
    tooltipText: root.tooltipText
    fixedWidth: root.vertical ? root.barSize : content.implicitWidth + Style.space(17)
    fixedHeight: root.barSize

    onPressed: function(code) {
      if (code === Qt.MiddleButton) {
        // Straight to lazydocker for the whole daemon, without opening anything
        // of ours first.
        if (root.service) root.service.openLazydocker(null, root.monitorName)
        return
      }

      if (code === Qt.RightButton) {
        if (root.dockerUrl && root.service) root.service.openUrl(root.dockerUrl)
        else if (root.service) root.service.refresh()
        return
      }

      if (root.primaryAction === "lazydocker" && root.service)
        root.service.openLazydocker(null, root.monitorName)
      else root.toggle()
    }

    // Scrolling reaches the next metric without waiting out the rotation.
    onWheelMoved: function() { root.advanceMetric() }

    Row {
      id: content
      // Whole pixels, deliberately. anchors.centerIn lands on a half pixel
      // whenever the leftover space is odd, and the mosaic then rasterises with
      // cells of 4px and 5px and gaps that vanish between some of them — the
      // grid renders as a different shape than it is.
      x: Math.round((parent.width - implicitWidth) / 2)
      y: Math.round((parent.height - implicitHeight) / 2)
      spacing: root.metricText === "" ? 0 : Style.space(5)

      Mosaic {
        id: mosaic
        // Width comes from the mosaic itself: it reports what its cells need.
        width: implicitWidth
        height: Math.round(root.mosaicHeight)
        visible: root.daemonOk && root.resolved.cells.length > 0
        plan: root.resolved
        pulseRestarting: root.pulseRestarting
        okColor: root.foreground
        warnColor: Color.accent
        badColor: bar ? bar.urgent : Color.urgent
      }

      // Daemon down, or simply nothing running: both need a mark, and they are
      // not the same thing — the tooltip says which. Drawn rather than typed,
      // because a missing glyph in the bar font would render as nothing at all
      // and the widget would look broken instead of empty.
      Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.daemonOk || root.resolved.cells.length === 0
        width: root.mosaicHeight
        height: root.mosaicHeight
        color: "transparent"
        border.width: 1
        border.color: root.daemonOk ? root.dim : (bar ? bar.urgent : Color.urgent)
        radius: 2

        // A slash through the box for "no daemon"; an empty box for "no
        // containers".
        Rectangle {
          visible: !root.daemonOk
          anchors.centerIn: parent
          width: parent.width * 1.25
          height: 1
          rotation: -45
          color: bar ? bar.urgent : Color.urgent
        }
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.metricText !== ""
        text: root.metricText
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        horizontalAlignment: Text.AlignRight
        // Fixed to the widest possible value, never to the current one.
        width: metricSizer.implicitWidth

        Behavior on opacity { NumberAnimation { duration: 120 } }
      }
    }

    Text {
      id: metricSizer
      visible: false
      text: root.metricWidthSample
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  // ------------------------------------------------------------- popup

  PopupCard {
    id: card
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    contentWidth: card.fittedContentWidth(Style.space(640))
    contentHeight: card.fittedContentHeight(list.implicitHeight, Style.space(760))

    Flickable {
      id: flick
      anchors.fill: parent
      // Children of a Flickable are reparented onto its contentItem, whose
      // width is contentWidth and defaults to zero. Binding the column to
      // `parent.width` therefore gives it zero width, every label elides to
      // nothing, the column reports no height, and the popup opens invisible.
      contentWidth: width
      contentHeight: list.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds

      Column {
        id: list
        width: flick.width
        spacing: Style.space(6)

        // ---------------------------------------------------- header

        Item {
          width: parent.width
          height: header.implicitHeight

          Row {
            id: header
            width: parent.width
            spacing: Style.space(8)

            Text {
              anchors.verticalCenter: parent.verticalCenter
              text: root.daemonOk
                ? root.summary.running + "/" + root.summary.total + " containers"
                : (root.service ? root.service.errorText : "Docker indisponível")
              color: root.daemonOk ? root.foreground : (bar ? bar.urgent : Color.urgent)
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
              width: parent.width - actions.implicitWidth - Style.space(8)
              elide: Text.ElideRight
            }

            Row {
              id: actions
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              PanelActionButton {
                iconText: "󰑓"
                tooltipText: "Atualizar"
                foreground: root.dim
                hoverColor: root.foreground
                onClicked: if (root.service) root.service.refresh()
              }

              PanelActionButton {
                iconText: "󰡨"
                tooltipText: "Abrir lazydocker"
                foreground: root.dim
                hoverColor: root.foreground
                onClicked: if (root.service) root.service.openLazydocker(null, root.monitorName)
              }
            }
          }
        }

        // ---------------------------------------------------- stacks

        Repeater {
          model: root.groups

          Column {
            required property var modelData

            width: list.width
            spacing: Style.space(2)

            PanelSeparator { width: parent.width }

            // ------------------------------------- stack header

            Row {
              width: parent.width
              spacing: Style.space(6)

              Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(6)
                height: Style.space(6)
                radius: width / 2
                color: modelData.worst === "bad"
                  ? (bar ? bar.urgent : Color.urgent)
                  : (modelData.worst === "warn" ? Color.accent : root.foreground)
                opacity: modelData.worst === "idle" ? 0.35 : 1
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: modelData.project
                // Plain text, always: `service` and `project` come from image
                // labels, which any image can set to anything. Qt's AutoText
                // would parse a crafted one as rich text.
                textFormat: Text.PlainText
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                elide: Text.ElideRight
                width: parent.width - stackActions.implicitWidth - Style.space(60)
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: modelData.running + "/" + modelData.total
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Row {
                id: stackActions
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(2)

                PanelActionButton {
                  // Whether the stack is up decides which half of the pair is
                  // offered: a stack with nothing running has nothing to stop.
                  iconText: modelData.running > 0 ? "󰓛" : "󰐊"
                  tooltipText: modelData.running > 0
                    ? "Parar o stack inteiro"
                    : "Iniciar o stack inteiro"
                  foreground: root.dim
                  hoverColor: root.foreground
                  enabled: root.service && !root.service.isBusy(modelData.project)
                  opacity: enabled ? 1 : 0.4
                  onClicked: {
                    if (!root.service) return
                    root.service.runStack(
                      modelData.running > 0 ? "stop" : "start", modelData)
                  }
                }

                PanelActionButton {
                  iconText: "󰑓"
                  tooltipText: "Reiniciar o stack"
                  foreground: root.dim
                  hoverColor: root.foreground
                  enabled: root.service && !root.service.isBusy(modelData.project)
                  opacity: enabled ? 1 : 0.4
                  onClicked: if (root.service) root.service.runStack("restart", modelData)
                }

                PanelActionButton {
                  iconText: "󰡨"
                  // Loose containers were not started by compose, so there is no
                  // project for lazydocker to scope to.
                  tooltipText: Docker.canScopeLazydocker(modelData)
                    ? "lazydocker neste stack"
                    : "lazydocker (sem stack para escopar)"
                  foreground: root.dim
                  hoverColor: root.foreground
                  onClicked: if (root.service) root.service.openLazydocker(modelData, root.monitorName)
                }
              }
            }

            // ---------------------------------------- containers

            Repeater {
              model: modelData.containers

              Row {
                id: portRow
                required property var modelData

                readonly property var containerData: modelData
                readonly property var actions: Docker.containerActions(modelData)
                readonly property var sample: root.service
                  ? root.service.statsFor(modelData.id) : null
                readonly property bool busy: root.service
                  ? root.service.isBusy(modelData.id) : false

                width: list.width
                spacing: Style.space(6)
                leftPadding: Style.space(12)

                Rectangle {
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(5)
                  height: Style.space(5)
                  radius: width / 2
                  color: modelData.cell === "bad"
                    ? (bar ? bar.urgent : Color.urgent)
                    : (modelData.cell === "warn" ? Color.accent : root.foreground)
                  opacity: modelData.cell === "idle" ? 0.35 : 1
                }

                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  text: modelData.service
                  textFormat: Text.PlainText
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  width: Style.space(112)
                }

                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  text: modelData.status
                  textFormat: Text.PlainText
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  width: Style.space(88)
                }

                // A published port is something to open, not to read out.
                Row {
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(64)
                  spacing: Style.space(4)

                  Repeater {
                    model: modelData.ports.slice(0, 2)

                    Text {
                      required property var modelData
                      readonly property var container: portRow.containerData

                      text: modelData
                      textFormat: Text.PlainText
                      color: portMouse.containsMouse ? Color.accent : root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.underline: portMouse.containsMouse

                      MouseArea {
                        id: portMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: if (root.service)
                          root.service.openPort(parent.text, root.monitorName)
                      }
                    }
                  }
                }

                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  // An em dash where there is no sample yet: zero would be a
                  // measurement, and this is the absence of one.
                  text: sample
                    ? Docker.formatPercent(sample.cpu) + " · " + Docker.formatBytes(sample.memUsed)
                    : "—"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  horizontalAlignment: Text.AlignRight
                  width: Style.space(88)
                }

                Row {
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(2)
                  opacity: busy ? 0.4 : 1

                  PanelActionButton {
                    // Material Design range only: the bar font on this system
                    // has no Font Awesome glyphs, and a missing one renders as
                    // nothing at all — a button that is simply not there.
                    iconText: "󰈙"
                    tooltipText: "Logs"
                    foreground: root.dim
                    hoverColor: root.foreground
                    onClicked: if (root.service) root.service.openContainerView("logs", modelData, root.monitorName)
                  }

                  PanelActionButton {
                    iconText: "󰚩"
                    tooltipText: "Analisar o log com o agente padrão"
                    foreground: root.dim
                    hoverColor: root.foreground
                    onClicked: if (root.service) root.service.askAgent(modelData, root.monitorName)
                  }

                  PanelActionButton {
                    iconText: "󰆍"
                    tooltipText: "Shell no container"
                    foreground: root.dim
                    hoverColor: root.foreground
                    visible: portRow.actions.canShell
                    onClicked: if (root.service) root.service.openContainerView("shell", modelData, root.monitorName)
                  }

                  PanelActionButton {
                    iconText: "󰐊"
                    tooltipText: "Despausar"
                    foreground: root.dim
                    hoverColor: root.foreground
                    visible: portRow.actions.canUnpause
                    enabled: !busy
                    onClicked: if (root.service) root.service.runContainer("unpause", modelData)
                  }

                  PanelActionButton {
                    // Only the action the container can actually take: a start
                    // button on something that is already up teaches people
                    // that the buttons are decoration.
                    iconText: portRow.actions.canStop ? "󰓛" : "󰐊"
                    tooltipText: portRow.actions.canStop ? "Parar" : "Iniciar"
                    foreground: root.dim
                    hoverColor: root.foreground
                    visible: (portRow.actions.canStop || portRow.actions.canStart)
                      && !portRow.actions.canUnpause
                    enabled: !busy
                    onClicked: {
                      if (!root.service) return
                      root.service.runContainer(portRow.actions.canStop ? "stop" : "start", modelData)
                    }
                  }

                  PanelActionButton {
                    iconText: "󰑓"
                    tooltipText: "Reiniciar"
                    foreground: root.dim
                    hoverColor: root.foreground
                    visible: portRow.actions.canRestart
                    enabled: !busy
                    onClicked: if (root.service) root.service.runContainer("restart", modelData)
                  }

                  PanelActionButton {
                    iconText: "󰩹"
                    tooltipText: "Remover o container"
                    foreground: root.dim
                    hoverColor: bar ? bar.urgent : Color.urgent
                    visible: portRow.actions.canRemove
                    enabled: !busy
                    onClicked: root.askConfirm(
                      Docker.removeConfirmMessage(modelData),
                      "Remover",
                      function() { if (root.service) root.service.removeContainer(modelData) })
                  }
                }
              }
            }
          }
        }
        // -------------------------------------------------- clean up

        Column {
          width: list.width
          spacing: Style.space(2)
          visible: root.daemonOk && root.service && root.service.dfRows.length > 0

          PanelSeparator { width: parent.width }

          Row {
            width: parent.width
            spacing: Style.space(6)

            Text {
              anchors.verticalCenter: parent.verticalCenter
              text: "Espaço recuperável"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              width: parent.width - reclaimTotal.implicitWidth - Style.space(6)
              elide: Text.ElideRight
            }

            Text {
              id: reclaimTotal
              anchors.verticalCenter: parent.verticalCenter
              text: root.service ? Docker.formatBytes(root.service.reclaimable) : ""
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          Repeater {
            model: root.service ? root.service.pruneTargets : []

            Row {
              required property var modelData

              readonly property bool busy: root.service
                ? root.service.isBusy(modelData.id) : false
              readonly property bool worthIt: modelData.reclaimable !== 0

              width: list.width
              spacing: Style.space(6)
              leftPadding: Style.space(12)
              opacity: worthIt ? 1 : 0.4

              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: modelData.label
                textFormat: Text.PlainText
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                width: Style.space(150)
                elide: Text.ElideRight
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                // A dash where the size is not knowable: `system df` has no row
                // for dangling images, and printing 0B there would read as
                // "nothing to do" when there may be plenty.
                text: modelData.reclaimable >= 0
                  ? Docker.formatBytes(modelData.reclaimable) : "—"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                horizontalAlignment: Text.AlignRight
                width: Style.space(80)
              }

              PanelActionButton {
                anchors.verticalCenter: parent.verticalCenter
                iconText: "󰩹"
                tooltipText: modelData.detail
                foreground: root.dim
                hoverColor: root.foreground
                enabled: !busy && worthIt
                opacity: enabled ? 1 : 0.4
                onClicked: root.askConfirm(
                  Docker.pruneConfirmMessage(modelData),
                  "Limpar",
                  function() { if (root.service) root.service.prune(modelData) })
              }
            }
          }

          Row {
            width: list.width
            spacing: Style.space(6)
            leftPadding: Style.space(12)
            visible: root.service && root.service.volumesRow

            Text {
              text: "volumes"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              width: Style.space(150)
            }

            Text {
              text: root.service && root.service.volumesRow
                ? Docker.formatBytes(root.service.volumesRow.reclaimable) : ""
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignRight
              width: Style.space(80)
            }

            Text {
              // Listed, never pruned from here. Everything above can be rebuilt
              // or pulled again; a volume is the one thing that is data.
              text: "não removido daqui"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.italic: true
            }
          }
        }
      }
    }
  }
}
