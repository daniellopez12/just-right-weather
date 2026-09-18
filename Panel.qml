import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "Network.js" as Network

Panel {
  id: root
  moduleName: "io.github.daniellopez12.just-right-weather"
  ipcTarget: "io.github.daniellopez12.just-right-weather"
  manageIpc: false

  property var anchorItem: null
  property bool openedFromHotkey: false
  readonly property color foreground: Color.popups.text
  readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family

  // The bar tracks the widget mounted in its slot — BarWidget.qml — not this
  // nested panel. Everything the bar identifies a panel by has to be that
  // widget: the popout coordinator (and with it the open-panel dot under the
  // pill) compares against `slot.activeItem`, and switchPanelFrom looks the
  // slot up the same way.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  function open() {
    openedFromHotkey = false
    setCenterHoverRevealSuppressed(false)
    root.controller.show()
    locationFile.reload()
    root.refresh()
  }

  function openFromHotkey() {
    openedFromHotkey = true
    root.controller.show()
    locationFile.reload()
    root.refresh()
    // Set after showing, not before: showing hands the popout coordinator
    // over, which closes whichever panel was open, and that close clears the
    // shared flag. Deferring means the panel taking over always wins, while
    // a handoff to a panel that does not manage the flag still leaves it
    // cleared rather than stuck on.
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    if (root.editingLocation) root.cancelEditingLocation()
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function")
      root.bar.setCenterHoverRevealSuppressed(value)
    else if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  // Parsed wttr.in j1 response. Kept on failure so stale data stays visible.
  property var report: null
  property string reportLocationQuery: ""
  property var dailyForecastReport: null
  property double forecastClock: Date.now()
  property double hourlyUpdatedAt: 0
  property string hourlyLocationQuery: ""
  property bool hourlyFetchFailed: false
  readonly property var hourlyEntries: hourlyLocationQuery === locationQuery
    ? Model.hourlyForecast(dailyForecastReport, forecastClock, 48) : []
  readonly property string hourlyStatus: hourlyFetchFailed && hourlyEntries.length > 0
    ? "Update failed \u00b7 Showing last forecast"
    : (hourlyUpdatedAt > 0 && forecastClock - hourlyUpdatedAt > root.refreshMinutes * 120000
      ? "Forecast may be outdated \u00b7 Middle-click weather to retry" : "")
  property string wttrLocation: ""
  property bool locationReady: false
  property bool cacheReady: false
  property bool weatherReady: false
  property var weatherCache: null
  property bool cacheWritePending: false
  property bool cacheWriteInFlight: false
  readonly property string weatherCachePath: (Quickshell.env("XDG_CACHE_HOME")
    || Quickshell.env("HOME") + "/.cache") + "/just-right-weather/forecast.json"

  function initializeWeather() {
    if (weatherReady || !locationReady || !cacheReady) return
    if (weatherCache && weatherCache.locationQuery === locationQuery) {
      if (weatherCache.report) {
        report = weatherCache.report.data
        reportLocationQuery = weatherCache.locationQuery
      }
      if (weatherCache.dailyForecast) {
        dailyForecastReport = weatherCache.dailyForecast.data
        hourlyUpdatedAt = weatherCache.dailyForecast.updatedAt
        hourlyLocationQuery = weatherCache.locationQuery
      }
      label = Model.currentIcon(openMeteoCurrent, Model.currentIcon(current, ""))
    }
    // Restore before starting any network request, without blocking the shell.
    weatherReady = true
  }

  function cacheWeatherResponse(source, data, updatedAt) {
    weatherCache = Model.updatedWeatherCache(weatherCache, locationQuery, source, data, updatedAt)
    cacheWritePending = true
    Qt.callLater(writeWeatherCache)
  }

  function writeWeatherCache() {
    if (cacheWriteInFlight || !cacheWritePending) return
    cacheWritePending = false
    try {
      var text = Network.responseText(JSON.stringify(weatherCache), 0, 0, 512 * 1024)
      // FileView does not emit saved for identical content.
      if (text === weatherCacheFile.text()) return
      cacheWriteInFlight = true
      weatherCacheFile.setText(text)
    } catch (e) {
      cacheWriteInFlight = false
      console.warn("Weather cache write failed: " + e)
    }
  }

  FileView {
    id: weatherCacheFile
    path: root.weatherCachePath
    blockLoading: false
    blockWrites: false
    atomicWrites: true
    printErrors: false
    onLoaded: {
      if (root.cacheReady) return
      try {
        root.weatherCache = Model.parseWeatherCache(Network.responseText(text(), 0, 0, 512 * 1024))
      } catch (e) {
        console.warn("Weather cache load failed: " + e)
      }
      root.cacheReady = true
      Qt.callLater(root.initializeWeather)
    }
    onLoadFailed: function(error) {
      if (error !== FileViewError.FileNotFound)
        console.warn("Weather cache load failed: " + FileViewError.toString(error))
      root.cacheReady = true
      Qt.callLater(root.initializeWeather)
    }
    onSaved: {
      root.cacheWriteInFlight = false
      if (root.cacheWritePending) Qt.callLater(root.writeWeatherCache)
    }
    onSaveFailed: function(error) {
      root.cacheWriteInFlight = false
      console.warn("Weather cache write failed: " + FileViewError.toString(error))
      if (root.cacheWritePending) Qt.callLater(root.writeWeatherCache)
    }
  }

  Timer {
    interval: 60000
    running: root.opened
    repeat: true
    onTriggered: root.forecastClock = Date.now()
  }

  // Configured location, read from the weather.json state file (owned by
  // omarchy-weather-location). The query is the wttr.in path segment
  // (coordinates when stored, else the encoded name); empty means IP
  // auto-detect. The watch makes hand edits take effect live.
  property var configuredLocationState: ({ name: "", latitude: null, longitude: null })
  readonly property string configuredLocation: configuredLocationState.name
  readonly property string locationQuery: Model.wttrLocationQuery(configuredLocationState.name, configuredLocationState.latitude, configuredLocationState.longitude)

  // Keep the previous report visible while the new location loads. The
  // editor remains open with a spinner, so stale data is never presented
  // under the newly configured location label.
  onLocationQueryChanged: {
    if (!weatherReady) return
    if (savingLocation) savingLocationQueryStarted = true
    forecastRetries = 0
    dailyForecastRetries = 0
    forecastRetryTimer.stop()
    dailyForecastRetryTimer.stop()
    forecastProc.running = false
    dailyForecastProc.running = false
    Qt.callLater(refresh)
  }

  property FileView locationFile: FileView {
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/weather.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.loadConfiguredLocation(text())
    onLoadFailed: root.loadConfiguredLocation("")
  }

  function loadConfiguredLocation(text) {
    configuredLocationState = Model.parseLocationFile(text)
    locationReady = true
    Qt.callLater(initializeWeather)
  }

  // The first read can race shell startup (observed sporadically), leaving a
  // stored location unhonored until the next file write. One delayed reload
  // self-corrects; if the first read was fine it's a no-op, since identical
  // state doesn't change locationQuery and so triggers no refetch.
  Timer {
    interval: 1500
    running: true
    onTriggered: locationFile.reload()
  }

  property int forecastRetries: 0
  property int dailyForecastRetries: 0

  // Click-to-edit state for the location label.
  property bool editingLocation: false
  property bool savingLocation: false
  property bool savingLocationQueryStarted: false
  property var locationSuggestions: []
  property int suggestionIndex: 0
  property string geocodePendingQuery: ""
  property string geocodeActiveQuery: ""
  property string geocodeResultsQuery: ""
  property string locationError: ""
  property bool locatingDevice: false
  property var pendingLocation: null

  // Shared hero/bar icon state, updated with each successful weather response.
  property string label: ""

  // wttr's current conditions when available; open-meteo's (bundled with the
  // much faster daily forecast fetch) fill the hero while wttr is in flight.
  readonly property bool hasConfiguredCoordinates: !isNaN(parseFloat(String(configuredLocationState.latitude))) && !isNaN(parseFloat(String(configuredLocationState.longitude)))
  readonly property var openMeteoCurrent: Model.openMeteoCurrentCondition(dailyForecastReport)
  readonly property var current: (hasConfiguredCoordinates && openMeteoCurrent) ? openMeteoCurrent : ((report && report.current_condition && report.current_condition[0]) ? report.current_condition[0] : openMeteoCurrent)
  readonly property var areaInfo: report && report.nearest_area && report.nearest_area[0] ? report.nearest_area[0] : null
  readonly property var forecastDays: buildForecastDays()
  readonly property string reportCountry: areaInfo && areaInfo.country && areaInfo.country[0] ? areaInfo.country[0].value : ""

  readonly property bool useImperial: Model.shouldUseImperial(setting("unit", ""), Qt.locale().name, reportCountry)

  // Auto-refresh interval in minutes; clamped to a sane minimum.
  readonly property int refreshMinutes: Math.max(1, parseInt(setting("refreshMinutes", 15), 10) || 15)

  readonly property string reportLocation:  configuredLocation || wttrLocation || (areaInfo && areaInfo.areaName && areaInfo.areaName[0] ? areaInfo.areaName[0].value : "")
  readonly property string reportTempNum:   current ? String(useImperial ? current.temp_F : current.temp_C) : ""
  readonly property string tempUnit:        "°" + (useImperial ? "F" : "C")
  readonly property string reportFeels:     current ? formatTemp(useImperial ? current.FeelsLikeF : current.FeelsLikeC) : ""
  readonly property string reportWind:      current ? (useImperial ? (current.windspeedMiles + " mph") : (current.windspeedKmph + " km/h")) : ""
  readonly property string reportHumidity:  current ? (current.humidity + "%") : ""

  function refresh() {
    if (!weatherReady) return
    forecastClock = Date.now()
    // Each full refresh cycle gets a fresh retry budget, so an earlier
    // exhausted round (e.g. waking with the network still down) doesn't
    // starve retries for the rest of the session.
    forecastRetries = 0
    dailyForecastRetries = 0
    refreshForecast()
    if (root.locationQuery === "" && !locationProc.running) locationProc.running = true
    // With stored coordinates this fetches open-meteo right away — no need
    // to wait for the slow wttr response. Without them it's a no-op until
    // wttr reports the detected area.
    refreshDailyForecast(null)
  }

  function refreshForecast() {
    if (forecastProc.running) return
    forecastProc.requestQuery = locationQuery
    forecastProc.running = true
  }

  function refreshDailyForecast(sourceReport) {
    if (dailyForecastProc.running) return

    var lat = parseFloat(String(root.configuredLocationState.latitude))
    var lon = parseFloat(String(root.configuredLocationState.longitude))
    if (isNaN(lat) || isNaN(lon)) {
      var area = sourceReport && sourceReport.nearest_area && sourceReport.nearest_area[0]
        ? sourceReport.nearest_area[0] : (reportLocationQuery === locationQuery ? root.areaInfo : null)
      if (!area) return
      lat = parseFloat(String(area.latitude || ""))
      lon = parseFloat(String(area.longitude || ""))
    }
    if (isNaN(lat) || isNaN(lon)) return

    var url = "https://api.open-meteo.com/v1/forecast"
      + "?latitude=" + encodeURIComponent(String(lat))
      + "&longitude=" + encodeURIComponent(String(lon))
      + "&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset"
      + "&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,is_day"
      + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day"
      + "&forecast_days=4"
      + "&timezone=auto"
    dailyForecastProc.command = Network.curlCommand(url, 5, Network.responseLimits.dailyForecast)
    dailyForecastProc.requestQuery = locationQuery
    dailyForecastProc.running = true
  }

  // ---- Location editing. Clicking the location label swaps it for a search
  //      field; picking a geocoded suggestion persists name + coordinates to
  //      weather.json state file. An empty commit returns to auto.
  function startEditingLocation() {
    editingLocation = true
    savingLocation = false
    savingLocationQueryStarted = false
    locationSuggestions = []
    locationError = ""
    suggestionIndex = 0
    Qt.callLater(function() {
      locationField.text = root.configuredLocation
      locationField.selectAll()
      locationField.forceActiveFocus()
    })
  }

  function cancelEditingLocation() {
    editingLocation = false
    savingLocation = false
    savingLocationQueryStarted = false
    locationSuggestions = []
    geocodeDebounce.stop()
    geocodeProc.running = false
    geocodePendingQuery = ""
    locatingDevice = false
    if (deviceLocation.item) deviceLocation.item.cancel()
    Qt.callLater(function() { if (keyCatcher) keyCatcher.forceActiveFocus() })
  }

  function commitLocation() {
    var query = locationField.text.trim()
    if (query === "") {
      clearLocation()
      return
    }
    if (geocodeProc.running || geocodeDebounce.running || query !== geocodeResultsQuery || !locationSuggestions.length) {
      locationError = "Choose a matching location below before saving."
      return
    }
    pickSuggestion(locationSuggestions[suggestionIndex])
  }

  function clearLocation() {
    persistLocation("", null, null)
    wttrLocation = ""
    cancelEditingLocation()
  }

  function pickSuggestion(suggestion) {
    if (!suggestion) return
    if (!Model.validCoordinates(suggestion.latitude, suggestion.longitude)) {
      locationError = "This location has invalid coordinates."
      return
    }
    geocodeDebounce.stop()
    geocodeProc.running = false
    if (deviceLocation.item) deviceLocation.item.cancel()
    locatingDevice = false
    locationError = ""
    savingLocation = true
    savingLocationQueryStarted = false
    pendingLocation = {
      name: suggestion.name,
      latitude: suggestion.latitude,
      longitude: suggestion.longitude
    }
    persistLocation(suggestion.name, suggestion.latitude, suggestion.longitude)
  }

  function finishSavingLocation() {
    if (savingLocation && savingLocationQueryStarted) cancelEditingLocation()
  }

  function persistLocation(name, latitude, longitude) {
    if (name && latitude !== null && longitude !== null)
      locationSaveProc.command = ["omarchy-weather-location", "--set", name, latitude + "," + longitude]
    else if (name)
      locationSaveProc.command = ["omarchy-weather-location", "--set", name]
    else
      locationSaveProc.command = ["omarchy-weather-location", "--clear"]
    locationSaveProc.running = true
  }

  // Debounced geocoding. Only one curl runs at a time; if the query moved on
  // while a fetch was in flight, the latest query is fetched right after.
  function requestGeocode() {
    var query = locationField.text.trim()
    if (query.length < 2) {
      locationSuggestions = []
      return
    }
    geocodePendingQuery = query
    if (!geocodeProc.running) startGeocode()
  }

  function startGeocode() {
    if (!editingLocation || geocodePendingQuery.length < 2) return
    geocodeActiveQuery = geocodePendingQuery
    geocodeProc.command = Network.curlCommand(Model.locationSearchUrl(geocodeActiveQuery),
      5, Network.responseLimits.geocode)
    geocodeProc.running = true
  }

  function locationQueryEdited() {
    locationSuggestions = []
    locationError = ""
    geocodeResultsQuery = ""
    geocodeProc.running = false
    geocodePendingQuery = ""
    if (deviceLocation.item) deviceLocation.item.cancel()
    locatingDevice = false
    var query = locationField.text.trim()
    var coordinate = Model.coordinateLocation(query)
    if (query === configuredLocation && hasConfiguredCoordinates) {
      geocodeDebounce.stop()
      geocodeResultsQuery = query
      locationSuggestions = [{
        name: configuredLocation,
        description: "Saved pin: " + configuredLocationState.latitude + ", " + configuredLocationState.longitude,
        latitude: configuredLocationState.latitude,
        longitude: configuredLocationState.longitude
      }]
    } else if (coordinate) {
      geocodeDebounce.stop()
      geocodeResultsQuery = query
      locationSuggestions = [coordinate]
    } else if (/^[+\-\d.\s]+,[+\-\d.\s]+$/.test(query)) {
      geocodeDebounce.stop()
      locationError = "Latitude must be -90 to 90; longitude must be -180 to 180."
    } else {
      geocodeDebounce.restart()
    }
  }

  function locateDevice() {
    geocodeDebounce.stop()
    geocodeProc.running = false
    geocodePendingQuery = ""
    locationSuggestions = []
    locationError = ""
    locatingDevice = true
    if (deviceLocation.item) deviceLocation.item.request()
    else deviceLocation.active = true
  }

  Loader {
    id: deviceLocation
    active: false
    source: Qt.resolvedUrl("DeviceLocation.qml")
    onLoaded: item.request()
    onStatusChanged: {
      if (status === Loader.Error) {
        root.locatingDevice = false
        root.locationError = "Device location support unavailable. Use ZIP or coordinates."
      }
    }
  }

  Connections {
    target: deviceLocation.item
    function onLocated(location) {
      root.locatingDevice = false
      root.locationSuggestions = [location]
      root.suggestionIndex = 0
      root.geocodeResultsQuery = locationField.text.trim()
    }
    function onFailed(message) {
      root.locatingDevice = false
      root.locationError = message
    }
  }

  function buildForecastDays() {
    return Model.buildForecastDays(report, dailyForecastReport, Qt.formatDate(new Date(), "yyyy-MM-dd"))
  }

  function openMeteoForecastDays() {
    return Model.openMeteoForecastDays(dailyForecastReport, Qt.formatDate(new Date(), "yyyy-MM-dd"))
  }

  function wttrNextForecastDays() {
    return Model.wttrNextForecastDays(report, Qt.formatDate(new Date(), "yyyy-MM-dd"))
  }

  function isFutureForecastDate(dateString) {
    return Model.isFutureForecastDate(dateString, Qt.formatDate(new Date(), "yyyy-MM-dd"))
  }

  function roundedTemp(value) {
    return Model.roundedTemp(value)
  }

  function celsiusToFahrenheit(value) {
    return Model.celsiusToFahrenheit(value)
  }

  function formatTemp(value) {
    return Model.formatTemp(value, useImperial)
  }

  function dayName(dateString) {
    return Model.dayName(dateString, function(date) { return Qt.formatDate(date, "dddd") })
  }

  // Bare degree value (no unit letter), used in the forecast row.
  function bareTempForDay(day, kind) {
    return Model.bareTempForDay(day, kind, useImperial)
  }

  // Representative icon for a forecast day: the hourly entry nearest noon.
  function dayIcon(day) {
    return Model.dayIcon(day)
  }

  function iconForOpenMeteoCode(code) {
    return Model.iconForOpenMeteoCode(code)
  }

  // Mirrors omarchy-weather-icon's wttr.in code → nerd-font glyph mapping.
  function iconForCode(code, night) {
    return Model.iconForCode(code, night)
  }

  Process {
    id: forecastProc
    property string requestQuery: ""
    command: Network.curlCommand("https://wttr.in/" + root.locationQuery + "?format=j1",
      10, Network.responseLimits.forecast)
    stdout: StdioCollector {
      id: forecastOutput
      waitForEnd: true
    }
    // Quickshell finishes the collector before emitting exited.
    onExited: function(exitCode, exitStatus) {
      if (requestQuery !== root.locationQuery) {
        Qt.callLater(root.refreshForecast)
        return
      }
      try {
        var raw = Network.responseText(forecastOutput.text, exitCode,
          exitStatus, Network.responseLimits.forecast)
        var parsed = JSON.parse(raw)
        if (!Model.validWeatherReport(parsed))
          throw new Error("No current conditions in weather response")
        root.report = parsed
        root.reportLocationQuery = root.locationQuery
        root.cacheWeatherResponse("report", parsed, Date.now())
        if (!root.hasConfiguredCoordinates)
          root.label = Model.provisionalCurrentIcon(parsed.current_condition && parsed.current_condition[0], root.label)
        root.forecastRetries = 0
        if (Model.weatherResponseCompletesSave(root.hasConfiguredCoordinates, "wttr"))
          root.finishSavingLocation()
        // Stored coordinates already drove the fast open-meteo fetch from
        // refresh(); only auto-detect needs the area wttr reported.
        if (isNaN(parseFloat(String(root.configuredLocationState.latitude))))
          root.refreshDailyForecast(parsed)
      } catch (e) {
        console.warn("Weather response failed: " + e)
        // Keep last-good report visible, but try again shortly.
        root.scheduleForecastRetry()
      }
    }
  }

  // wttr.in can be slow or flaky, especially for a location it hasn't
  // cached yet. Retry a few times before leaving it to the refresh timer.
  function scheduleForecastRetry() {
    if (forecastRetries >= 3) return
    forecastRetries++
    forecastRetryTimer.restart()
  }

  Timer {
    id: forecastRetryTimer
    interval: 2500
    onTriggered: root.refreshForecast()
  }

  // With configured coordinates this fetch is the only thing that updates the
  // bar icon, so a dropped response (e.g. waking before the network is back)
  // must retry rather than wait out the refresh timer with a stale icon.
  function scheduleDailyForecastRetry() {
    if (dailyForecastRetries >= 3) return
    dailyForecastRetries++
    dailyForecastRetryTimer.restart()
  }

  Timer {
    id: dailyForecastRetryTimer
    interval: 2500
    onTriggered: root.refreshDailyForecast(null)
  }

  Process {
    id: dailyForecastProc
    property string requestQuery: ""
    stdout: StdioCollector {
      id: dailyForecastOutput
      waitForEnd: true
    }
    onExited: function(exitCode, exitStatus) {
      if (requestQuery !== root.locationQuery) {
        Qt.callLater(root.refreshDailyForecast, null)
        return
      }
      try {
        var raw = Network.responseText(dailyForecastOutput.text, exitCode,
          exitStatus, Network.responseLimits.dailyForecast)
        var parsed = JSON.parse(raw)
        if (parsed.error) throw new Error(parsed.reason || "Weather API error")
        if (Model.hourlyForecast(parsed, Date.now(), 48).length === 0)
          throw new Error("No upcoming hourly forecast in weather response")
        var parsedCurrent = Model.openMeteoCurrentCondition(parsed)
        root.dailyForecastReport = parsed
        root.forecastClock = Date.now()
        root.hourlyUpdatedAt = root.forecastClock
        root.hourlyLocationQuery = root.locationQuery
        root.cacheWeatherResponse("dailyForecast", parsed, root.hourlyUpdatedAt)
        root.hourlyFetchFailed = false
        root.label = Model.currentIcon(parsedCurrent, root.label)
        root.dailyForecastRetries = 0
        if (Model.weatherResponseCompletesSave(root.hasConfiguredCoordinates, "open-meteo"))
          root.finishSavingLocation()
      } catch (e) {
        root.hourlyFetchFailed = true
        console.warn("Hourly weather response failed: " + e)
        // Keep last-good daily forecast visible, but try again shortly.
        root.scheduleDailyForecastRetry()
      }
    }
  }

  Process {
    id: geocodeProc
    stdout: StdioCollector {
      id: geocodeOutput
      waitForEnd: true
    }
    onExited: function(exitCode, exitStatus) {
      if (root.editingLocation && locationField.text.trim() === root.geocodeActiveQuery) {
        try {
          var raw = Network.responseText(geocodeOutput.text, exitCode,
            exitStatus, Network.responseLimits.geocode)
          root.locationSuggestions = Model.parseLocationSearch(raw, root.geocodeActiveQuery)
          root.geocodeResultsQuery = root.geocodeActiveQuery
          root.locationError = root.locationSuggestions.length ? "" : "No locations found. Try a ZIP or a shorter city name."
          root.suggestionIndex = 0
        } catch (e) {
          root.locationSuggestions = []
          root.geocodeResultsQuery = ""
          root.locationError = exitCode !== 0 || exitStatus !== 0
            ? "Location lookup failed or ZIP not found. Try again."
            : "Could not read location results. Try again."
          console.warn("Weather location lookup failed: " + e)
        }
      }
      if (root.editingLocation && root.geocodePendingQuery.length >= 2 && root.geocodePendingQuery !== root.geocodeActiveQuery)
        Qt.callLater(root.startGeocode)
    }
  }

  Timer {
    id: geocodeDebounce
    interval: 300
    onTriggered: root.requestGeocode()
  }

  Process {
    id: locationSaveProc
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.savingLocation = false
        root.locationError = "Could not save the location. Please try again."
        return
      }
      if (!root.savingLocation) return
      if (root.pendingLocation) {
        root.configuredLocationState = root.pendingLocation
        root.pendingLocation = null
      }

      // FileView handles changed locations. Explicitly refresh here too so
      // saving the already-active location cannot strand the spinner.
      locationFile.reload()
      if (!root.savingLocationQueryStarted) {
        root.savingLocationQueryStarted = true
        root.forecastRetries = 0
        root.dailyForecastRetries = 0
        forecastProc.running = false
        dailyForecastProc.running = false
        Qt.callLater(root.refresh)
      }
    }
  }

  Process {
    id: locationProc
    command: Network.curlCommand("https://wttr.in/?format=%l", 4, Network.responseLimits.location)
    stdout: StdioCollector {
      id: locationOutput
      waitForEnd: true
    }
    onExited: function(exitCode, exitStatus) {
      try {
        var raw = Network.responseText(locationOutput.text, exitCode,
          exitStatus, Network.responseLimits.location)
        root.wttrLocation = raw.split(",")[0]
      } catch (e) {
        console.warn("Weather location response failed: " + e)
      }
    }
  }

  Timer {
    id: refreshTimer
    interval: root.refreshMinutes * 60 * 1000
    running: root.weatherReady
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.openFromHotkey() }
    function close(): void { root.close() }
    function show(): void { root.openFromHotkey() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function edit(): void { root.openFromHotkey(); root.startEditingLocation() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(600))
    contentHeight: panel.fittedContentHeight(weatherColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.editingLocation
      onReturnRequested: root.startEditingLocation()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Flickable {
        id: weatherScroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: weatherColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: weatherColumn
          width: weatherScroll.width
          spacing: Style.space(14)

      // ---- Hero row: big icon + temp on the left; location and stats stacked on the right.
      Item {
        width: parent.width
        height: Math.max(heroLeft.height, heroRight.height)

        Row {
          id: heroLeft
          anchors.left: parent.left
          anchors.leftMargin: Style.space(16)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(16)

          Text {
            id: heroIcon
            textFormat: Text.PlainText
            anchors.verticalCenter: parent.verticalCenter
            anchors.verticalCenterOffset: Style.space(5)
            text: root.label || "—"
            color: root.foreground
            font.family: root.fontFamily
            // Decorative condition emoji; intentionally larger than the
            // Style.font.* scale's displayLarge (28).
            font.pixelSize: Style.space(64)
          }

          Row {
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              id: tempBig
              textFormat: Text.PlainText
              text: root.reportTempNum || "—"
              color: root.foreground
              font.family: root.fontFamily
              // Hero temperature read-out; deliberately oversized, outside
              // the Style.font.* scale.
              font.pixelSize: Style.space(56)
              font.bold: true
            }
            Text {
              textFormat: Text.PlainText
              text: root.current ? root.tempUnit : ""
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
              anchors.top: tempBig.top
              anchors.topMargin: Style.space(10)
            }
          }
        }

        Column {
          id: heroRight
          width: Math.min(Style.space(300), parent.width - heroLeft.width - Style.space(48))
          anchors.right: parent.right
          anchors.rightMargin: Style.space(20)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(12)

          Row {
            visible: !root.editingLocation && root.reportLocation !== ""
            spacing: Style.space(6)

            TapHandler {
              onTapped: root.startEditingLocation()
            }
            HoverHandler {
              cursorShape: Qt.PointingHandCursor
            }

            Text {
              text: ""  // nf-fa-map_marker
              color: root.foreground
              opacity: 0.7
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              anchors.verticalCenter: parent.verticalCenter
            }
            Text {
              textFormat: Text.PlainText
              width: heroRight.width - Style.space(20)
              elide: Text.ElideRight
              text: (root.reportLocation || "").toUpperCase()
              color: root.foreground
              opacity: 0.7
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.letterSpacing: 1
              anchors.verticalCenter: parent.verticalCenter
            }
          }

          Row {
            visible: root.editingLocation
            spacing: Style.space(6)

            TextField {
              id: locationField
              width: heroRight.width - Style.space(28)
              enabled: !root.savingLocation
              placeholderText: "City, US ZIP, or lat, lon"
              foreground: root.foreground
              font.family: root.fontFamily

              onTextChanged: if (root.editingLocation && !root.savingLocation) root.locationQueryEdited()

              Keys.onPressed: function(event) {
                if (event.key === Qt.Key_Escape) {
                  root.cancelEditingLocation()
                  event.accepted = true
                } else if (event.key === Qt.Key_Down) {
                  if (root.suggestionIndex < root.locationSuggestions.length - 1) root.suggestionIndex++
                  event.accepted = true
                } else if (event.key === Qt.Key_Up) {
                  if (root.suggestionIndex > 0) root.suggestionIndex--
                  event.accepted = true
                } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                  root.commitLocation()
                  event.accepted = true
                }
              }
            }

            // Clear back to IP auto-detect. While a committed location is
            // loading, this same compact affordance becomes a spinner.
            Rectangle {
              width: Style.space(18)
              height: Style.space(18)
              anchors.verticalCenter: parent.verticalCenter
              radius: Math.min(4, Style.cornerRadius)
              color: !root.savingLocation && clearLocationArea.containsMouse ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"

              Text {
                textFormat: Text.PlainText
                anchors.centerIn: parent
                text: root.savingLocation ? "󰦖" : "✕"
                font.family: root.fontFamily
                color: root.foreground
                opacity: 0.7
                font.pixelSize: Style.font.bodySmall

                RotationAnimator on rotation {
                  running: root.savingLocation
                  from: 0; to: 360
                  duration: 800
                  loops: Animation.Infinite
                }
              }

              MouseArea {
                id: clearLocationArea
                anchors.fill: parent
                enabled: !root.savingLocation
                hoverEnabled: true
                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: root.clearLocation()
              }
            }
          }

          Row {
            id: weatherStats
            visible: !!root.current
            spacing: Style.space(36)

            Column {
              spacing: Style.space(5)
              Text {
                text: "FEELS"
                color: root.foreground
                opacity: 0.7
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                font.letterSpacing: 1
              }
              Text {
                textFormat: Text.PlainText
                text: root.reportFeels
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }
            }

            Column {
              spacing: Style.space(5)
              Text {
                text: "WIND"
                color: root.foreground
                opacity: 0.7
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                font.letterSpacing: 1
              }
              Text {
                textFormat: Text.PlainText
                text: root.reportWind
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }
            }

            Column {
              spacing: Style.space(5)
              Text {
                text: "HUMID"
                color: root.foreground
                opacity: 0.7
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                font.letterSpacing: 1
              }
              Text {
                textFormat: Text.PlainText
                text: root.reportHumidity
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }
            }
          }
        }
      }

      Column {
        visible: root.editingLocation
        width: parent.width
        spacing: Style.space(8)

        Flow {
          width: parent.width
          spacing: Style.space(8)
          Button {
            text: root.locatingDevice ? "Locating..." : "Use device location"
            foreground: root.foreground
            enabled: !root.savingLocation && !root.locatingDevice
            onClicked: root.locateDevice()
          }
          Button {
            text: "View saved pin on map"
            foreground: root.foreground
            enabled: root.hasConfiguredCoordinates
            onClicked: Qt.openUrlExternally(Model.locationMapUrl(root.configuredLocationState.latitude, root.configuredLocationState.longitude))
          }
        }

        Text {
          width: parent.width
          text: root.locationError || (root.locatingDevice ? "Requesting device position (up to 20 seconds)..."
            : geocodeProc.running ? "Searching..."
            : "Search for a city or US ZIP. Select a result to save.\nZIP pins are approximate. For an exact pin, paste latitude, longitude.\nDevice coordinates are sent to the weather providers only after you select them.\nSaving or clearing also changes the built-in Omarchy weather location.")
          wrapMode: Text.Wrap
          color: root.foreground
          opacity: 0.7
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          textFormat: Text.PlainText
          visible: root.hasConfiguredCoordinates
          width: parent.width
          text: "Saved: " + root.configuredLocation + "\n"
            + root.configuredLocationState.latitude + ", " + root.configuredLocationState.longitude
          wrapMode: Text.Wrap
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }

      // ---- Geocoding suggestions while the location is being edited.
      Column {
        visible: root.editingLocation && !root.savingLocation && root.locationSuggestions.length > 0
        width: parent.width
        spacing: 0

        Repeater {
          model: root.locationSuggestions

          Rectangle {
            required property var modelData
            required property int index
            width: parent.width
            height: suggestionRow.implicitHeight + Style.space(12)
            radius: Style.cornerRadius
            color: index === root.suggestionIndex ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"

            Column {
              id: suggestionRow
              width: parent.width - Style.space(32)
              anchors.left: parent.left
              anchors.leftMargin: Style.space(16)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              Text {
                textFormat: Text.PlainText
                width: parent.width
                elide: Text.ElideRight
                text: modelData.name
                color: index === root.suggestionIndex ? Style.hoverStateColor(root.foreground, Color.accent) : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
              Text {
                textFormat: Text.PlainText
                width: parent.width
                elide: Text.ElideRight
                visible: text !== ""
                text: modelData.description
                color: root.foreground
                opacity: 0.7
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }
            }

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onPositionChanged: root.suggestionIndex = index
              onClicked: root.pickSuggestion(modelData)
            }
          }
        }
      }

      Text {
        visible: !root.current
        text: "Fetching forecast…"
        color: root.foreground
        opacity: 0.7
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        font.italic: true
      }

      Rectangle {
        width: parent.width
        height: Style.spacing.hairline
        color: root.foreground
        opacity: 0.12
      }

      HourlyForecast {
        visible: root.hourlyEntries.length > 0
        entries: root.hourlyEntries
        foreground: root.foreground
        fontFamily: root.fontFamily
        useImperial: root.useImperial
        status: root.hourlyStatus
      }

      Text {
        visible: root.hourlyEntries.length === 0
        text: root.hourlyFetchFailed ? "Hourly forecast unavailable \u00b7 Middle-click weather to retry"
          : (dailyForecastProc.running || forecastProc.running ? "Fetching hourly forecast\u2026" : "Hourly forecast unavailable")
        color: root.foreground
        opacity: 0.7
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
      }

      // ---- Divider between current conditions and forecast.
      Rectangle {
        visible: root.forecastDays.length > 0
        width: parent.width
        height: Style.spacing.hairline
        color: root.foreground
        opacity: 0.12
      }

      // ---- Forecast row: each cell has the day icon left of a day-name + hi/lo column.
      //      Wrapped in an Item so the block of cells can be centered within the popup.
      Item {
        visible: root.forecastDays.length > 0
        width: parent.width
        height: forecastRow.height

        Row {
          id: forecastRow
          anchors.horizontalCenter: parent.horizontalCenter
          spacing: Style.space(44)

          Repeater {
            model: root.forecastDays

            Row {
              required property var modelData
              required property int index
              spacing: Style.space(10)

              Text {
                textFormat: Text.PlainText
                anchors.verticalCenter: parent.verticalCenter
                text: root.dayIcon(modelData)
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }

              Column {
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(2)

                Text {
                  textFormat: Text.PlainText
                  text: root.dayName(modelData.date).toUpperCase()
                  color: root.foreground
                  opacity: 0.7
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.letterSpacing: 1
                }

                Row {
                  spacing: Style.space(6)

                  Text {
                    textFormat: Text.PlainText
                    text: root.bareTempForDay(modelData, "max")
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                  Text {
                    textFormat: Text.PlainText
                    text: root.bareTempForDay(modelData, "min")
                    color: root.foreground
                    opacity: 0.7
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  }
  }

}
