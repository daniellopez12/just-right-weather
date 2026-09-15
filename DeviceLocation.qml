import QtQuick
import QtPositioning

Item {
  id: root
  signal located(var location)
  signal failed(string message)
  property bool requesting: false

  function request() {
    if (!source.valid) {
      failed("No device location source. Use a ZIP code or paste latitude, longitude.")
      return
    }
    requesting = true
    deadline.restart()
    source.update(20000)
  }

  function cancel() {
    requesting = false
    deadline.stop()
    source.stop()
  }

  PositionSource {
    id: source
    active: false
    onPositionChanged: {
      if (!root.requesting || !position.latitudeValid || !position.longitudeValid) return
      var coordinate = position.coordinate
      var accuracy = position.horizontalAccuracyValid
        ? "Accuracy: about " + Math.round(position.horizontalAccuracy) + " m" : "Accuracy not reported"
      root.cancel()
      root.located({
        name: "Device location",
        description: accuracy + " (may be network-based, not GPS)",
        latitude: coordinate.latitude,
        longitude: coordinate.longitude
      })
    }
    onSourceErrorChanged: {
      if (!root.requesting || sourceError === PositionSource.NoError) return
      root.cancel()
      root.failed("Device location unavailable or permission denied. Use ZIP or coordinates instead.")
    }
  }

  Timer {
    id: deadline
    interval: 21000
    onTriggered: {
      root.cancel()
      root.failed("Device location timed out. Use ZIP or coordinates instead.")
    }
  }
}
