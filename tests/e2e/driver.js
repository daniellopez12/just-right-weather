var h

function check(condition, message) {
    if (!condition) throw new Error(message)
    h.assertions++
}

function fail(harness, message) {
    harness.finished = true
    console.error("WEATHER_E2E_FAIL " + harness.scenario + ": " + message)
    Qt.quit()
}

function tick(harness) {
    harness.ticks++
    if (harness.finished || !harness.steps.length) return
    var step = harness.steps[harness.stepIndex]
    if (!harness.stepStarted) harness.stepStarted = Date.now()
    try {
        if (step.run) {
            step.run()
        } else if (!step.until()) {
            if (Date.now() - harness.stepStarted > (step.timeout || 6000))
                throw new Error("Timed out: " + step.name)
            return
        }
        harness.stepIndex++
        harness.stepStarted = 0
        if (harness.stepIndex === harness.steps.length) {
            harness.finished = true
            console.log("WEATHER_E2E_PASS " + harness.scenario + " " + harness.assertions + " assertions")
            Qt.quit()
        }
    } catch (error) {
        fail(harness, step.name + ": " + error)
    }
}

function action(name, run) { h.steps.push({ name: name, run: run }) }
function until(name, predicate, timeout) { h.steps.push({ name: name, until: predicate, timeout: timeout || 6000 }) }
function pause(milliseconds) {
    until("wait " + milliseconds + "ms", function() { return Date.now() - h.stepStarted >= milliseconds }, milliseconds + 1000)
}

function control(options) {
    action("configure loopback response plan", function() {
        h.controlled = false
        var request = new XMLHttpRequest()
        request.open("POST", h.server + "/control")
        request.setRequestHeader("Content-Type", "application/json")
        request.onreadystatechange = function() {
            if (request.readyState !== XMLHttpRequest.DONE) return
            if (request.status !== 200) return fail(h, "loopback control failed")
            h.stats = JSON.parse(request.responseText)
            h.controlled = true
        }
        request.send(JSON.stringify(options))
    })
    until("loopback plan acknowledgement", function() { return h.controlled })
}

function waitForRequests(tag, counts, timeout) {
    var pending = false
    var matched = false
    until("native request counts for " + tag, function() {
        if (matched) return networkIdle()
        if (!pending) {
            pending = true
            var request = new XMLHttpRequest()
            request.open("POST", h.server + "/control")
            request.setRequestHeader("Content-Type", "application/json")
            request.onreadystatechange = function() {
                if (request.readyState !== XMLHttpRequest.DONE) return
                if (request.status !== 200) return fail(h, "request counter failed")
                h.stats = JSON.parse(request.responseText)
                matched = Object.keys(counts).every(function(kind) {
                    return h.stats.requests.filter(function(record) { return record.tag === tag && record.kind === kind }).length >= counts[kind]
                })
                pending = false
            }
            request.send('{"inspect":true}')
        }
        return false
    }, timeout)
}

function descendants(item, predicate, matches) {
    matches = matches || []
    if (predicate(item)) matches.push(item)
    if (item.children) {
        for (var i = 0; i < item.children.length; i++)
            descendants(item.children[i], predicate, matches)
    }
    return matches
}

function field() {
    var fields = descendants(h.panel, function(item) { return item.objectName === "e2e-location-field" })
    check(fields.length === 1, "real panel instantiated exactly one location input")
    return fields[0]
}

function networkIdle() {
    for (var i = 0; i < h.panel.data.length; i++) {
        var object = h.panel.data[i]
        if (object.command && object.command[0] === "curl" && object.running) return false
    }
    return true
}

function edit(query) {
    action("open editor", function() { h.panel.startEditingLocation() })
    pause(60)
    action("type " + query, function() { field().text = query })
}

function startup() {
    action("load byte-identical production component", function() { h.loadPanel() })
    until("current, daily and hourly startup responses", function() {
        return h.panel && h.panel.report && h.panel.dailyForecastReport && h.panel.hourlyEntries.length >= 48
            && h.panel.pluginVersion === h.expectedVersion
    })
    action("assert startup render tree", function() {
        h.panel.controller.show()
        check(h.panel.reportTempNum === (["auto", "lookups", "schema", "timeouts", "auto-cache", "auto-refresh", "auto-refresh-interrupted"].indexOf(h.scenario) >= 0 ? "21" : "23"), "correct current-condition source")
        check(h.panel.forecastDays.length === 3, "three future forecast days")
        check(h.panel.hourlyEntries.filter(function(entry) { return entry.kind === "hour" }).length === 48, "48 hourly samples")
        check(h.panel.hourlyEntries.some(function(entry) { return entry.kind === "sunrise" }), "sunrise in hourly strip")
        check(h.panel.hourlyEntries.some(function(entry) { return entry.kind === "sunset" }), "sunset in hourly strip")
        check(h.panel.label !== "", "current icon updated")
        var processes = 0
        for (var i = 0; i < h.panel.data.length; i++)
            if (h.panel.data[i].command && h.panel.data[i].command[0] === "curl") processes++
        check(processes >= 3, "native curl Processes present in unmodified panel data")
        var strips = descendants(h.panel, function(item) { return typeof item.scrollBy === "function" })
        check(strips.length === 1, "complete production HourlyForecast instantiated")
        check(strips[0].entries.length === h.panel.hourlyEntries.length, "hourly render binding is live")
        var headings = descendants(h.panel, function(item) { return item.text === "HOURLY \u00b7 NEXT 48 HOURS" })
        check(headings.length === 1, "hourly heading rendered")
        var flicks = descendants(strips[0], function(item) { return item.contentX !== undefined })
        check(flicks.length === 1, "real hourly Flickable instantiated")
        strips[0].scrollBy(1)
        check(flicks[0].contentX > 0, "hourly navigation scrolls")
        strips[0].scrollBy(-1)
        check(flicks[0].contentX === 0, "hourly navigation returns to beginning")
        var versions = descendants(h.panel, function(item) { return item.text === "v" + h.panel.pluginVersion })
        check(versions.length === 1 && versions[0].visible, "one version label is visible")
        var version = versions[0]
        check(version.font.pixelSize === 9, "version label uses compact type")
        check(Math.abs(version.x + version.width - version.parent.width) < 1, "version is right-aligned")
        check(Math.abs(version.y + version.height - version.parent.height) < 1, "version is bottom-aligned")
        var scrolls = descendants(h.panel, function(item) { return item.contentHeight !== undefined && item.contentWidth !== undefined && item.clip })
        check(scrolls.some(function(item) { return item.y + item.height <= version.y && item.width === version.parent.width }), "weather content cannot overlap version footer")
    })
}

