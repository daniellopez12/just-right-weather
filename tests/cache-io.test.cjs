const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const helper = path.resolve(__dirname, "../Cache.py");
const limit = 512 * 1024;

function fixture(t) {
  const work = fs.mkdtempSync(path.join(__dirname, "e2e/.runtime-cache-io-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const directory = path.join(work, "just-right-weather");
  fs.mkdirSync(directory);
  return { work, directory, file: path.join(directory, "forecast.json") };
}

function run(operation, file, input) {
  const result = spawnSync("python3", ["-I", helper, operation, file], {
    input, timeout: 2000, maxBuffer: limit + 8192,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function rejected(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout.length, 0, "rejected files must emit no content to QML");
  assert.match(result.stderr.toString(), /Weather (cache|location|version) .* failed/);
}

function pythonCheck(work, code) {
  const result = spawnSync("python3", ["-I", "-c", `
import os
import runpy
import sys
from unittest.mock import patch
cache = runpy.run_path(sys.argv[1])
work = sys.argv[2]
${code}
`, helper, work], { timeout: 2000, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

test("cache helper round-trips UTF-8 bytes through atomic private writes", t => {
  const { directory, file } = fixture(t);
  fs.rmdirSync(directory);
  const data = Buffer.from('{"location":"Montr\u00e9al","temperature":"21\u00b0C"}');
  assert.equal(run("write", file, data).status, 0);
  assert.deepEqual(run("read", file).stdout, data);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ["forecast.json"]);
  assert.equal(run("write", file, data).status, 0, "identical-content writes finish normally");
});

test("location reader applies a fixed 16 KiB byte budget before emitting content", t => {
  const { file } = fixture(t);
  const data = Buffer.from("\u00e9".repeat(8192));
  fs.writeFileSync(file, data);
  assert.deepEqual(run("read-location", file).stdout, data);
  fs.appendFileSync(file, "x");
  rejected(run("read-location", file));
  fs.truncateSync(file, 1024 * 1024 * 1024);
  rejected(run("read-location", file));
});

test("version reader follows manifest changes without a second version constant", t => {
  const { file } = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../manifest.json"), "utf8"));
  for (const version of [manifest.version, "2.0.0", "10.12.34-beta.2"]) {
    fs.writeFileSync(file, JSON.stringify({ ...manifest, version }));
    const result = run("read-version", file);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.toString(), version);
  }
});

test("version reader rejects unsafe files, oversized manifests and invalid metadata", t => {
  const { work, file } = fixture(t);
  const manifest = { id: "io.github.daniellopez12.just-right-weather", version: "9.8.7" };
  assert.equal(run("read-version", file).status, 3);
  for (const data of ["{", "null", "[]", "{}", JSON.stringify({ ...manifest, id: "other.plugin" }),
    ...[null, 7, "", " ", "1.0\n7", "x".repeat(65)].map(version => JSON.stringify({ ...manifest, version }))]) {
    fs.writeFileSync(file, data);
    rejected(run("read-version", file));
  }
  const data = JSON.stringify(manifest);
  fs.writeFileSync(file, data.padEnd(16 * 1024, " "));
  assert.equal(run("read-version", file).stdout.toString(), "9.8.7");
  fs.appendFileSync(file, " ");
  rejected(run("read-version", file));
  fs.unlinkSync(file);
  const target = path.join(work, "unrelated.json");
  fs.writeFileSync(target, data);
  fs.symlinkSync(target, file);
  rejected(run("read-version", file));
  fs.unlinkSync(file);
  assert.equal(spawnSync("mkfifo", [file]).status, 0);
  rejected(run("read-version", file));
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  rejected(run("read-version", file));
  assert.equal(fs.readFileSync(target, "utf8"), data);
});

test("location reader rejects symlinks, FIFOs, directories and redirected parents without output", t => {
  const { work, file, directory } = fixture(t);
  assert.equal(run("read-location", file).status, 3);
  const unrelated = path.join(work, "unrelated");
  fs.writeFileSync(unrelated, '{"name":"Private pin","latitude":42,"longitude":-73}');
  fs.symlinkSync(unrelated, file);
  rejected(run("read-location", file));
  fs.unlinkSync(file);
  assert.equal(spawnSync("mkfifo", [file]).status, 0);
  rejected(run("read-location", file));
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  rejected(run("read-location", file));
  fs.rmdirSync(file);
  fs.rmdirSync(directory);
  fs.symlinkSync(work, directory);
  rejected(run("read-location", file));
  assert.equal(fs.readFileSync(unrelated, "utf8"), '{"name":"Private pin","latitude":42,"longitude":-73}');
});

test("location reader rejects growth past 16 KiB after fstat", t => {
  const { work } = fixture(t);
  pythonCheck(work, `
file = os.path.join(work, "weather.json")
with open(file, "wb") as output:
    output.write(b"{}")
original_fstat = os.fstat
def grow(fd):
    info = original_fstat(fd)
    with open(file, "ab") as output:
        output.write(b"x" * cache["LOCATION_MAX_BYTES"])
    return info
directory = os.open(work, os.O_RDONLY | os.O_DIRECTORY)
with patch("os.fstat", side_effect=grow):
    try:
        cache["read_cache"](directory, "weather.json", cache["LOCATION_MAX_BYTES"])
    except ValueError as error:
        assert "exceeds" in str(error)
    else:
        raise AssertionError("Location growth escaped its limit")
os.close(directory)
`);
});

test("cache helper reports missing files separately from failures", t => {
  const { directory, file } = fixture(t);
  for (const removeDirectory of [false, true]) {
    if (removeDirectory) fs.rmdirSync(directory);
    const result = run("read", file);
    assert.equal(result.status, 3);
    assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr.length, 0);
  }
});

test("cache helper accepts exactly 512 KiB and rejects one byte more before output", t => {
  const { file } = fixture(t);
  const data = Buffer.alloc(limit, "x");
  fs.writeFileSync(file, data);
  assert.deepEqual(run("read", file).stdout, data);
  assert.equal(run("write", file, data).status, 0);
  fs.appendFileSync(file, "x");
  rejected(run("read", file));
  fs.truncateSync(file, 1024 * 1024 * 1024);
  rejected(run("read", file));
});

test("oversized or empty producer input leaves the previous cache unchanged", t => {
  const { file, directory } = fixture(t);
  fs.writeFileSync(file, "previous");
  for (const input of [Buffer.alloc(0), Buffer.alloc(limit + 1), Buffer.from("\u00e9".repeat(limit / 2 + 1))]) {
    rejected(run("write", file, input));
    assert.equal(fs.readFileSync(file, "utf8"), "previous");
    assert.deepEqual(fs.readdirSync(directory), ["forecast.json"]);
  }
});

test("cache helper never reads through symlinks, including dangling links", t => {
  const { work, file } = fixture(t);
  const target = path.join(work, "unrelated");
  fs.writeFileSync(target, "private unrelated contents");
  for (const destination of [target, path.join(work, "missing")]) {
    fs.symlinkSync(destination, file);
    rejected(run("read", file));
    fs.unlinkSync(file);
  }
  assert.equal(fs.readFileSync(target, "utf8"), "private unrelated contents");
});

test("cache helper rejects FIFOs without waiting for a writer and rejects directories", t => {
  const { file } = fixture(t);
  assert.equal(spawnSync("mkfifo", [file]).status, 0);
  rejected(run("read", file));
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  rejected(run("read", file));
});

test("atomic writes replace symlinks and FIFOs without opening their targets", t => {
  const { work, file } = fixture(t);
  const target = path.join(work, "unrelated");
  fs.writeFileSync(target, "untouched");
  fs.symlinkSync(target, file);
  for (const type of ["symlink", "fifo"]) {
    if (type === "fifo") assert.equal(spawnSync("mkfifo", [file]).status, 0);
    assert.equal(run("write", file, "replacement").status, 0);
    assert.ok(fs.lstatSync(file).isFile());
    assert.equal(fs.readFileSync(file, "utf8"), "replacement");
    assert.equal(fs.readFileSync(target, "utf8"), "untouched");
    fs.unlinkSync(file);
  }
});

test("cache helper rejects a symlinked cache directory for both reads and writes", t => {
  const { work, directory, file } = fixture(t);
  const target = path.join(work, "unrelated-directory");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "forecast.json"), "untouched");
  fs.rmdirSync(directory);
  fs.symlinkSync(target, directory);
  rejected(run("read", file));
  rejected(run("write", file, "replacement"));
  assert.equal(fs.readFileSync(path.join(target, "forecast.json"), "utf8"), "untouched");
  assert.deepEqual(fs.readdirSync(target), ["forecast.json"]);
});

test("read remains capped if a regular file grows after the descriptor size check", t => {
  const { work } = fixture(t);
  pythonCheck(work, `
file = os.path.join(work, "forecast.json")
with open(file, "wb") as output:
    output.write(b"small")
original_fstat = os.fstat
def grow(fd):
    info = original_fstat(fd)
    with open(file, "ab") as output:
        output.write(b"x" * (cache["MAX_BYTES"] + 1))
    return info
directory = os.open(work, os.O_RDONLY | os.O_DIRECTORY)
with patch("os.fstat", side_effect=grow):
    try:
        cache["read_cache"](directory, "forecast.json")
    except ValueError as error:
        assert "exceeds" in str(error)
    else:
        raise AssertionError("A growing cache escaped its read limit")
os.close(directory)
`);
});

test("descriptor checks and reads use the same file even if its name is swapped", t => {
  const { work } = fixture(t);
  pythonCheck(work, `
file = os.path.join(work, "forecast.json")
target = os.path.join(work, "unrelated")
with open(file, "wb") as output:
    output.write(b"original")
with open(target, "wb") as output:
    output.write(b"must not read")
original_fstat = os.fstat
def swap(fd):
    info = original_fstat(fd)
    os.rename(file, file + ".held")
    os.symlink(target, file)
    return info
directory = os.open(work, os.O_RDONLY | os.O_DIRECTORY)
with patch("os.fstat", side_effect=swap):
    assert cache["read_cache"](directory, "forecast.json") == b"original"
os.close(directory)
`);
});

test("atomic publication stays in the held directory when its path is swapped", t => {
  const { work, directory } = fixture(t);
  pythonCheck(work, `
parent = os.path.join(work, "just-right-weather")
target = os.path.join(work, "unrelated")
os.mkdir(target)
original_replace = os.replace
def swap(source, destination, **kwargs):
    os.rename(parent, parent + ".held")
    os.symlink(target, parent)
    original_replace(source, destination, **kwargs)
directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
with patch("os.replace", side_effect=swap):
    cache["write_cache"](directory, "forecast.json", b"accepted")
os.close(directory)
assert os.listdir(target) == []
`);
  assert.equal(fs.readFileSync(path.join(directory + ".held", "forecast.json"), "utf8"), "accepted");
});

test("failed atomic publication preserves the old cache and cleans its temporary file", t => {
  const { work, file, directory } = fixture(t);
  fs.writeFileSync(file, "previous");
  pythonCheck(work, `
directory = os.open(os.path.join(work, "just-right-weather"), os.O_RDONLY | os.O_DIRECTORY)
with patch("os.replace", side_effect=OSError("simulated publication failure")):
    try:
        cache["write_cache"](directory, "forecast.json", b"replacement")
    except OSError:
        pass
    else:
        raise AssertionError("Publication error was hidden")
os.close(directory)
`);
  assert.equal(fs.readFileSync(file, "utf8"), "previous");
  assert.deepEqual(fs.readdirSync(directory), ["forecast.json"]);
});
