const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const fixtures = path.join(__dirname, "e2e");
const budgets = { forecast: 262144, daily: 65536, geocode: 65536, location: 1024 };
const timeouts = { forecast: 10, daily: 5, geocode: 5, location: 4 };

function endpoint(url) {
  if (url.hostname === "wttr.in") return url.searchParams.get("format") === "j1" ? "forecast" : "location";
  if (url.hostname === "api.open-meteo.com") return "daily";
  if (["geocoding-api.open-meteo.com", "api.zippopotam.us"].includes(url.hostname)) return "geocode";
  throw new Error(`Unexpected external endpoint: ${url.href}`);
}

function payload(kind, url) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dates = Array.from({ length: 4 }, (_, i) => new Date(+today + i * 86400000).toISOString().slice(0, 10));
  if (kind === "location") return "Auto City, Test Country\n";
  if (kind === "forecast") return {
    fixture: "good",
    current_condition: [{ temp_C: "21", temp_F: "70", FeelsLikeC: "20", FeelsLikeF: "68", windspeedKmph: "10", windspeedMiles: "6", humidity: "60", weatherCode: "113" }],
    nearest_area: [{ latitude: "40", longitude: "-75", areaName: [{ value: "Auto City" }], country: [{ value: "Test Country" }] }],
    weather: dates.map(date => ({ date, maxtempC: "25", mintempC: "15", maxtempF: "77", mintempF: "59", hourly: [{ time: "1200", weatherCode: "113" }] })),
  };
  if (kind === "daily") return {
    fixture: "good",
    latitude: Number(url.searchParams.get("latitude")),
    longitude: Number(url.searchParams.get("longitude")),
    utc_offset_seconds: 0,
    current: { temperature_2m: 23, apparent_temperature: 22, relative_humidity_2m: 55, wind_speed_10m: 12, weather_code: 0, is_day: 1 },
    daily: { time: dates, weather_code: dates.map(() => 0), temperature_2m_max: dates.map(() => 26), temperature_2m_min: dates.map(() => 14), sunrise: dates.map(date => `${date}T06:00`), sunset: dates.map(date => `${date}T18:00`) },
    hourly: {
      time: Array.from({ length: 96 }, (_, i) => new Date(+today + i * 3600000).toISOString().slice(0, 16)),
      temperature_2m: Array.from({ length: 96 }, (_, i) => 20 + i % 8),
      precipitation_probability: Array(96).fill(30), precipitation: Array(96).fill(0.2),
      weather_code: Array(96).fill(0), is_day: Array(96).fill(1),
    },
  };
  if (url.hostname === "api.zippopotam.us") return {
    "post code": "19103",
    places: [{ "place name": "Philadelphia", "state abbreviation": "PA", state: "Pennsylvania", latitude: "39.95", longitude: "-75.17" }],
  };
  return { results: [{ name: url.searchParams.get("name"), admin1: "Test Region", country: "Test Country", latitude: 41, longitude: -76 }] };
}

function executable(file, source) {
  fs.writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o700 });
}