function editorScenario() {
    edit("Test City")
    until("city suggestions", function() { return h.panel.locationSuggestions.length === 1 })
    action("verify city search result", function() {
        check(h.panel.geocodeResultsQuery === "Test City", "city results match edited text")
        check(h.panel.locationSuggestions[0].name === "Test City, Test Region", "city suggestion label")
        check(h.panel.locationSuggestions[0].latitude === 41, "city coordinates preserved")
    })
    control({ tag: "city-save", daily: [{ mode: "good", delay: 600, temperature: 27 }] })
    action("commit city", function() { h.panel.commitLocation() })
    until("city persisted and refresh started", function() { return h.panel.locationQuery === "41,-76" && h.panel.savingLocationQueryStarted })
    action("wait for correct provider before completing save", function() {
        check(h.panel.savingLocation && h.panel.editingLocation, "spinner remains until Open-Meteo finishes")
        check(h.panel.hourlyEntries.length === 0, "old hourly location is hidden during save")
    })
    until("city save completed", function() { return !h.panel.savingLocation && !h.panel.editingLocation })
    action("verify city save", function() {
        check(h.panel.configuredLocation === "Test City, Test Region", "configured label applied")
        check(h.panel.dailyForecastReport.fixture === "city-save", "save waited for new daily response")
        check(h.panel.reportTempNum === "27", "new conditions rendered")
    })
    control({ tag: "same-save", daily: [{ mode: "good", delay: 300 }] })
    action("edit current pin", function() { h.panel.startEditingLocation() })
    until("saved-pin suggestion", function() { return h.panel.locationSuggestions.length === 1 })
    action("re-save unchanged location", function() { h.panel.commitLocation() })
    until("unchanged pin save completes", function() {
        return !h.panel.savingLocation && !h.panel.editingLocation && h.panel.dailyForecastReport.fixture === "same-save"
    })
    edit("19103")
    until("ZIP suggestion", function() { return h.panel.geocodeResultsQuery === "19103" && h.panel.locationSuggestions.length === 1 })
    action("verify ZIP lookup", function() {
        check(h.panel.locationSuggestions[0].name === "Philadelphia, PA 19103", "ZIP city/state label")
        check(h.panel.locationSuggestions[0].latitude === 39.95, "numeric ZIP coordinates")
        check(h.panel.locationSuggestions[0].description.indexOf("approximate") >= 0, "ZIP approximation disclosed")
        h.panel.commitLocation()
    })
    until("ZIP saved", function() { return !h.panel.editingLocation && h.panel.locationQuery === "39.95,-75.17" })
    action("clear configured pin", function() { h.panel.clearLocation() })
    until("clear restored auto-location", function() { return h.panel.locationQuery === "" && h.panel.wttrLocation === "Auto City" })
    action("verify cleared editor", function() { check(!h.panel.editingLocation && !h.panel.savingLocation, "clear closes editor") })
}

function failuresScenario() {
    var oldReport
    var oldDaily
    var updatedAt
    action("capture last good state", function() {
        oldReport = h.panel.report
        oldDaily = h.panel.dailyForecastReport
        updatedAt = h.panel.hourlyUpdatedAt
    })
    control({ tag: "exhaust", forecast: ["http", "oversize", "truncated", "malformed"], daily: ["http", "oversize", "truncated", "malformed"], fallback: "http" })
    action("refresh with failing providers", function() { h.panel.refresh() })
    until("first native failures retain stale forecast", function() { return h.panel.forecastRetries === 1 && h.panel.dailyForecastRetries === 1 })
    action("verify stale rendering after transport failure", function() {
        check(h.panel.report === oldReport, "wttr report retained")
        check(h.panel.dailyForecastReport === oldDaily, "daily report retained")
        check(h.panel.hourlyUpdatedAt === updatedAt, "failed fetch does not mark data fresh")
        check(h.panel.hourlyStatus === "Update failed \u00b7 Showing last forecast", "stale status surfaced")
        check(h.panel.hourlyEntries.length >= 48, "last-good hourly entries remain visible")
    })
    waitForRequests("exhaust", { forecast: 4, daily: 4 }, 15000)
    action("verify three retries and exhausted budget", function() {
        check(h.panel.forecastRetries === 3 && h.panel.dailyForecastRetries === 3, "both retry budgets capped at three")
        check(h.panel.report === oldReport && h.panel.dailyForecastReport === oldDaily, "HTTP, oversize, valid-prefix truncation and JSON failures retained last-good data")
        var attempts = h.stats.requests.filter(function(request) { return request.tag === "exhaust" })
        check(attempts.filter(function(request) { return request.kind === "forecast" }).length === 4, "exactly initial wttr attempt plus three timed retries")
        check(attempts.filter(function(request) { return request.kind === "daily" }).length === 4, "exactly initial daily attempt plus three timed retries")
    })
    control({ tag: "recover", forecast: ["http", "good"], daily: ["http", "good"] })
    action("explicit refresh renews retry budget", function() { h.panel.refresh() })
    until("new cycle receives a retry", function() { return h.panel.forecastRetries === 1 && h.panel.dailyForecastRetries === 1 })
    until("new retry succeeds", function() {
        return h.panel.report.fixture === "recover" && h.panel.dailyForecastReport.fixture === "recover" && !h.panel.hourlyFetchFailed
    })
    action("verify recovery", function() {
        check(h.panel.forecastRetries === 0 && h.panel.dailyForecastRetries === 0, "success clears retry counters")
        check(h.panel.hourlyStatus === "", "success clears stale warning")
        check(h.panel.hourlyUpdatedAt > updatedAt, "success advances freshness timestamp")
    })
    control({ tag: "chunked", forecast: ["chunked", "good"], daily: ["chunked", "good"] })
    action("refresh with chunked size overflows", function() { h.panel.refresh() })
    until("chunked overflow rejected", function() { return h.panel.forecastRetries === 1 && h.panel.dailyForecastRetries === 1 })
    action("valid JSON prefix from oversized streams not accepted", function() {
        check(h.panel.report.fixture === "recover" && h.panel.dailyForecastReport.fixture === "recover", "exit status wins over parseable prefix")
    })
    until("chunked failures recover", function() {
        return h.panel.report.fixture === "chunked" && h.panel.dailyForecastReport.fixture === "chunked" && !h.panel.hourlyFetchFailed
    })
}

