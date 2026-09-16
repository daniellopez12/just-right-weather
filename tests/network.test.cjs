const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const test = require("node:test");
const vm = require("node:vm");
const Model = require("../Model.js");
const Network = require("../Network.js");

const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");
const requests = [
  { name: "forecast", timeout: 10 },
  { name: "dailyForecast", timeout: 5 },
  { name: "geocode", timeout: 5 },
  { name: "location", timeout: 4 }
];

function processSource(name) {
  const match = panel.match(new RegExp(`\\n  Process \\{\\n    id: ${name}Proc\\n([\\s\\S]*?)\\n  \\}`));
  assert.ok(match, `Missing ${name} process`);
  return match[1];
}

function runExitHandler(name, raw, exitCode = 0, exitStatus = 0, overrides = {}) {
  const state = { parses: 0, searches: 0, retries: 0, dailyRetries: 0, saves: 0, refreshes: 0, warnings: [], queued: [] };
  const previousReport = { previous: "weather" };
  const previousDaily = { previous: "daily" };
  const root = {
    report: previousReport,
    dailyForecastReport: previousDaily,
    label: "previous-icon",
    hasConfiguredCoordinates: false,
    configuredLocationState: { latitude: null },
    forecastRetries: 2,
    dailyForecastRetries: 2,
    hourlyFetchFailed: false,
    hourlyUpdatedAt: 123,
    hourlyLocationQuery: "previous-query",
    locationQuery: "current-query",
    wttrLocation: "Previous city",
    editingLocation: true,
    geocodeActiveQuery: "Sample",
    geocodePendingQuery: "",
    geocodeResultsQuery: "previous-query",
    locationSuggestions: [{ name: "Previous suggestion" }],
    locationError: "",
    scheduleForecastRetry() { state.retries++; },
    scheduleDailyForecastRetry() { state.dailyRetries++; },
    finishSavingLocation() { state.saves++; },
    refreshDailyForecast() { state.refreshes++; },
    startGeocode() {},
    ...overrides
  };
  const source = processSource(name);
  const handler = source.match(/onExited:\s*(function\(exitCode, exitStatus\) \{[\s\S]*\})\s*$/);
  assert.ok(handler, `${name} must consume output in onExited`);
  const sandbox = {
    root,
    Network,
    Model: {
      ...Model,
      parseLocationSearch(text, query) {
        state.searches++;
        return Model.parseLocationSearch(text, query);
      }
    },
    JSON: { parse(text) { state.parses++; return JSON.parse(text); } },
    locationField: { text: "Sample" },
    Qt: { callLater(callback) { state.queued.push(callback); } },
    console: { warn(message) { state.warnings.push(message); } },
    [`${name}Output`]: { text: raw }
  };
  vm.runInNewContext(`(${handler[1]})`, sandbox)(exitCode, exitStatus);
  return { root, state, previousReport, previousDaily };
}

function dailyResponse() {
  const time = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
  return JSON.stringify({
    utc_offset_seconds: 0,
    hourly: {
      time: [time],
      temperature_2m: [20],
      precipitation_probability: [25],
      precipitation: [0],
      weather_code: [0],
      is_day: [1]
    },
    current: { temperature_2m: 20, weather_code: 0, is_day: 1 }
  });
}