function prepare(work, scenario, address) {
  for (const directory of ["home", "runtime", "cache", "config", "data", "state", "bin", "production"])
    fs.mkdirSync(path.join(work, directory), { recursive: true, mode: 0o700 });
  for (const entry of ["Commons", "Ui", "driver.js", "shell.qml"])
    fs.cpSync(path.join(fixtures, entry), path.join(work, entry), { recursive: true });
  for (const file of ["Panel.qml", "HourlyForecast.qml", "Model.js", "Network.js", "Cache.py"]) {
    fs.copyFileSync(path.join(root, file), path.join(work, "production", file));
    assert.deepEqual(fs.readFileSync(path.join(work, "production", file)), fs.readFileSync(path.join(root, file)));
  }
  const settings = path.join(work, "home/.local/state/omarchy/settings");
  fs.mkdirSync(settings, { recursive: true });
  if (!["auto", "lookups", "schema", "timeouts", "auto-cache", "auto-refresh", "auto-refresh-interrupted"].includes(scenario))
    fs.writeFileSync(path.join(settings, "weather.json"), JSON.stringify({ name: "Initial City", latitude: 40, longitude: -75 }));

  // A whitelist-only PATH means the real location helper can never execute.
  fs.symlinkSync("/usr/bin/python3", path.join(work, "bin", "python3"));
  fs.writeFileSync(path.join(work, "bin", "curl"), `#!/usr/bin/python3
import os
import sys
import urllib.parse
args = sys.argv[1:]
assert len(args) == 7 and args[0:3] == ["-q", "-fsS", "--max-time"] and args[4] == "--max-filesize", args
url = urllib.parse.urlparse(args[6])
assert url.scheme == "https" and url.hostname in ["wttr.in", "api.open-meteo.com", "geocoding-api.open-meteo.com", "api.zippopotam.us"], url
args[6] = os.environ["WEATHER_E2E_SERVER"] + "/proxy?" + urllib.parse.urlencode({
    "url": args[6], "timeout": args[3], "limit": args[5]
})
os.execv("/usr/bin/curl", ["/usr/bin/curl"] + args)
`, { mode: 0o700 });
  executable(path.join(work, "bin", "omarchy-weather-location"), `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const home = process.env.HOME;
if (home !== ${JSON.stringify(path.join(work, "home"))}) throw new Error("Unsafe HOME");
const destination = path.join(home, ".local/state/omarchy/settings/weather.json");
let state = { name: "", latitude: null, longitude: null };
if (args[0] === "--set") {
  const coordinates = (args[2] || "").split(",").map(Number);
  state = { name: args[1], latitude: coordinates[0], longitude: coordinates[1] };
} else if (args[0] !== "--clear") throw new Error("Unexpected save command");
fs.appendFileSync(${JSON.stringify(path.join(work, "saves.jsonl"))}, JSON.stringify(args) + "\\n");
fs.writeFileSync(destination, JSON.stringify(state));
`);
  return {
    HOME: path.join(work, "home"), PATH: path.join(work, "bin"),
    // Same private directory, short enough for Linux's AF_UNIX socket limit.
    XDG_RUNTIME_DIR: "/proc/self/cwd/runtime", XDG_CACHE_HOME: path.join(work, "cache"),
    XDG_CONFIG_HOME: path.join(work, "config"), XDG_DATA_HOME: path.join(work, "data"),
    XDG_STATE_HOME: path.join(work, "state"), XDG_CONFIG_DIRS: path.join(work, "config"),
    QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software", QSG_RHI_BACKEND: "software",
    TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    WEATHER_E2E_SERVER: address, WEATHER_E2E_SCENARIO: scenario,
  };
}