function racesScenario() {
    control({ tag: "search-race", geocode: [{ mode: "good", delay: 1200 }, "good"] })
    edit("Old City")
    until("old lookup started", function() { return h.panel.geocodeActiveQuery === "Old City" })
    pause(150)
    action("replace query in flight", function() { field().text = "New City" })
    until("new lookup wins", function() { return h.panel.geocodeResultsQuery === "New City" && h.panel.locationSuggestions.length === 1 })
    pause(1300)
    action("stale city result never applied", function() {
        check(h.panel.locationSuggestions[0].name === "New City, Test Region", "only latest city suggestions visible")
        check(h.panel.locationError === "", "cancelled old process does not show lookup error")
    })
    control({ tag: "cancel-search", geocode: [{ mode: "good", delay: 1000 }] })
    action("start cancelled lookup", function() { field().text = "Cancel City" })
    until("cancel lookup started", function() { return h.panel.geocodeActiveQuery === "Cancel City" })
    pause(150)
    action("cancel editor while process running", function() { h.panel.cancelEditingLocation() })
    pause(1100)
    action("cancelled lookup cannot repopulate editor", function() {
        check(!h.panel.editingLocation && h.panel.locationSuggestions.length === 0, "cancel clears suggestions")
        check(h.panel.geocodePendingQuery === "", "cancel clears queued query")
    })
    control({
        tag: "weather-race",
        forecast: [{ mode: "good", delay: 1500, marker: "obsolete" }, { mode: "good", marker: "replacement" }],
        daily: [{ mode: "good", delay: 1500, marker: "obsolete" }, { mode: "good", marker: "replacement" }]
    })
    action("start old weather refresh", function() { h.panel.refresh() })
    pause(200)
    control({ inspect: true, locationFile: { value: { name: "New Pin", latitude: 43, longitude: -78 } } })
    action("reload changed configured coordinates in flight", function() { h.panel.reloadConfiguredLocation() })
    until("new location weather finishes", function() {
        return h.panel.hourlyLocationQuery === "43,-78" && h.panel.dailyForecastReport.fixture === "replacement"
    })
    pause(1700)
    action("new coordinates retain correct hourly binding", function() {
        check(h.panel.locationQuery === "43,-78", "query replacement preserved")
        check(h.panel.hourlyLocationQuery === h.panel.locationQuery, "hourly data is labeled with new query")
        check(h.panel.hourlyEntries.length >= 48, "new hourly data renders")
        check(h.panel.report.fixture === "replacement" && h.panel.dailyForecastReport.fixture === "replacement", "obsolete weather bodies never overwrite replacement")
    })
}

function lookupsScenario() {
    until("auto-location ready", function() { return h.panel.wttrLocation === "Auto City" })
    var modes = ["http", "oversize", "truncated", "empty"]
    modes.forEach(function(mode) {
        until("previous requests finish", networkIdle)
        control({ tag: "location-" + mode, location: [mode] })
        action("refresh auto-location with " + mode, function() { h.panel.refresh() })
        until("auto-location request completes", networkIdle)
        action("retain auto-label after " + mode, function() {
            check(h.panel.wttrLocation === "Auto City", "failed IP lookup retains label")
        })
    })
    modes.concat(["chunked", "malformed"]).forEach(function(mode, index) {
        control({ tag: "geocode-" + mode, geocode: [mode] })
        edit(String(19110 + index))
        until("lookup failure visible for " + mode, function() { return h.panel.locationError !== "" })
        action("reject geocode " + mode, function() {
            check(h.panel.locationSuggestions.length === 0, "failed lookup has no selectable suggestions")
            check(h.panel.geocodeResultsQuery === "", "failed lookup does not mark query resolved")
            h.panel.commitLocation()
            check(h.panel.locationError === "Choose a matching location below before saving.", "failed result cannot be committed")
            check(!h.panel.savingLocation, "invalid commit never starts a save")
            h.panel.cancelEditingLocation()
        })
    })
    control({ tag: "city-malformed", geocode: ["malformed"] })
    edit("Malformed City")
    until("malformed city lookup resolves", function() { return h.panel.locationError !== "" })
    action("document existing malformed-city fallback", function() {
        check(h.panel.locationSuggestions.length === 0, "malformed city JSON cannot produce a suggestion")
        check(h.panel.locationError.indexOf("No locations found.") === 0, "existing city parser maps malformed JSON to no results")
        h.panel.commitLocation()
        check(!h.panel.savingLocation, "malformed city lookup cannot be saved")
        h.panel.cancelEditingLocation()
    })
    control({ tag: "lookup-recovery" })
    edit("19103")
    until("lookup recovers", function() { return h.panel.locationSuggestions.length === 1 })
    action("verify lookup recovery", function() {
        check(h.panel.geocodeResultsQuery === "19103", "retry resolves current ZIP")
        check(h.panel.locationError === "", "success clears lookup error")
        h.panel.cancelEditingLocation()
    })
}

