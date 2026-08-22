// A small toggle that reads as one of a set.
//
// Selected state is carried by fill, not by a border: a row of outlined chips
// with one filled is instantly readable, a row where the selected one merely
// has a thicker edge is not.

import QtQuick
import qs.Commons

Item {
  id: root

  property string label: ""
  property string badge: ""
  property bool selected: false
  property color foreground: Color.foreground
  property color dim: Qt.darker(foreground, 1.55)
  property color accent: Color.accent
  property string fontFamily: Style.font.family

  signal clicked()

  implicitWidth: text.implicitWidth + Style.space(16)
  implicitHeight: text.implicitHeight + Style.space(8)

  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius > 0 ? height / 2 : 0
    color: root.selected
      ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.18)
      : (mouse.containsMouse
        ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
        : "transparent")

    Behavior on color { ColorAnimation { duration: 120 } }
  }

  Text {
    id: text
    anchors.centerIn: parent
    text: root.badge !== "" ? root.label + " " + root.badge : root.label
    color: root.selected ? root.accent : root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    font.bold: root.selected
  }

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: root.clicked()
  }
}
