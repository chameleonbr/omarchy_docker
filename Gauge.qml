// One measurement against its ceiling.
//
// Always with the denominator: "15%" of what, "3.2GB" of how much. A number
// with no ceiling is one nobody can act on, which is the failure mode of every
// dashboard that shows a percentage on its own.

import QtQuick
import qs.Commons

Item {
  id: root

  property string label: ""
  property real value: 0
  property real max: 0
  property string text: ""
  property color foreground: Color.foreground
  property color dim: Qt.darker(foreground, 1.55)
  property color fill: Color.accent
  property string fontFamily: Style.font.family

  readonly property real fraction: max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  // Nothing measured yet reads as an empty track, not as a full one.
  readonly property bool measured: text !== "—" && text !== ""

  implicitHeight: column.implicitHeight

  Column {
    id: column
    width: parent.width
    spacing: Style.space(4)

    Row {
      width: parent.width

      Text {
        text: root.label
        color: root.dim
        font.bold: true
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        width: parent.width - reading.implicitWidth
        elide: Text.ElideRight
      }

      Text {
        id: reading
        text: root.text
        color: root.measured ? root.foreground : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    Rectangle {
      width: parent.width
      height: Math.max(2, Style.space(3))
      radius: height / 2
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

      Rectangle {
        width: parent.width * root.fraction
        height: parent.height
        radius: parent.radius
        color: root.fill
        visible: root.measured && root.fraction > 0

        Behavior on width {
          NumberAnimation { duration: 260; easing.type: Easing.OutCubic }
        }
      }
    }
  }
}