test("all four requests use endpoint-specific byte limits and retain their timeouts", () => {
  assert.deepEqual(Network.responseLimits, {
    forecast: 262144, dailyForecast: 65536, geocode: 65536, location: 1024
  });
  assert.equal((panel.match(/Network\.curlCommand\(/g) || []).length, 4);
  for (const { name, timeout } of requests) {
    const source = processSource(name);
    assert.match(source, new RegExp(`Network\\.responseText\\(${name}Output\\.text, exitCode,\\s*exitStatus, Network\\.responseLimits\\.${name}\\)`));
    assert.doesNotMatch(source, /onStreamFinished/);
    assert.match(source, /waitForEnd: true/);
    assert.match(panel, new RegExp(`${timeout}, Network\\.responseLimits\\.${name}\\)`));
    const url = "https://example.invalid/?query=Sample%20City";
    assert.deepEqual(Network.curlCommand(url, timeout, Network.responseLimits[name]), [
      "curl", "-q", "-fsS", "--max-time", String(timeout),
      "--max-filesize", String(Network.responseLimits[name]), url
    ]);
  }
});

test("response validation measures untrimmed UTF-8 bytes at each endpoint's boundary", () => {
  for (const limit of Object.values(Network.responseLimits)) {
    for (const size of [limit - 1, limit]) {
      const raw = "x".repeat(size);
      assert.equal(Network.responseText(raw, 0, 0, limit), raw);
    }
    for (const raw of [
      "x".repeat(limit + 1),
      "{}" + " ".repeat(limit - 1),
      "\u00e9".repeat(limit / 2) + "x",
      "\ud83c\udf24".repeat(limit / 4) + "x"
    ]) {
      assert.ok(Buffer.byteLength(raw, "utf8") > limit);
      assert.throws(() => Network.responseText(raw, 0, 0, limit), /exceeds/);
    }
    for (const raw of [
      "\u00e9".repeat(limit / 2),
      "\ud83c\udf24".repeat(limit / 4)
    ]) {
      assert.equal(Buffer.byteLength(raw, "utf8"), limit);
      assert.equal(Network.responseText(raw, 0, 0, limit), raw);
    }
  }
  assert.equal(Network.responseText(" \n{} \t", 0, 0, 7), "{}");
  for (const raw of ["", " \n\t"]) {
    assert.throws(() => Network.responseText(raw, 0, 0, 1024), /Empty/);
  }
});

test("failed transfers are rejected before inspecting otherwise valid output", () => {
  const unreadable = { toString() { assert.fail("Failed output must not be inspected"); } };
  for (const code of [18, 22, 28, 63]) {
    assert.throws(() => Network.responseText(unreadable, code, 0, 1024), /Request failed/);
  }
  assert.throws(() => Network.responseText(unreadable, 0, 1, 1024), /Request failed/);
});

test("all consumers reject failed, oversized and empty output before parsing or retaining it", () => {
  for (const { name } of requests) {
    for (const [raw, code, status] of [
      ["{}", 18, 0], ["{}", 22, 0], ["{}", 28, 0], ["{}", 63, 0],
      ["{}", 0, 1], ["x".repeat(Network.responseLimits[name] + 1), 0, 0], ["", 0, 0]
    ]) {
      const { root, state, previousReport, previousDaily } = runExitHandler(name, raw, code, status);
      assert.equal(state.parses, 0, name);
      assert.equal(state.searches, 0, name);
      assert.equal(root.report, previousReport, name);
      assert.equal(root.dailyForecastReport, previousDaily, name);
      assert.equal(root.wttrLocation, "Previous city", name);
      assert.equal(root.label, "previous-icon", name);
      assert.equal(root.hourlyUpdatedAt, 123, name);
      assert.equal(root.hourlyLocationQuery, "previous-query", name);
      assert.equal(state.saves, 0, name);
      assert.equal(state.refreshes, 0, name);
      assert.equal(state.warnings.length, 1, name);
      assert.equal(state.retries, name === "forecast" ? 1 : 0);
      assert.equal(state.dailyRetries, name === "dailyForecast" ? 1 : 0);
      if (name === "dailyForecast") assert.equal(root.hourlyFetchFailed, true);
      if (name === "geocode") {
        assert.equal(root.locationSuggestions.length, 0);
        assert.equal(root.geocodeResultsQuery, "");
        assert.notEqual(root.locationError, "");
      }
    }
  }
});

test("successful responses preserve weather updates, save completion, geocoding and labels", () => {
  const wttr = runExitHandler("forecast", '{"current_condition":[{"weatherCode":"113"}]}');
  assert.equal(wttr.root.report.current_condition[0].weatherCode, "113");
  assert.equal(wttr.root.forecastRetries, 0);
  assert.equal(wttr.state.saves, 1);
  assert.equal(wttr.state.refreshes, 1);

  const daily = runExitHandler("dailyForecast", dailyResponse(), 0, 0, { hasConfiguredCoordinates: true });
  assert.equal(daily.root.dailyForecastReport.current.temperature_2m, 20);
  assert.equal(daily.root.hourlyFetchFailed, false);
  assert.equal(daily.root.dailyForecastRetries, 0);
  assert.equal(daily.root.hourlyLocationQuery, "current-query");
  assert.ok(daily.root.hourlyUpdatedAt > 123);
  assert.equal(daily.state.saves, 1);

  const geocode = runExitHandler("geocode",
    '{"results":[{"name":"Sample","latitude":10,"longitude":20}]}');
  assert.equal(geocode.root.locationSuggestions[0].name, "Sample");
  assert.equal(geocode.root.geocodeResultsQuery, "Sample");
  assert.equal(geocode.root.locationError, "");
  assert.equal(geocode.root.suggestionIndex, 0);

  const location = runExitHandler("location", " Sample City, Region \n");
  assert.equal(location.root.wttrLocation, "Sample City");
  for (const result of [wttr, daily, geocode, location]) {
    assert.equal(result.state.warnings.length, 0);
    assert.equal(result.state.retries + result.state.dailyRetries, 0);
  }
});

test("malformed forecast JSON retains stale reports and schedules retries", () => {
  for (const name of ["forecast", "dailyForecast"]) {
    const result = runExitHandler(name, '{"partial":');
    assert.equal(result.root.report, result.previousReport);
    assert.equal(result.root.dailyForecastReport, result.previousDaily);
    assert.equal(result.state.retries + result.state.dailyRetries, 1);
    assert.equal(result.state.warnings.length, 1);
  }
});

test("schema-invalid wttr JSON cannot replace the last good current conditions", () => {
  for (const raw of [
    "null", "[]", "{}", '{"current_condition":[]}', '{"current_condition":[null]}',
    '{"current_condition":["invalid"]}', '{"current_condition":[[]]}'
  ]) {
    const result = runExitHandler("forecast", raw);
    assert.equal(result.root.report, result.previousReport);
    assert.equal(result.root.label, "previous-icon");
    assert.equal(result.state.retries, 1);
    assert.equal(result.state.warnings.length, 1);
    assert.equal(result.state.saves, 0);
    assert.equal(result.state.refreshes, 0);
  }
});

test("obsolete and cancelled geocoding does not update the editor; queued queries still start", () => {
  for (const overrides of [{ editingLocation: false }, { geocodeActiveQuery: "Old query" }]) {
    const result = runExitHandler("geocode", "{}", 63, 0, overrides);
    assert.equal(result.state.searches, 0);
    assert.equal(result.state.warnings.length, 0);
    assert.equal(result.root.locationError, "");
  }
  const result = runExitHandler("geocode", "{}", 63, 0, { geocodePendingQuery: "Next query" });
  assert.deepEqual(result.state.queued, [result.root.startGeocode]);
});

function runCurl(url, timeout, limit, extraEnvironment = {}) {
  const [command, ...args] = Network.curlCommand(url, timeout, limit);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", ...extraEnvironment },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = [];
    const errors = [];
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({
      code, signal, output: Buffer.concat(output), error: Buffer.concat(errors).toString()
    }));
  });
}