async function runScenario(scenario) {
  for (const executable of ["/usr/bin/quickshell", "/usr/bin/curl", "/usr/bin/python3"])
    assert.ok(fs.existsSync(executable), `Native QML regression prerequisite missing: ${executable}`);
  // Intentionally inside the repository, never /tmp, a real HOME or live shell.
  const work = path.join(fixtures, `.runtime-${process.pid}-${scenario}`);
  fs.mkdirSync(work, { mode: 0o700 });
  const requests = [];
  const memorySamples = [];
  const cacheSnapshots = [];
  let nativePid;
  let plan = {};
  const server = http.createServer((request, response) => {
    const target = new URL(request.url, "http://127.0.0.1");
    if (target.pathname === "/control") {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        const next = JSON.parse(body);
        if (!next.inspect) plan = next;
        if (next.memory) {
          assert.ok(Number.isInteger(nativePid) && nativePid > 0, "No spawned native test PID");
          const status = fs.readFileSync(`/proc/${nativePid}/status`, "utf8");
          const sample = { label: next.memory, pid: nativePid };
          for (const field of ["VmRSS", "VmHWM"]) {
            const match = status.match(new RegExp(`^${field}:\\s+(\\d+) kB$`, "m"));
            assert.ok(match, `${field} unavailable for spawned Quickshell test PID ${nativePid}`);
            sample[`${field}KiB`] = Number(match[1]);
          }
          memorySamples.push(sample);
        }
        if (next.cache) {
          cacheSnapshots.push({
            label: next.cache,
            data: JSON.parse(fs.readFileSync(path.join(work, "cache/just-right-weather/forecast.json"), "utf8")),
          });
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ requests, memorySamples, cacheSnapshots }));
      });
      return;
    }
    try {
      assert.equal(target.pathname, "/proxy");
      const upstream = new URL(target.searchParams.get("url"));
      const kind = endpoint(upstream);
      assert.equal(Number(target.searchParams.get("limit")), budgets[kind]);
      assert.equal(Number(target.searchParams.get("timeout")), timeouts[kind]);
      const queue = plan[kind];
      const configured = Array.isArray(queue) ? (queue.shift() || plan.fallback || "good") : (queue || plan.fallback || "good");
      const options = typeof configured === "string" ? { mode: configured } : configured;
      const record = { kind, url: upstream.href, limit: budgets[kind], timeout: timeouts[kind], mode: options.mode || "good", tag: plan.tag || "" };
      requests.push(record);
      const started = Date.now();
      let timer;
      response.on("close", () => {
        record.cancelled = !response.writableEnded;
        record.elapsedMs = Date.now() - started;
        clearTimeout(timer);
      });
      const send = () => {
        let value = payload(kind, upstream);
        if (typeof value === "object") value.fixture = options.marker || record.tag || "good";
        if (options.coordinates && kind === "forecast") {
          value.nearest_area[0].latitude = String(options.coordinates[0]);
          value.nearest_area[0].longitude = String(options.coordinates[1]);
        }
        if (options.temperature && kind === "daily") value.current.temperature_2m = options.temperature;
        if (options.temperature && kind === "forecast") value.current_condition[0].temp_C = String(options.temperature);
        if (record.mode === "api-error") value = { error: true, reason: "Fixture error" };
        if (record.mode === "no-hourly") delete value.hourly;
        if (record.mode === "schema-null") value = null;
        if (record.mode === "schema-missing-current") delete value.current_condition;
        if (record.mode === "schema-null-current") value.current_condition = [null];
        let body = typeof value === "string" ? value : JSON.stringify(value);
        const headers = { "Content-Type": "application/json", Connection: "close" };
        if (record.mode === "http") {
          response.writeHead(503, headers);
          response.end("Fixture service unavailable");
          return;
        }
        if (record.mode === "oversize" || record.mode === "chunked") {
          body += " ".repeat(budgets[kind] + 1);
          if (record.mode === "oversize") headers["Content-Length"] = Buffer.byteLength(body);
          else headers["Transfer-Encoding"] = "chunked";
        }
        if (record.mode === "truncated") headers["Content-Length"] = Buffer.byteLength(body) + 100;
        if (record.mode === "malformed") body = "{";
        if (record.mode === "empty") body = "";
        response.writeHead(200, headers);
        response.end(body);
      };
      if (options.delay) timer = setTimeout(send, options.delay);
      else send();
    } catch (error) {
      response.writeHead(500);
      response.end(error.stack);
    }
  });
  let output = "";
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const environment = prepare(work, scenario, `http://127.0.0.1:${server.address().port}`);
    const cachePath = path.join(work, "cache/just-right-weather/forecast.json");
    if (scenario === "cache-write-error")
      fs.writeFileSync(path.dirname(cachePath), "A file blocks cache directory creation");
    if (scenario === "helper-timeout") {
      plan = { fallback: { mode: "good", delay: 800 } };
      fs.unlinkSync(path.join(work, "bin", "python3"));
      executable(path.join(work, "bin", "python3"), `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(path.join(work, "helpers.jsonl"))},
  JSON.stringify({ pid: process.pid, operation: process.argv[4] }) + "\\n");
process.stdin.resume();
setInterval(() => {}, 1000);
`);
    }
    const phases = scenario === "cache" ? ["cache", "cache-offline", "cache-expired", "cache-report-expired", "cache-mismatch", "cache-corrupt"]
      : scenario === "unsafe-cache" ? ["unsafe-cache-symlink", "unsafe-cache-fifo", "unsafe-cache-oversize", "unsafe-cache-directory"]
      : scenario === "auto-cache" ? ["auto-cache", "auto-cache-moved", "auto-cache-interrupted", "auto-cache-retry"] : [scenario];
    let savedCache;
    for (const phase of phases) {
      let expectedCache;
      let unrelatedPath;
      let unrelatedContents;
      if (phase.startsWith("unsafe-cache-")) {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
        unrelatedPath = path.join(work, "unrelated.json");
        unrelatedContents = JSON.stringify({
          version: 1, locationQuery: "40,-75",
          report: { data: payload("forecast", new URL("https://wttr.in/")), updatedAt: Date.now() },
          dailyForecast: null,
        });
        fs.writeFileSync(unrelatedPath, unrelatedContents);
        if (phase === "unsafe-cache-symlink") fs.symlinkSync(unrelatedPath, cachePath);
        else if (phase === "unsafe-cache-fifo") assert.equal(spawnSync("mkfifo", [cachePath]).status, 0);
        else if (phase === "unsafe-cache-oversize") {
          fs.writeFileSync(cachePath, "");
          fs.truncateSync(cachePath, 1024 * 1024 * 1024);
        } else {
          const unrelatedDirectory = path.join(work, "unrelated-directory");
          fs.mkdirSync(unrelatedDirectory);
          unrelatedPath = path.join(unrelatedDirectory, "forecast.json");
          fs.writeFileSync(unrelatedPath, unrelatedContents);
          fs.rmdirSync(path.dirname(cachePath));
          fs.symlinkSync(unrelatedDirectory, path.dirname(cachePath));
        }
        plan = { tag: phase, fallback: { mode: "good", delay: 800 } };
      } else if (phase.startsWith("auto-cache-")) {
        fs.writeFileSync(cachePath, savedCache);
        plan = {
          tag: phase,
          forecast: { mode: "good", delay: 800, coordinates: [44, -79] },
          daily: [{ mode: phase === "auto-cache-retry" ? "http" : "good", delay: 1600 }, "good"],
        };
      } else if (phase === "cache-offline") {
        savedCache = fs.readFileSync(cachePath, "utf8");
        plan = { tag: phase, fallback: { mode: "http", delay: 15000 } };
      } else if (phase === "cache-expired" || phase === "cache-report-expired") {
        const age = 7 * 86400000;
        const expired = JSON.parse(savedCache, (key, value) => {
          if (key === "updatedAt") return value - age;
          if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(value)) {
            const time = Date.parse(value.length === 10 ? value + "T00:00:00Z" : value + "Z");
            return new Date(time - age).toISOString().slice(0, value.length);
          }
          return value;
        });
        if (phase === "cache-report-expired") expired.dailyForecast = null;
        expectedCache = JSON.stringify(expired);
        fs.writeFileSync(cachePath, expectedCache);
        plan = { tag: phase, fallback: { mode: "http", delay: 800 } };
      } else if (phase === "cache-mismatch") {
        fs.writeFileSync(path.join(work, "home/.local/state/omarchy/settings/weather.json"),
          JSON.stringify({ name: "Different City", latitude: 44, longitude: -79 }));
        plan = { tag: phase, fallback: { mode: "good", delay: 800 } };
      } else if (phase === "cache-corrupt") {
        fs.writeFileSync(cachePath, '{"partial":');
        plan = { tag: phase, fallback: { mode: "good", delay: 800 } };
      }
      const result = await new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/quickshell", ["--no-color", "--path", path.join(work, "shell.qml")], {
          cwd: work, env: { ...environment, WEATHER_E2E_SCENARIO: phase }, stdio: ["ignore", "pipe", "pipe"],
        });
        nativePid = child.pid;
        let timedOut = false;
        let killTimer;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
        }, 120000);
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { output += chunk; });
        child.on("error", error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          if (timedOut) reject(new Error("Native QML timeout\n" + output));
          else resolve({ code, signal });
        });
      });
      assert.equal(result.code, 0, output);
      assert.match(output, new RegExp(`WEATHER_E2E_PASS ${phase} \\d+ assertions`), output);
      if (phase.startsWith("unsafe-cache-")) {
        assert.equal(fs.readFileSync(unrelatedPath, "utf8"), unrelatedContents, "Unrelated file must not change");
        if (phase !== "unsafe-cache-directory") {
          assert.ok(fs.lstatSync(cachePath).isFile(), "Live weather safely replaces rejected cache entries");
          const saved = JSON.parse(fs.readFileSync(cachePath, "utf8"));
          assert.equal(saved.report.data.fixture, phase);
          assert.equal(saved.dailyForecast.data.fixture, phase);
        }
      }
      if (phase === "auto-cache") {
        savedCache = fs.readFileSync(cachePath, "utf8");
        const saved = JSON.parse(savedCache);
        assert.equal(saved.locationQuery, "");
        assert.equal(saved.report.data.nearest_area[0].latitude, "40");
        assert.equal(saved.dailyForecast.data.latitude, 40);
      } else if (phase.startsWith("auto-cache-")) {
        const saved = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        assert.equal(saved.locationQuery, "");
        assert.equal(saved.report.data.fixture, phase);
        assert.equal(saved.report.data.nearest_area[0].latitude, "44");
        assert.equal(saved.report.data.nearest_area[0].longitude, "-79");
        if (phase === "auto-cache-interrupted") {
          assert.equal(saved.dailyForecast, null, "An interrupted refresh must not persist an old-location daily payload");
        } else {
          assert.equal(saved.dailyForecast.data.fixture, phase);
          assert.equal(saved.dailyForecast.data.latitude, 44, "The cached daily payload must belong to the live wttr area");
          assert.equal(saved.dailyForecast.data.longitude, -79);
        }
      }
      if (phase === "cache-offline")
        assert.equal(fs.readFileSync(cachePath, "utf8"), savedCache, "Timeouts must not overwrite the disk cache");
      if (expectedCache)
        assert.equal(fs.readFileSync(cachePath, "utf8"), expectedCache, "Offline errors must not freshen an expired cache");
      if (phase === "cache-mismatch" || phase === "cache-corrupt") {
        const saved = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        assert.equal(saved.locationQuery, "44,-79");
        assert.equal(saved.report.data.fixture, phase);
        assert.equal(saved.dailyForecast.data.fixture, phase);
      }
    }
    assert.doesNotMatch(output, /^\s*ERROR\b/m, output);
    assert.doesNotMatch(output, /WEATHER_E2E_FAIL|ReferenceError|TypeError|Unable to assign|Cannot assign|Binding loop/i, output);
    if (scenario === "helper-timeout") {
      const helpers = fs.readFileSync(path.join(work, "helpers.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert.ok(helpers.some(helper => helper.operation === "read"));
      assert.ok(helpers.some(helper => helper.operation === "write"));
      for (const helper of helpers)
        assert.throws(() => process.kill(helper.pid, 0), { code: "ESRCH" }, "Timed-out helper must no longer exist");
    }
    assert.ok(requests.some(request => request.kind === "forecast"));
    assert.ok(requests.some(request => request.kind === "daily"));
    for (const passed of output.match(/WEATHER_E2E_PASS[^\n]+/g)) console.log(passed);
    const saveFile = path.join(work, "saves.jsonl");
    const saves = fs.existsSync(saveFile) ? fs.readFileSync(saveFile, "utf8").trim().split("\n").map(JSON.parse) : [];
    const stateFile = path.join(work, "home/.local/state/omarchy/settings/weather.json");
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;
    return { requests, output, saves, state, memorySamples, cacheSnapshots };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(work, { recursive: true, force: true });
  }
}