function memoryScenario() {
    var previousReport
    var previousDaily
    until("startup processes settle", networkIdle)
    control({ inspect: true, memory: "baseline" })
    ;["http", "oversize", "truncated", "chunked"].forEach(function(mode) {
        var tag = "memory-" + mode
        action("remember previous successful reports", function() {
            previousReport = h.panel.report
            previousDaily = h.panel.dailyForecastReport
        })
        control({ tag: tag, forecast: [mode, "good"], daily: [mode, "good"] })
        action("start repeated failure cycle " + mode, function() { h.panel.refresh() })
        until("both failures observed " + mode, function() {
            return h.panel.forecastRetries === 1 && h.panel.dailyForecastRetries === 1 && networkIdle()
        })
        action("check retained state " + mode, function() {
            check(h.panel.report === previousReport && h.panel.dailyForecastReport === previousDaily, "failure cycle retains both reports")
            check(h.panel.hourlyFetchFailed && h.panel.hourlyEntries.length >= 48, "stale hourly forecast remains usable")
        })
        control({ inspect: true, memory: mode + "-failed" })
        until("both scheduled retries recovered " + mode, function() {
            return h.panel.report.fixture === tag && h.panel.dailyForecastReport.fixture === tag
                && !h.panel.hourlyFetchFailed && networkIdle()
        })
        action("check repeated recovery " + mode, function() {
            check(h.panel.forecastRetries === 0 && h.panel.dailyForecastRetries === 0, "recovery resets counters")
            check(h.panel.hourlyStatus === "" && h.panel.hourlyEntries.length >= 48, "recovery keeps rendered forecast healthy")
        })
        control({ inspect: true, memory: mode + "-recovered" })
    })
}

function schemaScenario() {
    var previousReport
    ;["schema-null", "schema-missing-current", "schema-null-current"].forEach(function(mode) {
        until("previous weather process settles", networkIdle)
        action("capture schema-test last good report", function() { previousReport = h.panel.report })
        control({ tag: mode, forecast: [mode, "good"] })
        action("fetch schema-invalid wttr JSON", function() { h.panel.refresh() })
        until("schema failure schedules retry", function() { return h.panel.forecastRetries === 1 && networkIdle() })
        action("schema validation precedes assigning report", function() {
            check(h.panel.report === previousReport, "schema-invalid response did not replace last-good report")
            check(h.panel.reportTempNum === "21", "last-good wttr current conditions remain visible in auto mode")
            check(h.panel.hourlyEntries.length >= 48 && !h.panel.hourlyFetchFailed, "valid independent hourly response remains usable")
        })
        until("schema failure recovers with valid wttr shape", function() {
            return h.panel.report && h.panel.report.fixture === mode && h.panel.forecastRetries === 0
        })
        action("validate schema retry recovery", function() {
            check(Array.isArray(h.panel.report.current_condition) && h.panel.report.current_condition[0].temp_C === "21", "valid provider-shaped current conditions accepted")
        })
    })
}

function start(harness) {
    h = harness
    if (h.scenario === "version-timeout") {
        versionTimeoutScenario()
        return
    }
    if (h.scenario.indexOf("unsafe-location-") === 0) {
        unsafeLocationScenario()
        return
    }
    if (h.scenario === "location-timeout") {
        locationTimeoutScenario()
        return
    }
    if (h.scenario.indexOf("auto-cache-") === 0) {
        autoCacheRestartScenario()
        return
    }
    if (h.scenario === "cache-expired" || h.scenario === "cache-report-expired") {
        expiredCacheScenario()
        return
    }
    if (h.scenario === "helper-timeout") {
        helperTimeoutScenario()
        return
    }
    if (h.scenario.indexOf("unsafe-cache-") === 0) {
        unsafeCacheScenario()
        return
    }
    if (h.scenario.indexOf("cache-") === 0 && h.scenario !== "cache-write-error") {
        cacheRestartScenario()
        return
    }
    startup()
    if (h.scenario === "auto") {
        until("IP auto-location label", function() { return h.panel.wttrLocation === "Auto City" })
        action("verify auto mode", function() {
            check(h.panel.locationQuery === "", "no configured location")
            check(h.panel.reportLocation === "Auto City", "IP label is displayed")
            check(!h.panel.hasConfiguredCoordinates, "auto mode did not persist coordinates")
        })
    } else if (h.scenario === "editor") editorScenario()
    else if (h.scenario === "failures") failuresScenario()
    else if (h.scenario === "races") racesScenario()
    else if (h.scenario === "lookups") lookupsScenario()
    else if (h.scenario === "memory") memoryScenario()
    else if (h.scenario === "schema") schemaScenario()
    else if (h.scenario === "timeouts") timeoutsScenario()
    else if (h.scenario === "location-reloads") locationReloadsScenario()
    else if (h.scenario === "location-race") locationRaceScenario()
    else if (h.scenario === "dynamic-version") dynamicVersionScenario()
    else if (h.scenario === "auto-refresh" || h.scenario === "auto-refresh-interrupted") autoRefreshScenario()
    else if (h.scenario === "cache" || h.scenario === "cache-write-error" || h.scenario === "auto-cache") {
        until("native cache writes settle", function() {
            return networkIdle() && !h.panel.cacheWriteInFlight && !h.panel.cacheWritePending
        })
        action("live weather survives cache writes", function() {
            check(h.panel.reportTempNum === (h.scenario === "auto-cache" ? "21" : "23") && h.panel.hourlyEntries.length >= 48, "current and hourly weather remain visible")
        })
    }
}

