import QtQuick

Item {
    width: 800
    height: 1000
    property string moduleName
    property string ipcTarget
    property bool manageIpc
    property var bar: null
    readonly property bool opened: controller.active
    property QtObject controller: QtObject {
        property bool active: false
        function show() { active = true }
        function hide() { active = false }
    }
    function setting(name, fallback) { return name === "unit" ? "metric" : fallback }
}