test("curl bounds known-length, chunked and close-delimited bodies before collection", async t => {
  const server = http.createServer((request, response) => {
    const [kind, sizeText] = request.url.slice(1).split("/");
    const size = Number(sizeText);
    if (kind === "incomplete") {
      response.writeHead(200, { "Content-Length": 100, Connection: "close" });
      response.end('{"valid":"prefix"}');
    } else if (kind === "timeout") {
      response.writeHead(200);
      response.write('{"valid":"prefix"}');
    } else if (kind === "stream" || size >= 32 * 1024 * 1024) {
      if (kind === "known") response.setHeader("Content-Length", size);
      const chunk = Buffer.alloc(16384, 0x20);
      let sent = 2;
      response.write("{}");
      function writeChunk() {
        if (response.destroyed) return;
        if (sent >= size) {
          response.end();
          return;
        }
        const next = chunk.subarray(0, Math.min(chunk.length, size - sent));
        sent += next.length;
        if (response.write(next)) setImmediate(writeChunk);
        else response.once("drain", writeChunk);
      }
      writeChunk();
    } else {
      if (kind === "known") response.setHeader("Content-Length", size);
      else if (kind === "chunked") response.setHeader("Transfer-Encoding", "chunked");
      else {
        response.useChunkedEncodingByDefault = false;
        response.setHeader("Connection", "close");
      }
      response.write("{}" + " ".repeat(size - 2));
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const { name, timeout } of requests) {
    const limit = Network.responseLimits[name];
    for (const kind of ["known", "chunked", "close"]) {
      for (const size of [limit - 1, limit, limit + 1]) {
        await t.test(`${name}: ${kind} body, ${size} bytes`, async () => {
          const result = await runCurl(`${baseUrl}/${kind}/${size}`, timeout, limit);
          assert.equal(result.signal, null);
          assert.ok(result.output.length <= limit, `${result.output.length} bytes collected with limit ${limit}`);
          if (size <= limit) {
            assert.equal(result.code, 0, result.error);
            assert.equal(result.output.length, size);
            assert.equal(Network.responseText(result.output.toString(), result.code, 0, limit), "{}");
          } else {
            assert.equal(result.code, 63, result.error);
            assert.throws(() => Network.responseText(result.output.toString(), result.code, 0, limit), /Request failed/);
          }
        });
      }
    }
  }

  for (const [kind, code, timeout] of [["incomplete", 18, 4], ["timeout", 28, 0.2]]) {
    await t.test(`rejects valid JSON from ${kind} transfers`, async () => {
      const result = await runCurl(`${baseUrl}/${kind}`, timeout, 1024);
      assert.equal(result.code, code, result.error);
      assert.deepEqual(JSON.parse(result.output.toString()), { valid: "prefix" });
      assert.throws(() => Network.responseText(result.output.toString(), code, 0, 1024), /Request failed/);
    });
  }

  for (const kind of ["known", "stream"]) {
    await t.test(`simultaneous requests reject 32 MiB ${kind} bodies within their byte budgets`, async () => {
      const started = performance.now();
      const results = await Promise.all(requests.map(async ({ name, timeout }) => {
        const limit = Network.responseLimits[name];
        const result = await runCurl(`${baseUrl}/${kind}/${32 * 1024 * 1024}`, timeout, limit);
        assert.equal(result.code, 63, `${name}: ${result.error}`);
        assert.ok(result.output.length <= limit, `${name}: ${result.output.length} bytes`);
        const state = runExitHandler(name, result.output.toString(), result.code);
        assert.equal(state.state.parses, 0, name);
        assert.equal(state.state.searches, 0, name);
        return result.output.length;
      }));
      const collected = results.reduce((sum, size) => sum + size, 0);
      assert.ok(collected <= 394240);
      t.diagnostic(`${kind} stress: ${collected} bytes collected total, ${(performance.now() - started).toFixed(1)} ms`);
    });
  }

  await t.test("curlrc cannot add extra transfers or enable decompression", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "weather-curl-test-"));
    const config = path.join(home, ".curlrc");
    try {
      fs.writeFileSync(config, `compressed\nurl = "${baseUrl}/known/1024"\n`);
      const result = await runCurl(`${baseUrl}/known/2`, 4, 1024, { CURL_HOME: home });
      assert.equal(result.code, 0, result.error);
      assert.equal(result.output.toString(), "{}");
    } finally {
      fs.unlinkSync(config);
      fs.rmdirSync(home);
    }
  });
});