function dynamicVersionScenario() {
    action("only fixture manifest determines startup version", function() {
        check(h.panel.pluginVersion === "8.7.6", "unchanged production QML displays altered manifest version")
    })
    control({ inspect: true, manifest: { version: "9.8.7-beta.1" } })
    action("reopen after manifest-only update", function() { h.panel.open() })
    until("label changes without restarting QML", function() { return h.panel.pluginVersion === "9.8.7-beta.1" })
    action("rendered version follows manifest", function() {
        var labels = descendants(h.panel, function(item) { return item.text === "v9.8.7-beta.1" })
        check(labels.length === 1 && labels[0].visible, "new version visibly rendered")
    })
    var invalidModes = ["malformed", "fifo"]
    invalidModes.forEach(function(mode) {
        control({ inspect: true, manifest: { mode: mode } })
        action("reopen with rejected manifest", function() { h.panel.openFromHotkey() })
        until("bad manifest read finishes without blocking", function() { return !h.panel.versionReadInFlight })
        action("last known version and weather survive", function() {
            check(h.panel.pluginVersion === "9.8.7-beta.1", "invalid file cannot supply a fake version")
            check(h.panel.hourlyEntries.length >= 48, "weather unaffected")
        })
    })
    control({ inspect: true, manifest: { version: "10.0.0" } })
    action("reopen after manifest repair", function() { h.panel.open() })
    until("repaired manifest updates version", function() { return h.panel.pluginVersion === "10.0.0" })
}

function versionTimeoutScenario() {
    var ticks
    var started
    action("load panel with stalled version reader", function() {
        ticks = h.ticks
        started = Date.now()
        h.loadPanel()
    })
    until("weather starts independently of version metadata", function() {
        return h.panel && h.panel.weatherReady && h.panel.hourlyEntries.length >= 48
    }, 2000)
    action("missing version is not fabricated", function() {
        check(h.panel.pluginVersion === "" && h.panel.versionReadInFlight, "no hardcoded fallback")
        h.panel.startEditingLocation()
        check(h.panel.editingLocation, "editor remains responsive")
        h.panel.cancelEditingLocation()
    })
    until("version watchdog ends the stalled read", function() { return !h.panel.versionReadInFlight }, 6500)
    action("deadline enforced without blocking UI", function() {
        check(Date.now() - started >= 4800 && Date.now() - started < 6200, "five-second limit")
        check(h.ticks - ticks > 100, "heartbeat continued")
    })
    control({ inspect: true, versionHelper: "normal" })
    action("reopen after helper recovers", function() { h.panel.open() })
    until("actual release version appears", function() { return h.panel.pluginVersion === h.expectedVersion })
}

function unsafeLocationScenario() {
    var ticks
    action("start with an unsafe location file", function() {
        ticks = h.ticks
        h.loadPanel()
    })
    until("unsafe location cannot block initialization", function() {
        return h.panel && h.panel.weatherReady
    }, 2000)
    action("unsafe contents never enter location or weather state", function() {
        check(h.panel.locationQuery === "" && h.panel.configuredLocation === "", "unrelated coordinates are not applied")
        check(h.panel.report === null, "startup completes before delayed network responses")
        h.panel.startEditingLocation()
        check(h.panel.editingLocation, "editor responds after rejected read")
        h.panel.cancelEditingLocation()
    })
    until("live weather works without saved coordinates", function() {
        return h.panel.report && h.panel.dailyForecastReport && networkIdle()
    })
    action("QML remains responsive", function() { check(h.ticks - ticks > 10, "native heartbeat continues") })
    control({ locationFile: { value: { name: "Recovered pin", latitude: 44, longitude: -79 } } })
    until("bounded polling finds repaired location without opening popup", function() {
        return h.panel.configuredLocation === "Recovered pin" && h.panel.hourlyLocationQuery === "44,-79"
    }, 4000)
    action("repaired saved location drives live weather", function() {
        check(h.panel.hasConfiguredCoordinates && h.panel.hourlyEntries.length >= 48, "forecast follows repaired pin")
    })
}

function locationReloadsScenario() {
    control({ locationFile: { value: { name: "Edited pin", latitude: 42, longitude: -73 } } })
    until("external edit is detected", function() { return h.panel.hourlyLocationQuery === "42,-73" }, 4000)
    control({ locationFile: { mode: "atomic", value: { name: "Atomic pin", latitude: 43, longitude: -74 } } })
    until("atomic replacement is detected", function() { return h.panel.hourlyLocationQuery === "43,-74" }, 4000)
    control({ locationFile: { mode: "fifo" } })
    pause(2200)
    action("failed read preserves last valid pin", function() {
        check(h.panel.locationQuery === "43,-74" && h.panel.configuredLocation === "Atomic pin", "unsafe replacement does not silently switch location")
        check(!h.panel.locationReadInFlight, "writerless FIFO does not block")
    })
    control({ locationFile: { mode: "malformed" } })
    action("opening normally requests a safe reload", function() { h.panel.open() })
    pause(150)
    action("malformed replacement preserves pin", function() { check(h.panel.locationQuery === "43,-74", "bad JSON is not applied") })
    control({ locationFile: { mode: "missing" } })
    action("hotkey opening requests a safe reload", function() { h.panel.openFromHotkey() })
    until("deleted preference returns to IP detection", function() { return h.panel.locationQuery === "" && h.panel.reportIsLive })
    control({ locationFile: { value: { name: "Recreated pin", latitude: 45, longitude: -75 } } })
    until("recreated file is detected without a watch", function() { return h.panel.hourlyLocationQuery === "45,-75" }, 4000)
    action("recreated state is rendered", function() { check(h.panel.configuredLocation === "Recreated pin", "new name applied") })
}

