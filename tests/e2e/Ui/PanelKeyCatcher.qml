import QtQuick

Item {
    property bool blocked
    signal returnRequested()
    signal closeRequested()
    signal tabRequested(int direction)
}