test("native QML startup and IP auto-location stay loopback-only", async () => {
  const { requests } = await runScenario("auto");
  assert.ok(requests.some(request => request.kind === "location"));
});

test("native QML city, unchanged pin, ZIP saves and clearing complete", async () => {
  const { requests, saves, state } = await runScenario("editor");
  assert.ok(requests.some(request => new URL(request.url).hostname === "api.zippopotam.us"));
  assert.deepEqual(saves, [
    ["--set", "Test City, Test Region", "41,-76"],
    ["--set", "Test City, Test Region", "41,-76"],
    ["--set", "Philadelphia, PA 19103", "39.95,-75.17"],
    ["--clear"],
  ]);
  assert.deepEqual(state, { name: "", latitude: null, longitude: null });
});

test("native QML rejects failed, oversized and truncated responses, retries and retains stale reports", async () => {
  const { requests, output, saves } = await runScenario("failures");
  for (const kind of ["forecast", "daily"]) {
    assert.deepEqual(requests.filter(request => request.tag === "exhaust" && request.kind === kind).map(request => request.mode),
      ["http", "oversize", "truncated", "malformed"]);
  }
  for (const code of [22, 63, 18])
    assert.match(output, new RegExp(`Request failed with exit code ${code}`), `Missing real curl failure ${code}\n${output}`);
  assert.deepEqual(saves, []);
});