function locationTimeoutScenario() {
    var ticks
    var started
    action("load while location reader hangs", function() {
        ticks = h.ticks
        started = Date.now()
        h.loadPanel()
    })
    pause(200)
    action("editor is usable during startup read", function() {
        check(!h.panel.weatherReady && h.panel.locationReadInFlight, "initial location request is pending")
        h.panel.startEditingLocation()
        check(h.panel.editingLocation, "editor responds before timeout")
        h.panel.cancelEditingLocation()
    })
    until("location watchdog unblocks startup", function() { return h.panel.weatherReady }, 6500)
    action("read deadline is bounded and event loop never blocks", function() {
        check(Date.now() - started >= 4800 && Date.now() - started < 6200, "production five-second deadline enforced")
        check(h.ticks - ticks > 100, "native heartbeat continued")
        check(h.panel.locationQuery === "", "hung reader supplies no pin")
    })
    control({ locationHelper: "normal" })
    until("a later safe read recovers configured weather", function() {
        return h.panel.locationQuery === "40,-75" && h.panel.hourlyLocationQuery === "40,-75"
            && !h.panel.locationReadInFlight
    }, 4000)
    action("recovery preserves responsive weather", function() { check(h.panel.hourlyEntries.length >= 48, "hourly weather recovers") })
}

function locationRaceScenario() {
    until("initial safe location read is idle", function() { return !h.panel.locationReadInFlight })
    control({ inspect: true, locationHelper: "delay" })
    action("start a delayed read of the old pin", function() { h.panel.reloadConfiguredLocation() })
    pause(200)
    action("save a new pin before the old read completes", function() {
        check(h.panel.locationReadInFlight, "old read remains in flight")
        h.panel.pickSuggestion({ name: "New saved pin", latitude: 46, longitude: -76 })
    })
    until("new saved pin applied", function() { return h.panel.locationQuery === "46,-76" })
    control({ inspect: true, locationHelper: "normal" })
    until("obsolete read exits and pending reload completes", function() {
        check(h.panel.locationQuery === "46,-76", "old captured location must never undo save")
        return !h.panel.locationReadInFlight && !h.panel.locationReadPending && networkIdle()
    })
    action("only saved coordinates reach final forecast", function() {
        check(h.panel.hourlyLocationQuery === "46,-76" && !h.panel.savingLocation, "new pin's save completes")
    })
}

function helperTimeoutScenario() {
    var ticks
    var started
    action("start with a stalled cache helper", function() {
        ticks = h.ticks
        started = Date.now()
        h.loadPanel()
    })
    until("read watchdog unblocks weather initialization", function() {
        return h.panel && h.panel.weatherReady
    }, 6500)
    action("read timeout preserves responsive UI and no cached data", function() {
        check(Date.now() - started >= 4800, "production read watchdog duration is unchanged")
        check(h.ticks - ticks > 100, "QML heartbeat continues during hung cache read")
        check(h.panel.weatherCache === null, "hung helper supplies no cache")
        h.panel.startEditingLocation()
        check(h.panel.editingLocation, "editor remains responsive")
        h.panel.cancelEditingLocation()
    })
    until("live weather succeeds despite stalled writes", function() {
        return h.panel.report && h.panel.dailyForecastReport && h.panel.cacheWriteInFlight
    })
    until("write watchdog clears every pending write", function() {
        return !h.panel.cacheWriteInFlight && !h.panel.cacheWritePending && networkIdle()
    }, 12000)
    action("write timeouts do not discard live weather", function() {
        check(h.panel.reportTempNum === "23" && h.panel.hourlyEntries.length >= 48, "current and hourly weather survive")
    })
}

function unsafeCacheScenario() {
    var ticks
    action("start with an unsafe cache entry", function() {
        ticks = h.ticks
        h.loadPanel()
    })
    until("unsafe cache is rejected before live responses", function() {
        return h.panel && h.panel.weatherReady
    }, 2000)
    action("unsafe bytes never enter the weather model", function() {
        check(h.panel.weatherCache === null, "cache remains unset")
        check(h.panel.report === null && h.panel.dailyForecastReport === null, "unrelated data is not restored")
        h.panel.startEditingLocation()
        check(h.panel.editingLocation, "editor responds after rejecting cache")
        h.panel.cancelEditingLocation()
    })
    until("live weather recovers and writes finish", function() {
        return h.panel.report && h.panel.dailyForecastReport && networkIdle()
            && !h.panel.cacheWritePending && !h.panel.cacheWriteInFlight
    })
    action("unsafe cache does not disable weather or the UI", function() {
        check(h.panel.reportTempNum === "23" && h.panel.hourlyEntries.length >= 48, "live current and hourly conditions render")
        check(h.ticks - ticks > 10, "native QML heartbeat continues")
    })
}

