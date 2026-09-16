pragma Singleton
import QtQuick

QtObject {
    readonly property var font: ({
        family: "Sans Serif", caption: 11, bodySmall: 12, body: 14,
        title: 18, display: 24, displayLarge: 28
    })
    readonly property var spacing: ({ hairline: 1 })
    readonly property real cornerRadius: 4
    function space(value) { return value }
    function hoverFillFor(foreground, accent) { return "#334455" }
    function hoverStateColor(foreground, accent) { return foreground }
}