test("native QML cancellation and replacement queries ignore obsolete responses", async () => {
  const { requests, saves } = await runScenario("races");
  for (const tag of ["search-race", "cancel-search", "weather-race"])
    assert.ok(requests.some(request => request.tag === tag && request.cancelled), `Missing actual process cancellation: ${tag}`);
  assert.ok(requests.some(request => request.kind === "daily" && new URL(request.url).searchParams.get("latitude") === "43"));
  for (const kind of ["forecast", "daily"])
    assert.ok(requests.some(request => request.tag === "weather-race" && request.kind === kind && request.cancelled), `${kind} was not cancelled`);
  assert.deepEqual(saves, []);
});

test("native QML auto-location and geocode failures retain labels and reject unsafe commits", async () => {
  const { requests, saves } = await runScenario("lookups");
  for (const kind of ["location", "geocode"]) {
    const modes = requests.filter(request => request.kind === kind).map(request => request.mode);
    for (const mode of ["http", "oversize", "truncated", "empty"])
      assert.ok(modes.includes(mode), `${kind} did not exercise ${mode}`);
  }
  assert.deepEqual(saves, []);
});

test("native QML reports spawned-process memory across repeated failure and recovery cycles", async () => {
  const { requests, memorySamples, saves } = await runScenario("memory");
  assert.deepEqual(memorySamples.map(sample => sample.label), [
    "baseline",
    "http-failed", "http-recovered",
    "oversize-failed", "oversize-recovered",
    "truncated-failed", "truncated-recovered",
    "chunked-failed", "chunked-recovered",
  ]);
  assert.equal(new Set(memorySamples.map(sample => sample.pid)).size, 1);
  for (const sample of memorySamples) {
    assert.ok(sample.VmRSSKiB > 0 && sample.VmHWMKiB >= sample.VmRSSKiB, "Native memory counters are present");
    console.log(`WEATHER_E2E_MEMORY ${JSON.stringify(sample)}`);
  }
  for (const mode of ["http", "oversize", "truncated", "chunked"])
    for (const kind of ["forecast", "daily"])
      assert.deepEqual(requests.filter(request => request.tag === `memory-${mode}` && request.kind === kind).map(request => request.mode), [mode, "good"]);
  assert.deepEqual(saves, []);
});