function expiredCacheScenario() {
    function checkWarning() {
        check(h.panel.hourlyEntries.length === 0, "expired forecast has no current hourly entries")
        check(h.panel.reportTempNum === (h.scenario === "cache-report-expired" ? "21" : "23"), "last-good current conditions remain visible")
        check(h.panel.currentUpdatedAt < Date.now() - 6 * 86400000, "current conditions retain their original age")
        check(h.panel.hourlyStatus.indexOf("Forecast may be outdated") === 0, "old current conditions produce a stale warning")
        var warnings = descendants(h.panel, function(item) {
            return item.visible && item.text === h.panel.hourlyStatus
        })
        check(warnings.length === 1, "exactly one stale warning is visible without the hourly strip")
    }
    action("restart with week-old weather while offline", function() { h.loadPanel() })
    until("expired cache loads", function() { return h.panel && h.panel.weatherReady })
    action("show age warning before delayed requests finish", function() {
        h.panel.controller.show()
        checkWarning()
    })
    until("offline requests fail", function() {
        return h.panel.forecastRetries > 0 && h.panel.dailyForecastRetries > 0
    })
    action("age warning remains visible after failures", checkWarning)
}

function autoRefreshScenario() {
    var oldDaily
    var updatedAt
    var cases = [
        { tag: "auto-refresh-report-first", coordinates: [44, -79], forecastDelay: 500, dailyDelay: 1400, dailyMode: "good" },
        { tag: "auto-refresh-daily-first", coordinates: [45, -80], forecastDelay: 1400, dailyDelay: 100, dailyMode: "good" },
        { tag: "auto-refresh-old-failed", coordinates: [45, -81], forecastDelay: 500, dailyDelay: 1400, dailyMode: "http" }
    ]
    if (h.scenario === "auto-refresh-interrupted") cases = cases.slice(0, 1)
    cases.forEach(function(testCase) {
        until("previous live auto refresh settles", function() {
            return networkIdle() && !h.panel.cacheWritePending && !h.panel.cacheWriteInFlight
        })
        control({
            tag: testCase.tag,
            forecast: { delay: testCase.forecastDelay, coordinates: testCase.coordinates },
            daily: [
                { mode: testCase.dailyMode, delay: testCase.dailyDelay, marker: testCase.tag + "-obsolete" },
                { delay: 800, marker: testCase.tag + "-current" }
            ]
        })
        action("refresh after moving networks without restarting", function() {
            check(h.panel.reportIsLive && h.panel.locationQuery === "", "previous wttr report is already live in auto mode")
            oldDaily = h.panel.dailyForecastReport
            updatedAt = h.panel.hourlyUpdatedAt
            h.panel.refresh()
        })
        until("new detected area replaces the live wttr report", function() {
            return h.panel.report.fixture === testCase.tag && !h.panel.cacheWritePending && !h.panel.cacheWriteInFlight
        })
        if (testCase.forecastDelay < testCase.dailyDelay) {
            action("old-coordinate request is still in flight", function() {
                check(h.panel.dailyForecastReport === oldDaily, "last-good UI data remains visible")
                check(h.panel.hourlyUpdatedAt === updatedAt, "old data has not been marked fresh")
                check(h.panel.weatherCache.dailyForecast === null, "new report does not retain the old daily cache")
            })
            control({ inspect: true, cache: testCase.tag + "-pending" })
        }
        if (h.scenario !== "auto-refresh-interrupted") {
            until("replacement daily request follows current detected coordinates", function() {
                if (testCase.forecastDelay < testCase.dailyDelay)
                    check(h.panel.dailyForecastReport.fixture !== testCase.tag + "-obsolete", "obsolete response never replaces visible weather")
                return h.panel.dailyForecastReport.fixture === testCase.tag + "-current" && networkIdle()
                    && !h.panel.cacheWritePending && !h.panel.cacheWriteInFlight
            })
            action("only matching data becomes fresh", function() {
                check(h.panel.dailyForecastReport.latitude === testCase.coordinates[0], "daily latitude matches the new wttr area")
                check(h.panel.dailyForecastReport.longitude === testCase.coordinates[1], "daily longitude matches the new wttr area")
                check(h.panel.dailyForecastRetries === 0 && !h.panel.hourlyFetchFailed, "obsolete success or failure does not consume retries")
                check(h.panel.hourlyUpdatedAt > updatedAt, "current response advances freshness")
            })
            control({ inspect: true, cache: testCase.tag })
        }
    })
}

