const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Model = require("../Model.js");

test("displayed plugin version stays synchronized with the release manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  const panel = fs.readFileSync(path.join(__dirname, "../Panel.qml"), "utf8");
  assert.equal(panel.match(/readonly property string pluginVersion: "([^"]+)"/)[1], manifest.version);
});

function forecast() {
  const start = Date.parse("2030-01-10T00:00:00Z");
  const time = Array.from({ length: 96 }, (_, i) =>
    new Date(start + i * 3600000).toISOString().slice(0, 16));
  const dates = ["2030-01-10", "2030-01-11", "2030-01-12", "2030-01-13"];
  return {
    utc_offset_seconds: -18000,
    hourly: {
      time,
      temperature_2m: time.map((_, i) => 10 + i % 12),
      precipitation_probability: time.map(() => 25),
      precipitation: time.map(() => 2.54),
      weather_code: time.map(() => 3),
      is_day: time.map((_, i) => i % 24 >= 7 && i % 24 < 18 ? 1 : 0)
    },
    daily: {
      time: dates,
      sunrise: dates.map(date => date + "T06:12"),
      sunset: dates.map(date => date + "T18:34"),
      temperature_2m_max: [20, 21, 22, 23],
      temperature_2m_min: [10, 11, 12, 13],
      weather_code: [0, 1, 2, 3]
    }
  };
}

test("includes exactly 48 hourly entries, independent of the computer timezone", () => {
  const report = forecast();
  const now = Date.parse("2030-01-10T22:20:00Z");
  const entries = Model.hourlyForecast(report, now, 48);
  const hours = entries.filter(entry => entry.kind === "hour");
  assert.equal(hours.length, 48);
  assert.equal(hours[0].time, Date.parse("2030-01-10T17:00:00Z"));
  assert.equal(hours.at(-1).time, Date.parse("2030-01-12T16:00:00Z"));
  assert.equal(hours[0].probability, 25);
  assert.equal(hours[0].precipitation, 2.54);
  assert.ok(entries.every((entry, i) => i === 0 || entries[i - 1].time <= entry.time));
});

test("inserts future sunrise and sunset at minute precision, not as hourly replacements", () => {
  const entries = Model.hourlyForecast(forecast(), Date.parse("2030-01-10T22:20:00Z"), 48);
  const solar = entries.filter(entry => entry.kind !== "hour");
  assert.equal(solar.length, 4);
  assert.equal(solar[0].kind, "sunset");
  assert.equal(solar[0].label, "6:34 PM");
  const index = entries.indexOf(solar[0]);
  assert.equal(entries[index - 1].label, "6 PM");
  assert.equal(entries[index + 1].label, "7 PM");
  assert.equal(solar[1].kind, "sunrise");
  assert.equal(solar[1].label, "6:12 AM");
});

test("handles positive fractional timezone offsets and missing solar events", () => {
  const report = forecast();
  report.utc_offset_seconds = 19800;
  report.daily.sunrise = [];
  report.daily.sunset = [];
  const entries = Model.hourlyForecast(report, Date.parse("2030-01-10T18:45:00Z"), 48);
  assert.equal(entries.length, 48);
  assert.equal(entries[0].date, "2030-01-11");
  assert.equal(entries[0].label, "12 AM");
});

test("shows the next three days, excluding today", () => {
  const days = Model.buildForecastDays(null, forecast(), "2030-01-10");
  assert.deepEqual(days.map(day => day.date), ["2030-01-11", "2030-01-12", "2030-01-13"]);
  assert.equal(days[0].maxtempC, "21");
  assert.equal(days[0].mintempF, "52");
});