test("native QML rejects schema-invalid wttr JSON without replacing last-good current conditions", async () => {
  const { requests, output, saves } = await runScenario("schema");
  for (const mode of ["schema-null", "schema-missing-current", "schema-null-current"])
    assert.deepEqual(requests.filter(request => request.tag === mode && request.kind === "forecast").map(request => request.mode), [mode, "good"]);
  assert.equal((output.match(/No current conditions in weather response/g) || []).length, 3);
  assert.deepEqual(saves, []);
});

test("native QML restores disk cache across real offline restarts and rejects mismatched or corrupt caches", async () => {
  const { requests, output } = await runScenario("cache");
  assert.match(output, /Weather cache load failed/);
  assert.match(output, /Request failed with exit code 28/);
  for (const kind of ["forecast", "daily"])
    assert.ok(requests.some(request => request.kind === kind && request.tag === "cache-offline" && request.cancelled));
});

test("native QML auto-mode restart waits for live coordinates and keeps moved-network cache payloads consistent", async () => {
  const { requests } = await runScenario("auto-cache");
  for (const phase of ["auto-cache-moved", "auto-cache-interrupted", "auto-cache-retry"]) {
    const daily = requests.filter(request => request.tag === phase && request.kind === "daily");
    assert.equal(daily.length, phase === "auto-cache-retry" ? 2 : 1);
    for (const request of daily) {
      const url = new URL(request.url);
      assert.equal(url.searchParams.get("latitude"), "44");
      assert.equal(url.searchParams.get("longitude"), "-79");
    }
  }
  assert.ok(requests.some(request => request.tag === "auto-cache-interrupted" && request.kind === "daily" && request.cancelled));
  assert.deepEqual(requests.filter(request => request.tag === "auto-cache-retry" && request.kind === "daily").map(request => request.mode), ["http", "good"]);
});

