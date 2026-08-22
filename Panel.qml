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
  onOpenedChanged: {
    if (service) service.setPanelOpen(opened)
    // A filter that survives a close will eventually convince someone their
    // containers are gone.
    if (!opened) query = ""
  }

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

    // Open straight onto one tab, which is what a keybinding wants: "show me
    // the images" is a different intent from "show me the panel".
    function openTab(name: string): void {
      var widget = root.widgetOnMonitor(root.monitorName) || root
      widget.tab = Docker.TABS.indexOf(name) >= 0 ? name : "containers"
      widget.open()
    }

    function openTabOn(monitor: string, name: string): void {
      var widget = root.widgetOnMonitor(monitor) || root
      widget.tab = Docker.TABS.indexOf(name) >= 0 ? name : "containers"
      widget.open()
    }

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
  property bool cleanupOpen: false

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

  // Filter state. The query resets when the popup closes — a filter that
  // survives will eventually convince someone their containers are gone. The
  // view chip persists, because that one is a preference.
  property string tab: "containers"
  property var selection: ({})
  property string query: ""
  property string view: String(setting("view", "all"))
  property var collapsedStacks: ({})

  onTabChanged: {
    // Carrying a selection across tabs would let a click act on rows from a
    // list nobody is looking at.
    selection = ({})
    query = ""
    if (service) service.activeTab = tab
  }

  readonly property var tabItems: {
    if (tab === "containers") return []
    return service ? Docker.searchResources(service.resourcesFor(tab), query) : []
  }

  readonly property var tabGroups: Docker.groupResources(tabItems)

  readonly property var selectedItems: Docker.selectedFrom(tabItems, selection)
  readonly property int selectedCount: Docker.selectionCount(selection)

  function toggleRow(id) {
    selection = Docker.toggleSelection(selection, id)
  }

  function toggleGroup(group) {
    var ids = []
    for (var i = 0; i < group.items.length; i++) ids.push(group.items[i].id)
    selection = Docker.setSelection(selection, ids, !Docker.groupChecked(group.items, selection))
  }

  readonly property var visibleContainers:
    Docker.searchContainers(containers, { view: root.view, query: root.query })

  readonly property var visibleGroups: service
    ? Docker.sortGroups(Docker.groupByProject(visibleContainers)) : []

  readonly property bool filtering: query !== "" || view !== "all"

  function toggleStack(project) {
    var next = Object.assign({}, collapsedStacks)
    if (next[project]) delete next[project]
    else next[project] = true
    collapsedStacks = next
  }

  function isCollapsed(project) {
    return collapsedStacks[project] === true
  }

  PopupCard {
    id: card
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    contentWidth: card.fittedContentWidth(Style.space(660))
    contentHeight: card.fittedContentHeight(shell.implicitHeight, Style.space(820))

    Column {
      id: shell
      width: parent.width
      spacing: Style.space(10)

      // ------------------------------------------------------- header

      Row {
        width: parent.width
        spacing: Style.space(8)

        Rectangle {
          anchors.verticalCenter: parent.verticalCenter
          width: Style.space(7)
          height: Style.space(7)
          radius: width / 2
          color: root.daemonOk
            ? (root.summary.worst === "bad" ? (bar ? bar.urgent : Color.urgent)
              : (root.summary.worst === "warn" ? Color.accent : root.foreground))
            : (bar ? bar.urgent : Color.urgent)
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: root.service ? root.service.engineLabel : "Docker"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          // While a filter is on, the count says how much is hidden — a
          // filtered list must never look like a machine that lost containers.
          text: {
            if (!root.daemonOk) return root.service ? root.service.errorText : "indisponível"
            if (root.filtering) return root.visibleContainers.length + " de "
              + root.summary.total + " containers"
            return root.summary.running + "/" + root.summary.total + " containers"
          }
          color: root.daemonOk ? root.dim : (bar ? bar.urgent : Color.urgent)
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          width: parent.width - headerActions.implicitWidth - Style.space(140)
          elide: Text.ElideRight
        }

        Row {
          id: headerActions
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(2)

          PanelActionButton {
            iconText: root.daemonOk ? "󰓛" : "󰐊"
            tooltipText: root.daemonOk
              ? "Parar o daemon (e o socket)"
              : "Iniciar o daemon"
            foreground: root.dim
            hoverColor: root.foreground
            onClicked: {
              if (!root.service) return
              if (!root.daemonOk) { root.service.runDaemon("start"); return }
              root.askConfirm(
                "Parar o daemon do " + root.service.engineLabel + "?\n"
                  + "Todo container em execução para junto.",
                "Parar",
                function() { root.service.runDaemon("stop") })
            }
          }

          PanelActionButton {
            iconText: root.service && root.service.daemonAutostart === "enabled" ? "󰐥" : "󰤄"
            tooltipText: root.service && root.service.daemonAutostart === "enabled"
              ? "Inicia junto com o sistema — clique para desligar"
              : "Não inicia com o sistema — clique para ligar"
            foreground: root.service && root.service.daemonAutostart === "enabled"
              ? Color.accent : root.dim
            hoverColor: root.foreground
            onClicked: if (root.service) root.service.runDaemon(
              root.service.daemonAutostart === "enabled" ? "disable" : "enable")
          }

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

      // ------------------------------------------------------- gauges

      Row {
        width: parent.width
        spacing: Style.space(20)
        visible: root.daemonOk

        Gauge {
          width: (parent.width - Style.space(40)) / 3
          label: "CPU"
          value: root.service ? root.service.gauges.cpu.value : 0
          max: 100
          text: root.service ? root.service.gauges.cpu.text : "—"
          foreground: root.foreground
          dim: root.dim
          fontFamily: root.fontFamily
        }

        Gauge {
          width: (parent.width - Style.space(40)) / 3
          label: "RAM"
          value: root.service ? root.service.gauges.memory.value : 0
          max: root.service ? root.service.gauges.memory.max : 0
          text: root.service ? root.service.gauges.memory.text : "—"
          foreground: root.foreground
          dim: root.dim
          fontFamily: root.fontFamily
        }

        Gauge {
          width: (parent.width - Style.space(40)) / 3
          label: "DISCO"
          value: root.service ? root.service.gauges.disk.value : 0
          max: root.service ? root.service.gauges.disk.max : 0
          text: root.service ? root.service.gauges.disk.text : "—"
          foreground: root.foreground
          dim: root.dim
          fontFamily: root.fontFamily
        }
      }

      // --------------------------------------------------------- tabs

      Row {
        width: parent.width
        spacing: Style.space(2)
        visible: root.daemonOk

        Repeater {
          model: [
            { key: "containers", label: "containers" },
            { key: "images", label: "imagens" },
            { key: "volumes", label: "volumes" },
            { key: "networks", label: "redes" }
          ]

          Chip {
            required property var modelData

            readonly property int count: modelData.key === "containers"
              ? root.summary.total
              : (root.service ? root.service.resourcesFor(modelData.key).length : 0)

            label: modelData.label
            badge: count > 0 ? String(count) : ""
            selected: root.tab === modelData.key
            foreground: root.foreground
            dim: root.dim
            fontFamily: root.fontFamily
            onClicked: root.tab = modelData.key
          }
        }
      }

      // ------------------------------------------------------ toolbar

      Row {
        width: parent.width
        spacing: Style.space(6)
        visible: root.daemonOk

        TextField {
          id: search
          anchors.verticalCenter: parent.verticalCenter
          width: parent.width - (chips.visible ? chips.implicitWidth + Style.space(6) : 0)
          placeholderText: "serviço, stack, container ou imagem"
          foreground: root.foreground
          onTextChanged: root.query = text
        }

        Row {
          id: chips
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(2)
          // Running and stopped mean nothing for an image or a network.
          visible: root.tab === "containers"

          Repeater {
            model: [
              { key: "all", label: "todos" },
              { key: "running", label: "rodando" },
              { key: "stopped", label: "parados" }
            ]

            Chip {
              required property var modelData
              label: modelData.label
              selected: root.view === modelData.key
              foreground: root.foreground
              dim: root.dim
              fontFamily: root.fontFamily
              onClicked: root.view = modelData.key
            }
          }
        }
      }

      // --------------------------------------------------- daemon down

      Column {
        width: parent.width
        spacing: Style.space(6)
        visible: !root.daemonOk

        Text {
          width: parent.width
          wrapMode: Text.WordWrap
          // A list of zero containers with a dozen dead buttons is worse than
          // one sentence saying why there is nothing here.
          text: root.service ? root.service.errorText : ""
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }

      // ------------------------------------------------- command bar

      Rectangle {
        width: parent.width
        height: commandRow.implicitHeight + Style.space(10)
        radius: Style.cornerRadius > 0 ? Style.space(4) : 0
        // Only present when something is selected: a permanent bar of disabled
        // buttons is furniture.
        visible: root.daemonOk && root.selectedCount > 0
        color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.12)

        Row {
          id: commandRow
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          anchors.leftMargin: Style.space(8)
          anchors.rightMargin: Style.space(8)
          spacing: Style.space(8)

          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: root.selectedCount + (root.selectedCount === 1
              ? " selecionado" : " selecionados")
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
          }

          Chip {
            anchors.verticalCenter: parent.verticalCenter
            label: "limpar"
            foreground: root.foreground
            dim: root.dim
            fontFamily: root.fontFamily
            onClicked: root.selection = ({})
          }

          Item {
            width: parent.width - Style.space(280)
            height: 1
          }

          Chip {
            anchors.verticalCenter: parent.verticalCenter
            // One confirmation naming the count and the size, not one per item:
            // a dialog that appears eleven times is a dialog nobody reads.
            label: "remover"
            foreground: bar ? bar.urgent : Color.urgent
            dim: bar ? bar.urgent : Color.urgent
            fontFamily: root.fontFamily
            onClicked: {
              var items = root.selectedItems
              var removable = []
              for (var i = 0; i < items.length; i++) {
                if (Docker.canRemoveResource(items[i])) removable.push(items[i])
              }
              if (removable.length === 0) return
              root.askConfirm(
                Docker.resourceConfirmMessage(removable),
                "Remover",
                function() {
                  if (root.service) root.service.removeResources(removable)
                  root.selection = ({})
                })
            }
          }
        }
      }

      Text {
        width: parent.width
        wrapMode: Text.WordWrap
        // The engine saying no is the answer, not an obstacle to route around.
        visible: root.service && root.service.lastResourceError !== ""
        text: root.service ? root.service.lastResourceError : ""
        textFormat: Text.PlainText
        color: bar ? bar.urgent : Color.urgent
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      // --------------------------------------------------------- list

      Flickable {
        id: flick
        width: parent.width
        height: Math.min(list.implicitHeight, Style.space(520))
        visible: root.daemonOk
        contentWidth: width
        contentHeight: list.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
          id: list
          width: flick.width
          spacing: Style.space(6)

          Text {
            width: parent.width
            visible: root.tab === "containers" && root.visibleContainers.length === 0
            text: root.filtering
              ? "Nenhum container com esse filtro."
              : "Nenhum container."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            width: parent.width
            visible: root.tab !== "containers" && root.tabItems.length === 0
            text: root.query !== "" ? "Nada com esse filtro." : "Nada aqui."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          // ------------------------------------ images, volumes, networks

          Repeater {
            model: root.tab === "containers" ? [] : root.tabGroups

            Column {
              id: resourceBlock
              required property var modelData

              width: list.width
              spacing: Style.space(2)

              Rectangle {
                width: parent.width
                height: resourceHeader.implicitHeight + Style.space(10)
                radius: Style.cornerRadius > 0 ? Style.space(4) : 0
                color: resourceGroupHover.containsMouse
                  ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
                  : "transparent"

                MouseArea {
                  id: resourceGroupHover
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.toggleGroup(resourceBlock.modelData)
                }

                Row {
                  id: resourceHeader
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.leftMargin: Style.space(6)
                  anchors.rightMargin: Style.space(6)
                  spacing: Style.space(6)

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: Docker.groupChecked(resourceBlock.modelData.items, root.selection)
                      ? "󰄲" : "󰄱"
                    color: Docker.groupChecked(resourceBlock.modelData.items, root.selection)
                      ? Color.accent : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: resourceBlock.modelData.project
                    textFormat: Text.PlainText
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    font.bold: true
                    elide: Text.ElideRight
                    width: parent.width - Style.space(120)
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: resourceBlock.modelData.size > 0
                      ? Docker.formatBytes(resourceBlock.modelData.size)
                      : String(resourceBlock.modelData.items.length)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }
              }

              Repeater {
                model: resourceBlock.modelData.items

                Rectangle {
                  id: resourceRow
                  required property var modelData

                  readonly property bool checked: root.selection[modelData.id] === true
                  readonly property bool removable: Docker.canRemoveResource(modelData)

                  width: list.width
                  height: resourceRowContent.implicitHeight + Style.space(9)
                  radius: Style.cornerRadius > 0 ? Style.space(4) : 0
                  color: resourceRow.checked
                    ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.14)
                    : (resourceHover.containsMouse
                      ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)
                      : "transparent")

                  Behavior on color { ColorAnimation { duration: 120 } }

                  MouseArea {
                    id: resourceHover
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: resourceRow.removable ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onClicked: if (resourceRow.removable) root.toggleRow(resourceRow.modelData.id)
                  }

                  Row {
                    id: resourceRowContent
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(20)
                    anchors.rightMargin: Style.space(6)
                    spacing: Style.space(6)

                    Text {
                      anchors.verticalCenter: parent.verticalCenter
                      // The engine's own networks are listed, because they are
                      // part of the picture, and never selectable, because
                      // removing them breaks the engine.
                      text: !resourceRow.removable ? "󰌾"
                        : (resourceRow.checked ? "󰄲" : "󰄱")
                      color: resourceRow.checked ? Color.accent : root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }

                    Text {
                      anchors.verticalCenter: parent.verticalCenter
                      text: resourceRow.modelData.name
                      textFormat: Text.PlainText
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      elide: Text.ElideMiddle
                      width: Style.space(230)
                    }

                    Text {
                      anchors.verticalCenter: parent.verticalCenter
                      text: {
                        var parts = []
                        if (resourceRow.modelData.detail) parts.push(resourceRow.modelData.detail)
                        if (resourceRow.modelData.inUse) parts.push("em uso")
                        if (resourceRow.modelData.anonymous) parts.push("anônimo")
                        return parts.join(" · ")
                      }
                      textFormat: Text.PlainText
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      elide: Text.ElideRight
                      width: Math.max(Style.space(40),
                        resourceRowContent.width - Style.space(230) - Style.space(120))
                    }

                    Text {
                      anchors.verticalCenter: parent.verticalCenter
                      text: resourceRow.modelData.size > 0
                        ? Docker.formatBytes(resourceRow.modelData.size) : ""
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      horizontalAlignment: Text.AlignRight
                      width: Style.space(70)
                    }
                  }
                }
              }
            }
          }

          // ------------------------------------------------- containers

          Repeater {
            model: root.tab === "containers" ? root.visibleGroups : []

            Column {
              id: stackBlock
              required property var modelData

              readonly property bool collapsed: root.isCollapsed(modelData.project)

              width: list.width
              spacing: Style.space(2)

              // --------------------------------------- stack header

              Rectangle {
                width: parent.width
                height: stackRow.implicitHeight + Style.space(10)
                radius: Style.cornerRadius > 0 ? Style.space(4) : 0
                color: stackHover.containsMouse
                  ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
                  : "transparent"

                MouseArea {
                  id: stackHover
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.toggleStack(stackBlock.modelData.project)
                }

                Row {
                  id: stackRow
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.leftMargin: Style.space(6)
                  anchors.rightMargin: Style.space(6)
                  spacing: Style.space(6)

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: stackBlock.collapsed ? "▸" : "▾"
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }

                  Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: Style.space(6)
                    height: Style.space(6)
                    radius: width / 2
                    color: stackBlock.modelData.worst === "bad"
                      ? (bar ? bar.urgent : Color.urgent)
                      : (stackBlock.modelData.worst === "warn" ? Color.accent : root.foreground)
                    opacity: stackBlock.modelData.worst === "idle" ? 0.35 : 1
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: stackBlock.modelData.project
                    textFormat: Text.PlainText
                    color: root.foreground
                    font.family: root.fontFamily
                    // Hierarchy comes from size and weight, not from a second
                    // family: the whole shell is monospace by design, and a
                    // proportional font here would read as a foreign widget.
                    font.pixelSize: Style.font.bodySmall
                    font.bold: true
                    elide: Text.ElideRight
                    width: parent.width - stackActions.implicitWidth - Style.space(90)
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: stackBlock.modelData.running + "/" + stackBlock.modelData.total
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }

                  Row {
                    id: stackActions
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(2)

                    PanelActionButton {
                      iconText: stackBlock.modelData.running > 0 ? "󰓛" : "󰐊"
                      tooltipText: stackBlock.modelData.running > 0
                        ? "Parar o stack inteiro" : "Iniciar o stack inteiro"
                      foreground: root.dim
                      hoverColor: root.foreground
                      enabled: root.service && !root.service.isBusy(stackBlock.modelData.project)
                      opacity: enabled ? 1 : 0.4
                      onClicked: {
                        if (!root.service) return
                        root.service.runStack(
                          stackBlock.modelData.running > 0 ? "stop" : "start", stackBlock.modelData)
                      }
                    }

                    PanelActionButton {
                      iconText: "󰑓"
                      tooltipText: "Reiniciar o stack"
                      foreground: root.dim
                      hoverColor: root.foreground
                      enabled: root.service && !root.service.isBusy(stackBlock.modelData.project)
                      opacity: enabled ? 1 : 0.4
                      onClicked: if (root.service)
                        root.service.runStack("restart", stackBlock.modelData)
                    }

                    PanelActionButton {
                      iconText: "󰡨"
                      tooltipText: Docker.canScopeLazydocker(stackBlock.modelData)
                        ? "lazydocker neste stack"
                        : "lazydocker (sem stack para escopar)"
                      foreground: root.dim
                      hoverColor: root.foreground
                      onClicked: if (root.service)
                        root.service.openLazydocker(stackBlock.modelData, root.monitorName)
                    }
                  }
                }
              }

              // ----------------------------------------- containers

              Repeater {
                model: stackBlock.collapsed ? [] : stackBlock.modelData.containers

                Rectangle {
                  id: row
                  required property var modelData

                  readonly property var actions: Docker.containerActions(modelData)
                  readonly property var sample: root.service
                    ? root.service.statsFor(modelData.id) : null
                  readonly property var conflict: root.service
                    ? root.service.conflictFor(modelData.id) : null
                  readonly property bool busy: root.service
                    ? root.service.isBusy(modelData.id) : false
                  readonly property bool degraded:
                    modelData.cell === "bad" || modelData.cell === "warn"
                  readonly property color stateColor: modelData.cell === "bad"
                    ? (bar ? bar.urgent : Color.urgent)
                    : (modelData.cell === "warn" ? Color.accent : root.foreground)

                  width: list.width
                  height: containerRow.implicitHeight + Style.space(9)
                  radius: Style.cornerRadius > 0 ? Style.space(4) : 0

                  // Degraded rows are tinted so a problem is findable without
                  // reading — the same principle the mosaic runs on. Healthy
                  // rows stay plain, or the tint stops meaning anything.
                  color: row.degraded
                    ? Qt.rgba(row.stateColor.r, row.stateColor.g, row.stateColor.b, 0.16)
                    : (rowHover.containsMouse
                      ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)
                      : "transparent")

                  Behavior on color { ColorAnimation { duration: 120 } }

                  // A tint alone washes out against a busy wallpaper. The edge
                  // is what actually carries down the list at a glance.
                  Rectangle {
                    anchors.left: parent.left
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    width: Style.space(2)
                    radius: parent.radius
                    visible: row.degraded
                    color: row.stateColor
                  }

                  MouseArea {
                    id: rowHover
                    anchors.fill: parent
                    hoverEnabled: true
                    acceptedButtons: Qt.NoButton
                  }

                  Row {
                    id: containerRow
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(20)
                    anchors.rightMargin: Style.space(6)
                    spacing: Style.space(6)

                    Rectangle {
                      anchors.verticalCenter: parent.verticalCenter
                      width: Style.space(5)
                      height: Style.space(5)
                      radius: width / 2
                      color: row.stateColor
                      opacity: row.modelData.cell === "idle" ? 0.35 : 1
                    }

                    Text {
                      anchors.verticalCenter: parent.verticalCenter
                      text: row.modelData.service
                      textFormat: Text.PlainText
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      elide: Text.ElideRight
                      width: Style.space(112)
                    }

                    Text {
                      anchors.verticalCenter: parent.verticalCenter
                      text: row.modelData.status
                      textFormat: Text.PlainText
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      elide: Text.ElideRight
                      // Takes whatever is left rather than a fixed column: a
                      // fixed one leaves a hole in the middle of every row on a
                      // wide card, and truncates on a narrow one.
                      width: Math.max(Style.space(50),
                        containerRow.width - Style.space(112) - portsRow.width
                          - Style.space(88) - rowActions.implicitWidth - Style.space(40))
                    }

                    // Ports: clickable, and marked when something else already
                    // holds them. The engine's own error at start time names
                    // the port and not the culprit.
                    Row {
                      id: portsRow
                      anchors.verticalCenter: parent.verticalCenter
                      // Collapses when there is nothing published, instead of
                      // holding a column of empty space down the whole list.
                      width: row.modelData.ports.length > 0 ? Style.space(74) : 0
                      spacing: Style.space(4)

                      Repeater {
                        model: row.modelData.ports.slice(0, 2)

                        Text {
                          required property var modelData

                          readonly property bool blocked: {
                            var list = row.conflict || []
                            for (var i = 0; i < list.length; i++) {
                              if (list[i].port === modelData) return true
                            }
                            return false
                          }

                          text: (blocked ? "⚠" : "") + modelData
                          textFormat: Text.PlainText
                          color: blocked
                            ? (bar ? bar.urgent : Color.urgent)
                            : (portMouse.containsMouse ? Color.accent : root.dim)
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                          font.underline: portMouse.containsMouse && !blocked

                          MouseArea {
                            id: portMouse
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onEntered: if (parent.blocked && root.bar)
                              root.bar.showTooltip(parent, Docker.conflictText(row.conflict))
                            onExited: if (root.bar) root.bar.hideTooltip(parent)
                            onClicked: if (root.service && !parent.blocked)
                              root.service.openPort(parent.modelData, root.monitorName)
                          }
                        }
                      }
                    }

                    Text {
                      anchors.verticalCenter: parent.verticalCenter
                      text: row.sample
                        ? Docker.formatPercent(row.sample.cpu) + " · "
                          + Docker.formatBytes(row.sample.memUsed)
                        : "—"
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      horizontalAlignment: Text.AlignRight
                      width: Style.space(88)
                    }

                    // Revealed on hover, except on a degraded row: the row you
                    // need to act on should not require a hover to discover.
                    // The width is reserved either way, so nothing shifts.
                    Row {
                      id: rowActions
                      anchors.verticalCenter: parent.verticalCenter
                      spacing: Style.space(2)
                      opacity: row.busy ? 0.4
                        : (row.degraded || rowHover.containsMouse ? 1 : 0)

                      Behavior on opacity { NumberAnimation { duration: 120 } }

                      PanelActionButton {
                        iconText: "󰈙"
                        tooltipText: "Logs"
                        foreground: root.dim
                        hoverColor: root.foreground
                        onClicked: if (root.service)
                          root.service.openContainerView("logs", row.modelData, root.monitorName)
                      }

                      PanelActionButton {
                        iconText: "󰚩"
                        tooltipText: "Analisar o log com o agente padrão"
                        foreground: root.dim
                        hoverColor: root.foreground
                        onClicked: if (root.service)
                          root.service.askAgent(row.modelData, root.monitorName)
                      }

                      PanelActionButton {
                        iconText: "󰆍"
                        tooltipText: "Shell no container"
                        foreground: root.dim
                        hoverColor: root.foreground
                        visible: row.actions.canShell
                        onClicked: if (root.service)
                          root.service.openContainerView("shell", row.modelData, root.monitorName)
                      }

                      PanelActionButton {
                        iconText: "󰐊"
                        tooltipText: "Despausar"
                        foreground: root.dim
                        hoverColor: root.foreground
                        visible: row.actions.canUnpause
                        enabled: !row.busy
                        onClicked: if (root.service)
                          root.service.runContainer("unpause", row.modelData)
                      }

                      PanelActionButton {
                        iconText: row.actions.canStop ? "󰓛" : "󰐊"
                        tooltipText: row.actions.canStop ? "Parar" : "Iniciar"
                        foreground: root.dim
                        hoverColor: root.foreground
                        visible: (row.actions.canStop || row.actions.canStart)
                          && !row.actions.canUnpause
                        enabled: !row.busy
                        onClicked: {
                          if (!root.service) return
                          root.service.runContainer(
                            row.actions.canStop ? "stop" : "start", row.modelData)
                        }
                      }

                      PanelActionButton {
                        iconText: "󰑓"
                        tooltipText: "Reiniciar"
                        foreground: root.dim
                        hoverColor: root.foreground
                        visible: row.actions.canRestart
                        enabled: !row.busy
                        onClicked: if (root.service)
                          root.service.runContainer("restart", row.modelData)
                      }

                      PanelActionButton {
                        iconText: "󰩹"
                        tooltipText: "Remover o container"
                        foreground: root.dim
                        hoverColor: bar ? bar.urgent : Color.urgent
                        visible: row.actions.canRemove
                        enabled: !row.busy
                        onClicked: root.askConfirm(
                          Docker.removeConfirmMessage(row.modelData),
                          "Remover",
                          function() { if (root.service) root.service.removeContainer(row.modelData) })
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // ------------------------------------------------------- footer

      Column {
        width: parent.width
        spacing: Style.space(3)
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
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: root.service ? Docker.formatBytes(root.service.reclaimable) : ""
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            width: parent.width - Style.space(180)
            horizontalAlignment: Text.AlignRight
          }

          Chip {
            anchors.verticalCenter: parent.verticalCenter
            label: root.cleanupOpen ? "fechar" : "ver"
            foreground: root.foreground
            dim: root.dim
            fontFamily: root.fontFamily
            onClicked: root.cleanupOpen = !root.cleanupOpen
          }
        }

        Column {
          width: parent.width
          spacing: Style.space(2)
          visible: root.cleanupOpen

          Repeater {
            model: root.service ? root.service.pruneTargets : []

            Row {
              required property var modelData

              readonly property bool busy: root.service
                ? root.service.isBusy(modelData.id) : false
              readonly property bool worthIt: modelData.reclaimable !== 0

              width: parent.width
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
                width: Style.space(160)
                elide: Text.ElideRight
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
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
            width: parent.width
            spacing: Style.space(6)
            leftPadding: Style.space(12)
            visible: root.service && root.service.volumesRow

            Text {
              text: "volumes"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              width: Style.space(160)
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