function autoCacheRestartScenario() {
    var oldDaily
    var updatedAt
    action("restart auto mode on a different network", function() { h.loadPanel() })
    until("cached auto weather restored before delayed wttr response", function() {
        return h.panel && h.panel.weatherReady
    }, 2000)
    action("cached weather remains visible but does not establish current coordinates", function() {
        check(h.panel.locationQuery === "" && !h.panel.hasConfiguredCoordinates, "auto mode restored")
        check(h.panel.areaInfo.latitude === "40", "previous network's wttr area restored")
        oldDaily = h.panel.dailyForecastReport
        updatedAt = h.panel.hourlyUpdatedAt
        check(oldDaily.latitude === 40 && h.panel.hourlyEntries.length >= 48, "previous network's daily and hourly data restored")
        h.panel.refresh()
    })
    pause(150)
    control({ inspect: true })
    action("no old-coordinate daily request can race the live wttr response", function() {
        check(h.panel.areaInfo.latitude === "40", "wttr is still delayed")
        check(h.stats.requests.some(function(request) { return request.tag === h.scenario && request.kind === "forecast" }), "live wttr request started")
        check(!h.stats.requests.some(function(request) { return request.tag === h.scenario && request.kind === "daily" }), "restored auto area did not launch Open-Meteo")
    })
    until("new network's wttr report has been cached", function() {
        return h.panel.report.fixture === h.scenario && !h.panel.cacheWritePending && !h.panel.cacheWriteInFlight
    })
    action("partial refresh does not mix persisted locations", function() {
        check(h.panel.areaInfo.latitude === "44", "live wttr supplies new coordinates")
        check(h.panel.dailyForecastReport === oldDaily && h.panel.hourlyUpdatedAt === updatedAt, "last-good daily data remains visible without becoming fresh")
        check(h.panel.weatherCache.dailyForecast === null, "old-network daily payload removed from new-network disk cache")
    })
    if (h.scenario === "auto-cache-interrupted") {
        control({ inspect: true })
        action("exit while matching Open-Meteo request is still pending", function() {
            check(h.stats.requests.some(function(request) { return request.tag === h.scenario && request.kind === "daily" }), "matching daily request started")
            check(!networkIdle(), "daily response is still delayed at shell exit")
        })
        return
    }
    if (h.scenario === "auto-cache-retry") {
        until("daily failure schedules normal retry", function() { return h.panel.dailyForecastRetries === 1 && h.panel.hourlyFetchFailed })
        action("failed daily refresh preserves only matching cache identity", function() {
            check(h.panel.weatherCache.dailyForecast === null, "failed daily request cannot restore the old-network cache entry")
        })
    }
    until("matching daily data and native cache writes settle", function() {
        return h.panel.dailyForecastReport.fixture === h.scenario && networkIdle()
            && !h.panel.cacheWritePending && !h.panel.cacheWriteInFlight
    }, 8000)
    action("new provider payloads share the detected location", function() {
        check(h.panel.dailyForecastReport.latitude === 44 && h.panel.dailyForecastReport.longitude === -79, "daily response belongs to the live wttr coordinates")
        check(h.panel.hourlyUpdatedAt > updatedAt && !h.panel.hourlyFetchFailed, "matching live daily response advances freshness")
    })
}

function cacheRestartScenario() {
    action("load panel in a fresh shell process", function() { h.loadPanel() })
    until("local startup reads complete before network responses", function() {
        return h.panel && h.panel.weatherReady
    }, 2000)
    if (h.scenario === "cache-offline") {
        var updatedAt
        action("disk cache renders while providers are hanging", function() {
            check(!networkIdle(), "refresh is still in flight")
            check(h.panel.reportTempNum === "23" && h.panel.label !== "", "current temperature and icon restored")
            check(h.panel.reportLocation === "Initial City", "configured location restored")
            check(h.panel.hourlyEntries.length >= 48 && h.panel.forecastDays.length === 3, "hourly and daily forecasts restored")
            updatedAt = h.panel.weatherCache.dailyForecast.updatedAt
            check(h.panel.hourlyUpdatedAt === updatedAt, "cached timestamp is not replaced with startup time")
        })
        until("both hung providers time out", function() {
            return h.panel.forecastRetries > 0 && h.panel.dailyForecastRetries > 0
        }, 13000)
        action("offline failure retains restored data and warns", function() {
            check(h.panel.reportTempNum === "23" && h.panel.hourlyEntries.length >= 48, "cached forecast remains usable offline")
            check(h.panel.hourlyUpdatedAt === updatedAt, "timeout does not freshen cached data")
            check(h.panel.hourlyStatus.indexOf("Update failed") === 0, "offline warning is visible")
        })
    } else {
        action("wrong-location or corrupt data is not restored", function() {
            check(h.panel.locationQuery === "44,-79", "current saved location wins")
            check(h.panel.report === null && h.panel.dailyForecastReport === null, "no invalid cached reports applied")
            check(h.panel.reportTempNum === "" && h.panel.hourlyEntries.length === 0, "no wrong-location weather rendered")
        })
        until("live responses recover and repair cache", function() {
            return h.panel.report && h.panel.dailyForecastReport
                && !h.panel.cacheWritePending && !h.panel.cacheWriteInFlight && networkIdle()
        })
        action("new cache contains only matching responses", function() {
            check(h.panel.weatherCache.locationQuery === "44,-79", "new cache belongs to saved location")
            check(h.panel.weatherCache.report.data.fixture === h.scenario, "wttr payload replaced")
            check(h.panel.weatherCache.dailyForecast.data.fixture === h.scenario, "daily payload replaced")
        })
    }
}

function timeoutsScenario() {
    var ticks
    var oldReport
    var oldDaily
    until("auto label and startup requests settle", function() { return h.panel.wttrLocation === "Auto City" && networkIdle() })
    control({ tag: "timeouts", fallback: { mode: "good", delay: 20000 } })
    action("start hung weather requests", function() {
        ticks = h.ticks
        oldReport = h.panel.report
        oldDaily = h.panel.dailyForecastReport
        h.panel.refresh()
    })
    edit("Timeout City")
    until("hung geocode query starts", function() { return h.panel.geocodeActiveQuery === "Timeout City" })
    until("all request timeout handlers run", function() {
        return h.panel.forecastRetries > 0 && h.panel.dailyForecastRetries > 0 && h.panel.locationError !== ""
    }, 13000)
    action("event loop and editor remain responsive during timeouts", function() {
        check(h.ticks - ticks > 100, "QML event loop continued ticking during hung requests")
        check(h.panel.report === oldReport && h.panel.dailyForecastReport === oldDaily, "timeouts preserve last-good weather")
        check(h.panel.wttrLocation === "Auto City", "location timeout preserves existing label")
        check(h.panel.locationSuggestions.length === 0, "search timeout supplies no suggestions")
        h.panel.cancelEditingLocation()
        check(!h.panel.editingLocation, "editor still responds")
    })
}
