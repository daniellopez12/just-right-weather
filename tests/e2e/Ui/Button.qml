import QtQuick

Rectangle {
    property string text
    property color foreground
    signal clicked()
    width: label.implicitWidth + 16
    height: 28
    color: "transparent"
    Text {
        id: label
        anchors.centerIn: parent
        text: parent.text
        color: parent.foreground
    }
    MouseArea {
        anchors.fill: parent
        onClicked: parent.clicked()
    }
}
