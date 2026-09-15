import QtQuick
import qs.Commons
import "Model.js" as Model

Column {
  id: root
  required property var entries
  required property color foreground
  required property string fontFamily
  required property bool useImperial
  property string status: ""
  readonly property real cellWidth: Style.space(82)
  readonly property double firstTime: entries.length ? entries[0].time : 0
  width: parent.width
  spacing: Style.space(10)

  function scrollBy(direction) {
    hours.contentX = Math.max(0, Math.min(hours.contentWidth - hours.width,
      hours.contentX + direction * root.cellWidth * 4))
  }

  onFirstTimeChanged: hours.contentX = 0
  onEntriesChanged: graph.requestPaint()
  onForegroundChanged: graph.requestPaint()

  Row {
    width: parent.width
    spacing: Style.space(8)

    Text {
      width: parent.width - navigation.width - parent.spacing
      text: "HOURLY \u00b7 NEXT 48 HOURS"
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      font.letterSpacing: 1
      anchors.verticalCenter: parent.verticalCenter
    }

    Row {
      id: navigation
      spacing: Style.space(8)
      Repeater {
        model: [-1, 1]
        Rectangle {
          required property int modelData
          width: Style.space(28)
          height: Style.space(24)
          color: pointer.containsMouse ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"
          radius: Style.cornerRadius
          opacity: enabled ? 1 : 0.3
          enabled: modelData < 0 ? hours.contentX > 0 : hours.contentX < hours.contentWidth - hours.width
          Text {
            anchors.centerIn: parent
            text: parent.modelData < 0 ? "\u2039" : "\u203a"
            color: pointer.containsMouse ? Style.hoverStateColor(root.foreground, Color.accent) : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
          }
          MouseArea {
            id: pointer
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.scrollBy(parent.modelData)
          }
        }
      }
    }
  }

  Flickable {
    id: hours
    width: parent.width
    height: Style.space(205)
    contentWidth: root.entries.length * root.cellWidth
    contentHeight: height
    clip: true
    flickableDirection: Flickable.HorizontalFlick
    boundsBehavior: Flickable.StopAtBounds

    Row {
      Repeater {
        model: root.entries
        Item {
          required property var modelData
          required property int index
          width: root.cellWidth
          height: hours.height
          readonly property bool solar: modelData.kind !== "hour"

          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            y: Style.space(2)
            text: modelData.label
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }
          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            y: Style.space(23)
            text: index === 0 || modelData.date !== root.entries[index - 1].date
              ? modelData.date.slice(5).replace("-", "/") : ""
            color: root.foreground
            opacity: 0.55
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            y: Style.space(44)
            text: modelData.icon
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.displayLarge
          }
          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            y: Style.space(82)
            text: parent.solar ? (modelData.kind === "sunset" ? "Sunset" : "Sunrise")
              : Model.hourlyTemperature(modelData.temperature, root.useImperial)
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: parent.solar ? Style.font.body : Style.font.title
            font.bold: true
          }
          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            y: Style.space(160)
            text: parent.solar ? "" : "\uf043 " + (modelData.probability === null || modelData.probability === undefined
              ? "\u2014" : modelData.probability + "%")
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }
          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            y: Style.space(184)
            text: parent.solar ? "" : Model.hourlyPrecipitation(modelData.precipitation, root.useImperial)
            color: root.foreground
            opacity: 0.6
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }

    Canvas {
      id: graph
      x: hours.contentX
      y: Style.space(114)
      width: hours.width
      height: Style.space(36)
      onXChanged: requestPaint()
      onWidthChanged: requestPaint()
      onHeightChanged: requestPaint()
      onPaint: {
        var ctx = getContext("2d")
        ctx.reset()
        var points = []
        var minimum = Infinity
        var maximum = -Infinity
        for (var i = 0; i < root.entries.length; i++) {
          var entry = root.entries[i]
          if (entry.kind !== "hour" || entry.temperature === null || entry.temperature === undefined
              || !isFinite(Number(entry.temperature))) continue
          var temperature = Number(entry.temperature)
          minimum = Math.min(minimum, temperature)
          maximum = Math.max(maximum, temperature)
          points.push({ x: (i + 0.5) * root.cellWidth - hours.contentX, temperature: temperature, index: i })
        }
        ctx.strokeStyle = root.foreground
        ctx.fillStyle = root.foreground
        ctx.lineWidth = Style.space(2)
        ctx.beginPath()
        for (var j = 0; j < points.length; j++) {
          var point = points[j]
          point.y = maximum === minimum ? height / 2
            : Style.space(4) + (maximum - point.temperature) / (maximum - minimum) * (height - Style.space(8))
          var previous = j > 0 ? points[j - 1] : null
          var connected = previous && root.entries[point.index].time - root.entries[previous.index].time === 3600000
          if (connected) ctx.lineTo(point.x, point.y)
          else ctx.moveTo(point.x, point.y)
        }
        ctx.stroke()
        for (var k = 0; k < points.length; k++) {
          ctx.beginPath()
          ctx.arc(points[k].x, points[k].y, Style.space(3), 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
  }

  Text {
    width: parent.width
    text: root.status || "Precipitation chance / amount \u00b7 Drag or use arrows"
    color: root.foreground
    opacity: 0.6
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.Wrap
  }
}
