// The bar mosaic. One cell per container, grouped into a block of columns per
// compose stack; or one cell per stack when the detailed view does not fit the
// width budget.
//
// All the arithmetic lives in Docker.planMosaic(), which is plain JS and
// tested. This file only turns the plan into pixels.

import QtQuick
import QtQuick.Window
import qs.Commons

Item {
  id: root

  // The object returned by Docker.planMosaic().
  property var plan: ({ cells: [], grid: { cells: [] }, cellPx: 0, gapPx: 1, blockGapPx: 0, width: 0 })
  property bool pulseRestarting: true
  // Passed in by the panel, which owns the rule for deriving a warning colour
  // when the theme sets `accent` equal to the foreground.
  property color okColor: Color.foreground
  property color warnColor: Color.accent
  property color badColor: Color.urgent

  readonly property var cells: plan.cells || []
  readonly property var placements: plan.grid && plan.grid.cells ? plan.grid.cells : []

  implicitWidth: plan.width || 0
  implicitHeight: plan.height || 0

  // Rounding the cell to whole pixels can leave a pixel or two spare; keep the
  // rows centred in the space rather than pinned to the top.
  readonly property real topInset: Math.floor((height - (plan.height || 0)) / 2)

  // The bar places this widget on a fractional scene coordinate — measured at
  // x = 1381.296875 on the machine this was written for. Whole-pixel cells then
  // straddle pixel boundaries and rasterise at three or four pixels depending on
  // where each one lands, so a grid of identical cells renders as a grid of
  // visibly different ones.
  //
  // mapToItem is a function call, not a binding, so a correction computed from
  // it is stale by the time it matters — our own x never moves (we are first in
  // the row) and the row shifts without telling us. Walking the parent chain and
  // reading each `x` DOES bind: QML records every property read during the
  // evaluation, so this re-runs whenever any ancestor moves.
  readonly property real absoluteX: {
    var total = 0
    var item = root
    while (item) {
      total += item.x
      item = item.parent
    }
    return total
  }

  readonly property real absoluteY: {
    var total = 0
    var item = root
    while (item) {
      total += item.y
      item = item.parent
    }
    return total
  }

  // Shift the cells back onto the pixel grid.
  readonly property real snapX: absoluteX - Math.floor(absoluteX)
  readonly property real snapY: absoluteY - Math.floor(absoluteY)

  function colorFor(state) {
    if (state === "bad") return badColor
    if (state === "warn") return warnColor
    return okColor
  }

  // A container that stopped cleanly is not news. Dimming rather than hiding
  // keeps the mosaic the same shape whether or not everything is running.
  function opacityFor(state) {
    return state === "idle" ? 0.35 : 1
  }

  function restartingIn(cell) {
    var containers = cell.containers || []
    for (var i = 0; i < containers.length; i++) {
      if (containers[i].state === "restarting") return true
    }
    return false
  }

  Repeater {
    model: root.cells

    Rectangle {
      id: cellRect

      required property int index
      required property var modelData

      readonly property var placement: root.placements[index]
      readonly property bool restarting: root.pulseRestarting && root.restartingIn(modelData)

      // The extra block gap is what separates one stack from the next: cells of
      // the same stack sit adjacent, and the wider space marks the boundary.
      // Without it adjacency is not separation, and there is no way to see
      // where a stack ends.
      x: placement
        ? placement.column * (root.plan.cellPx + root.plan.gapPx)
          + placement.block * root.plan.blockGapPx - root.snapX
        : 0
      y: placement
        ? root.topInset + placement.row * (root.plan.cellPx + root.plan.gapPx)
          - root.snapY
        : 0
      width: root.plan.cellPx
      height: root.plan.cellPx
      radius: root.plan.cellPx > 6 ? 1.5 : 0

      color: root.colorFor(modelData.cell)
      opacity: root.opacityFor(modelData.cell)

      Behavior on color { ColorAnimation { duration: 200 } }
      Behavior on opacity { NumberAnimation { duration: 200 } }

      // The only movement in the widget, spent on the one state that otherwise
      // goes unnoticed for hours.
      SequentialAnimation on opacity {
        running: cellRect.restarting
        loops: Animation.Infinite
        alwaysRunToEnd: true
        NumberAnimation { to: 0.3; duration: 1000; easing.type: Easing.InOutSine }
        NumberAnimation { to: 1.0; duration: 1000; easing.type: Easing.InOutSine }
      }
    }
  }
}
