const assert = require("node:assert/strict");
const test = require("node:test");
const Model = require("../Model.js");

const fetchedAt = Date.parse("2030-01-10T12:00:00Z");
const report = { current_condition: [{ temp_C: "21", weatherCode: "113" }] };
const daily = {
  utc_offset_seconds: 0,
  hourly: { time: ["2030-01-10T12:00"], temperature_2m: [23] },
  current: { temperature_2m: 23, weather_code: 0, is_day: 1 }
};

function cache() {
  const first = Model.updatedWeatherCache(null, "40,-75", "report", report, fetchedAt);
  return Model.updatedWeatherCache(first, "40,-75", "dailyForecast", daily, fetchedAt + 1);
}

test("weather cache round-trips both provider payloads and original timestamps", () => {
  const saved = cache();
  assert.deepEqual(Model.parseWeatherCache(JSON.stringify(saved)), saved);
  assert.equal(saved.report.updatedAt, fetchedAt);
  assert.equal(saved.dailyForecast.updatedAt, fetchedAt + 1);
});

test("updating one source preserves the other only for the same location", () => {
  const previous = cache();
  const next = Model.updatedWeatherCache(previous, "40,-75", "report", report, fetchedAt + 2);
  assert.equal(next.dailyForecast, previous.dailyForecast);
  assert.equal(previous.report.updatedAt, fetchedAt);
  for (const query of ["", "New%20City", "41,-76"]) {
    for (const source of ["report", "dailyForecast"]) {
      const data = source === "report" ? report : daily;
      const changed = Model.updatedWeatherCache(previous, query, source, data, fetchedAt);
      assert.equal(changed.locationQuery, query);
      assert.equal(changed[source === "report" ? "dailyForecast" : "report"], null);
      assert.deepEqual(Model.parseWeatherCache(JSON.stringify(changed)), changed);
    }
  }
  assert.throws(() => Model.updatedWeatherCache(previous, "", "unknown", report, fetchedAt), /Unknown/);
});

test("expired hourly windows remain valid cached data without becoming fresh again", () => {
  const saved = Model.parseWeatherCache(JSON.stringify(cache()));
  assert.equal(Model.hourlyForecast(saved.dailyForecast.data, fetchedAt + 86400000, 48).length, 0);
  assert.equal(Model.openMeteoCurrentCondition(saved.dailyForecast.data).temp_C, "23");
  assert.equal(saved.dailyForecast.updatedAt, fetchedAt + 1);
});

test("malformed, unsupported and schema-invalid cache files are rejected", () => {
  for (const raw of ["", "{", "null", "[]", "{}"]) {
    assert.throws(() => Model.parseWeatherCache(raw));
  }
  for (const change of [
    value => { value.version = 2; },
    value => { value.locationQuery = null; },
    value => { value.report = null; value.dailyForecast = null; },
    value => { delete value.report; },
    value => { value.report.updatedAt = "123"; },
    value => { value.dailyForecast.updatedAt = 0; },
    value => { value.report.data = { current_condition: [null] }; },
    value => { value.dailyForecast.data = { error: true }; },
    value => { value.dailyForecast.data.hourly = {}; }
  ]) {
    const value = JSON.parse(JSON.stringify(cache()));
    change(value);
    assert.throws(() => Model.parseWeatherCache(JSON.stringify(value)));
  }
});
