import QtQuick
import QtQuick.Window
import Quickshell
import "production" as Weather
import "driver.js" as Driver

ShellRoot {
    id: harness
    readonly property string server: Quickshell.env("WEATHER_E2E_SERVER")
    readonly property string scenario: Quickshell.env("WEATHER_E2E_SCENARIO")
    readonly property var panel: weather.item
    property var steps: []
    property int stepIndex: 0
    property double stepStarted: 0
    property int assertions: 0
    property bool finished: false
    property bool controlled: false
    property var stats: null

    Window {
        width: 800
        height: 1000
        visible: true
        Loader {
            id: weather
            active: false
            sourceComponent: Weather.Panel {}
            onStatusChanged: if (status === Loader.Error) Driver.fail(harness, "Panel component failed to load")
        }
    }

    function loadPanel() { weather.active = true }

    Timer {
        interval: 20
        running: !harness.finished
        repeat: true
        onTriggered: Driver.tick(harness)
    }

    Component.onCompleted: Driver.start(harness)
}