test("formats metric and imperial values without converting missing data to zero", () => {
  assert.equal(Model.hourlyTemperature(0, false), "0\u00b0");
  assert.equal(Model.hourlyTemperature(0, true), "32\u00b0");
  assert.equal(Model.hourlyPrecipitation(25.4, true), "1.00 in");
  assert.equal(Model.hourlyPrecipitation(2.54, false), "2.5 mm");
  for (const value of [null, undefined, "", NaN]) {
    assert.equal(Model.hourlyTemperature(value, false), "\u2014");
    assert.equal(Model.hourlyPrecipitation(value, true), "\u2014");
  }
  assert.deepEqual(Model.hourlyForecast(null, Date.now(), 48), []);
});

test("unit overrides take precedence over detected country and locale", () => {
  assert.equal(Model.shouldUseImperial("metric", "en_US", "United States"), false);
  assert.equal(Model.shouldUseImperial("imperial", "en_GB", "United Kingdom"), true);
  assert.equal(Model.shouldUseImperial("", "en_US", ""), true);
  assert.equal(Model.shouldUseImperial("", "en_US", "United Kingdom"), false);
});

test("starts without a bundled location and uses generic encoded search", () => {
  assert.deepEqual(Model.parseLocationFile(""), { name: "", latitude: null, longitude: null });
  const url = new URL(Model.locationSearchUrl("Example & City"));
  assert.equal(url.hostname, "geocoding-api.open-meteo.com");
  assert.equal(url.searchParams.get("name"), "Example & City");
  assert.equal(url.searchParams.has("countryCode"), false);
  assert.equal(Model.locationSearchUrl("00000"), "https://api.zippopotam.us/us/00000");
  assert.equal(Model.coordinateLocation("91, 0"), null);
  assert.equal(Model.coordinateLocation("0, 181"), null);
  assert.equal(Model.locationMapUrl(NaN, 0), "");
});

test("preserves finite numeric rain probabilities, including zero and 100 percent", () => {
  const report = forecast();
  const probabilities = [0, 25, 37.5, 100];
  report.hourly.precipitation_probability.splice(17, probabilities.length, ...probabilities);
  const hours = Model.hourlyForecast(report, Date.parse("2030-01-10T22:20:00Z"), 48)
    .filter(entry => entry.kind === "hour");
  assert.deepEqual(hours.slice(0, probabilities.length).map(entry => entry.probability), probabilities);
});

test("rejects markup, non-numeric values, and out-of-range rain probabilities", () => {
  const report = forecast();
  const invalid = [
    '<img src="https://example.invalid/weather.png">',
    "<b>25</b>", "25", "", null, undefined, true, false, [], {},
    NaN, Infinity, -Infinity, -1, 101
  ];
  report.hourly.precipitation_probability.splice(17, invalid.length, ...invalid);
  const hours = Model.hourlyForecast(report, Date.parse("2030-01-10T22:20:00Z"), 48)
    .filter(entry => entry.kind === "hour");
  assert.equal(hours.length, 48);
  assert.deepEqual(hours.slice(0, invalid.length).map(entry => entry.probability), invalid.map(() => null));
  assert.equal(hours[invalid.length].probability, 25);
});

test("keeps missing rain probability data unavailable rather than displaying zero", () => {
  const report = forecast();
  delete report.hourly.precipitation_probability;
  const hours = Model.hourlyForecast(report, Date.parse("2030-01-10T22:20:00Z"), 48)
    .filter(entry => entry.kind === "hour");
  assert.equal(hours.length, 48);
  assert.ok(hours.every(entry => entry.probability === null));
});

test("renders external probability and saved-location text only as plain text", () => {
  for (const [file, binding] of [
    ["HourlyForecast.qml", "modelData.probability"],
    ["Panel.qml", 'text: "Saved: "']
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const blocks = Array.from(source.matchAll(/\bText\s*\{([^{}]*)\}/g), match => match[1]);
    const block = blocks.find(text => text.includes(binding));
    assert.ok(block, `Expected external-data Text element in ${file}`);
    assert.match(block, /\btextFormat:\s*Text\.PlainText\b/, `${file} must not interpret external data as HTML`);
  }
});
