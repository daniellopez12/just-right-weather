import QtQuick

Item {
    property var anchorItem
    property var owner
    property var bar
    property bool open
    property bool centerOnBar
    property var focusTarget
    property real contentWidth
    property real contentHeight
    width: contentWidth
    height: contentHeight
    visible: open
    function fittedContentWidth(value) { return Math.min(600, value) }
    function fittedContentHeight(value) { return Math.min(950, value) }
}