test("native QML cache write errors are logged without discarding live weather", async () => {
  const { output } = await runScenario("cache-write-error");
  assert.match(output, /Weather cache write failed/);
});

test("native QML rejects symlink, FIFO, oversized and redirected caches without blocking startup", async () => {
  const { output } = await runScenario("unsafe-cache");
  assert.equal((output.match(/Weather cache load failed/g) || []).length, 4);
  assert.match(output, /Weather cache write failed/, "Redirected cache directory cannot be written");
});

test("native QML cache watchdogs kill stalled readers and writers while live weather recovers", async () => {
  const { output } = await runScenario("helper-timeout");
  assert.match(output, /Weather cache load failed: helper did not finish within 5 seconds/);
  assert.match(output, /Weather cache write failed: helper did not finish within 5 seconds/);
});

test("native QML repeated auto refreshes reject obsolete coordinates in either response order", async () => {
  const { requests, cacheSnapshots, output } = await runScenario("auto-refresh");
  for (const [tag, latitude, longitude] of [
    ["auto-refresh-report-first", 44, -79],
    ["auto-refresh-daily-first", 45, -80],
    ["auto-refresh-old-failed", 45, -81],
  ]) {
    const daily = requests.filter(request => request.tag === tag && request.kind === "daily");
    assert.equal(daily.length, 2, "One old-coordinate request and one current replacement");
    assert.equal(new URL(daily[1].url).searchParams.get("latitude"), String(latitude));
    assert.equal(new URL(daily[1].url).searchParams.get("longitude"), String(longitude));
    assert.equal(daily[0].cancelled, false, "Obsolete response really arrives and is rejected");
    const saved = cacheSnapshots.find(snapshot => snapshot.label === tag).data;
    assert.equal(saved.report.data.nearest_area[0].latitude, String(latitude));
    assert.equal(saved.report.data.nearest_area[0].longitude, String(longitude));
    assert.equal(saved.dailyForecast.data.latitude, latitude);
    assert.equal(saved.dailyForecast.data.longitude, longitude);
    assert.equal(saved.dailyForecast.data.fixture, tag + "-current");
  }
  for (const snapshot of cacheSnapshots.filter(snapshot => snapshot.label.endsWith("-pending")))
    assert.equal(snapshot.data.dailyForecast, null, "No mismatched daily payload persists during replacement");
  assert.doesNotMatch(output, /Hourly weather response failed/, "Obsolete failures do not affect current retries");
});

test("native QML interrupted auto refresh cannot persist mixed-location data", async () => {
  const { requests, cacheSnapshots } = await runScenario("auto-refresh-interrupted");
  const saved = cacheSnapshots[0].data;
  assert.equal(saved.report.data.nearest_area[0].latitude, "44");
  assert.equal(saved.dailyForecast, null);
  assert.ok(requests.some(request => request.tag === "auto-refresh-report-first" && request.kind === "daily" && request.cancelled));
});

test("native QML hard timeouts terminate all four hung requests while the UI keeps running", async () => {
  const { requests, output } = await runScenario("timeouts");
  for (const kind of ["forecast", "daily", "geocode", "location"]) {
    const request = requests.find(request => request.tag === "timeouts" && request.kind === kind);
    assert.ok(request && request.cancelled, `${kind} must time out and close its connection`);
    assert.ok(request.elapsedMs >= timeouts[kind] * 1000 - 500, `${kind} ended before its timeout`);
    assert.ok(request.elapsedMs <= timeouts[kind] * 1000 + 3000, `${kind} exceeded its hard timeout: ${request.elapsedMs}ms`);
  }
  assert.ok((output.match(/Request failed with exit code 28/g) || []).length >= 4);
});
