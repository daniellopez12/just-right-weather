# Native QML network regressions

Run from the repository root:

```sh
node --test tests/qml-network.test.cjs
```

Requires Linux, Node.js (the built-in test runner), and
`/usr/bin/{quickshell,curl,python3}` with Qt Quick and its offscreen platform
plugin. The suite takes approximately two to three minutes. Missing prerequisites
fail explicitly rather than silently skipping native coverage.

## What runs

The runner starts the actual Quickshell executable with an offscreen Qt Quick
window. `Panel.qml`, `HourlyForecast.qml`, `Model.js`, `Network.js`, and `Cache.py` are copied
**byte-for-byte** from the current working tree and verified against the originals.
The complete production component, render tree, `Process`, `StdioCollector`,
loaders, bindings, and timers run natively. There are no extracted
handlers, injected production aliases/hooks, response-budget overrides, or
shortened retry/debounce timers.

`shell.qml` and `driver.js` provide a small native QML assertion/step runner.
Tests drive the panel's public methods and the real editor's `text` property
(which invokes production `onTextChanged`). Child-item lookup verifies the
hourly render tree and scrolling; the standard `Item.data` list exposes native
process activity without modifying production IDs.

Covered scenarios:

- Startup with configured coordinates and IP auto-location; current conditions,
  three future days, 48 hourly samples, solar events, icon/render bindings, and
  native hourly scrolling.
- City and ZIP searches, persistence, completion only after the matching weather
  provider succeeds, re-saving the unchanged pin, and clearing back to auto.
- Saved-location startup rejects symlinks to unrelated valid location JSON,
  writerless FIFOs, sparse 1 GiB files, directories, redirected parents and
  malformed JSON. The editor/heartbeat remain responsive and bounded polling
  recovers after repair without changing unrelated targets. In-session edits,
  atomic replacement, deletion/recreation and popup-triggered reloads are
  exercised; failed reads retain the last valid pin. A stalled location helper
  is killed within the production five-second deadline, startup unblocks, and
  a later read recovers. A delayed old read cannot undo a newer saved pin.
- Real curl HTTP errors (22), size errors (63), truncated transfers (18) whose
  received prefix is valid JSON, malformed JSON, and chunked oversized bodies.
  Last-good reports/freshness remain intact, stale status is displayed, both
  forecast retry budgets stop after three retries, and explicit refresh renews
  the budget and recovers.
- Geocode and auto-location HTTP, size, truncation and empty-body failures;
  additional malformed/chunked ZIP failures, blocked invalid commits, and recovery.
- Replacement/cancellation of in-flight geocoding and both weather processes;
  the server verifies connections really close and obsolete response markers
  cannot overwrite replacement data.
- Four additional failed/recovery cycles (HTTP, advertised oversize, truncation,
  chunked oversize), with `VmRSS` and `VmHWM` samples before the cycles and after
  every failed and recovered state. Only `/proc/<spawned-test-pid>/status` is read;
  the suite never inspects a live user Quickshell process. Measurements in KiB are
  diagnostic evidence, not timing, growth, or memory-ceiling assertions.
- Schema-invalid wttr bodies (`null`, missing `current_condition`, and a null
  first current condition) do not replace the last-good report or visible
  current conditions. Each case recovers through the real scheduled retry with
  the normal provider shape, `current_condition: [{ ... }]`.
- Real process restarts sharing only isolated disk state: cache creation,
  immediate offline restoration before hung weather requests finish, unchanged
  cache bytes and timestamps after timeouts, rejection of a different saved
  location and a corrupt file, and replacement with valid matching responses.
  Cache directory/write failures are logged without breaking live weather.
  Symlinks to unrelated valid weather JSON, writerless FIFOs, sparse 1 GiB
  files, and symlinked cache directories are rejected before restoration while
  the editor and native heartbeat remain responsive. Live weather repairs
  rejected file entries without altering unrelated targets; redirected cache
  directories remain unwritten.
  Stalled read/write helpers are killed by the production five-second watchdogs;
  startup recovers, queued writes settle and live weather remains visible.
  Week-old caches, including current-conditions-only caches, retain a visible
  age warning even after every hourly entry has expired and refreshes fail.
- Auto-mode restarts on a different network, with delayed wttr/Open-Meteo
  responses: no requests use restored coordinates, both persisted payloads
  identify the new area, an exit before the daily response leaves no
  mixed-location cache, and daily retries reuse only live coordinates.
- Repeated auto-mode refreshes within one running shell as the network changes,
  with wttr completing before or after the old daily response. Request coordinates
  are checked even though the location query remains empty; obsolete successes
  and failures cannot update the UI, consume retries, or contaminate disk state.
  Disk snapshots cover pending/recovered states and interrupted refreshes,
  including a longitude-only change.
- All four providers hang beyond their production deadlines. Actual curl
  timeout exits (28) and connection-close times enforce the 10/5/5/4-second
  limits while a native QML heartbeat and location editor remain responsive.

To collect just the native process memory evidence:

```sh
node --test --test-name-pattern='spawned-process memory' tests/qml-network.test.cjs
```

Each `WEATHER_E2E_MEMORY` line contains the sample label, spawned test PID,
`VmRSSKiB`, and `VmHWMKiB`. These counters include native Qt/QML rendering and
allocator caches; growth between snapshots alone does not establish a leak.

The lookup scenario also records a pre-existing model behavior: malformed city
JSON is converted to an empty results list and displays “No locations found,”
whereas malformed ZIP JSON uses the explicit parse-error path. Both paths block
saving, and neither bypasses the response-size/exit-status gate. This suite does
not change that diagnostic distinction.

## Isolation and fixture adaptations

Only Omarchy's `qs.Commons` and `qs.Ui` shell scaffolding is replaced with small,
inert QML components. The panel/controller, keyboard container, key catcher,
text field, button and style/color stubs preserve the properties used by the
production component. Shell popout placement, real keyboard/window-manager
integration, font/theme fidelity and screenshots are intentionally not tested.
The text-field stub supplies the sole test object name.

Each scenario has a private HOME, XDG directories, and executable-only PATH
under `tests/e2e/.runtime-<pid>-<scenario>`. The environment is built from an
allowlist, not inherited: live shell configuration, session buses, user
curlrc/proxies and external network configuration are not imported. The Linux
`/proc/self/cwd/runtime` alias points to that same private runtime directory,
keeping Quickshell's isolated IPC socket below the Unix socket path limit.

The PATH includes the real Python 3 interpreter for the unmodified cache helper.
The watchdog scenarios selectively substitute hanging processes for the
interpreter, and verify that every spawned stalled helper has been terminated.
The location-race scenario delays output from a real bounded helper read so a
new save can overtake it; production QML and helper files remain unchanged.
The PATH's curl wrapper whitelists production weather hosts, rewrites **only**
the URL to a loopback server, then `exec`s real curl with the original flags,
timeouts and response-size limits. The server verifies every endpoint budget.
The mock location saver rejects an unexpected HOME and only writes the private
weather state and invocation log. No real saver or device-location component is
copied or invoked, no plugin is installed, and no external weather requests run.

Responses are generated for the current UTC forecast window, avoiding fixtures
that expire. Their contents, failure sequences and delayed/cancelled requests
are controlled locally; assertions wait for observable state/request counts
instead of changing production clocks. Short explicit waits are used only to
exercise delayed-response races. Every native run has a deadline, and runtime
trees are removed in `finally`, including after failures. Failure output includes
the native QML/curl logs; successful output reports each QML assertion count.
