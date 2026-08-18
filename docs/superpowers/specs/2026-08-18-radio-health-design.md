# Radio health: detection, recovery, and debug features

Date: 2026-08-18

The receiver has failed in the field with a "deaf radio" symptom: no decodes arrive
while the loop task, HTTP surface, SSE stream, and telemetry keep working. The noise
floor (`noise_dBm`, `rtl_433_ESP::averageRssi`) pins at about -126 dBm instead of the
normal -85. A manual reboot restores full function.

This design adds detection, recovery, and debug observability so the receiver
diagnoses and recovers from that failure class on its own, and a debugging session
can establish presence, reset reason, and timing after the fact.

## Root cause found in review

The backlog's "shared radio SPI between two tasks with no lock" item is not a bus
race in this build. RadioLib's `ArduinoHal` wraps every register transaction in
`SPI.beginTransaction()`/`endTransaction()` (RadioLib `Hal.cpp`), and the Arduino
ESP32 SPI driver's `beginTransaction` takes a per-bus mutex. The receiver task's RSSI
reads (`rtl_433_ESP.cpp:901-915`) and `radioTemperature()`'s reads
(`WebReceiver.ino:199-241`) go through the same `newSPI` (FSPI) instance, so the
transactions are serialized, not corrupted.

The real defect is the unverified standby-to-receive dance in `radioTemperature()`:
after the temperature read parks the radio in standby, a failed `receiveDirect()` (or
a failed one-shot retry) leaves the radio parked. The sketch swallows the failure
(`INT16_MIN`, keeps the last `radio_C`), and nothing else notices. A parked SX1231
reads its RSSI floor, which is the observed -126; with `AUTORSSITHRESHOLD`,
`rssiThreshold` tracks down with it, so no signal ever triggers a decode. The loop
task stays healthy, so the task watchdog (which only fires on a hung loop) never
trips. Deaf until reboot.

A runtime radio re-init is safe from `loop()`: `initReceiver()`'s task creation is
guarded by `if (!rtl_433_ReceiverHandle)` (`rtl_433_ESP.cpp:406-415`), so re-calling
it will not spawn a second receiver task, and the bus mutex serializes it against RSSI
sampling.

## Detection: a radio health monitor

New module `radio_health` (new files `receiver/radio_health.h/.cpp`), evaluated once
per telemetry cycle from `loop()`. Each cycle it computes three states from existing
observables:

| State | Condition | Default |
|---|---|---|
| `silent` | no decode for `SILENT_MS`: `millis() - lastDecodeAt > SILENT_MS` | 3 min |
| `pinned` | `averageRssi` at/below `NOISE_FLOOR_DBM` for the whole confirmation window | -120 dBm |
| `frozen` | `averageRssi` byte-identical for `FROZEN_MS` | 5 min |

A healthy floor reads -85 to -115 dBm; a parked standby radio reads its ~-126 floor,
so `pinned` is the -126 signature. The three constants are build flags like the
existing `DEVICE_STALE_HOURS`.

Interpretation (evaluated in this order):

- `silent AND frozen` — the receiver task is not sampling at all (wedged). Soft
  re-init cannot restart it (the task-handle guard), so this means reboot.
- `silent AND pinned` (without `frozen`) — radio parked in standby, receiver task
  alive. Soft re-init.
- `silent` with a healthy floor — a genuinely quiet band or a dead sensor battery.
  No action. This is what keeps a normal quiet period from triggering a reboot.

Any decode resets all counters.

## Recovery ladder

State lives in `radio_health`: `recoveryCount`, `lastRecoveryAt` (uptime), and the
per-window counters above. Driven from `loop()`:

1. **Soft re-init** — `reinitRadio()` re-runs the radio config path and ends in
   `receiveDirect()`. Safe from `loop()` per the root-cause finding. Whether it calls
   the full `rf.initReceiver(...)` or a lean sequence (`radio.reset()` + the RF69
   config subset + `receiveDirect()`) depends on whether `rtlSetup()` and
   `newSPI.begin()` are idempotent when repeated; the plan verifies this and uses the
   lean sequence if they are not.
2. **Backoff** — after a soft re-init, suppress further recovery for a backoff window
   (default 2 min) and require the `silent` + `pinned` condition to re-confirm before
   the next attempt.
3. **Reboot fallback** — `esp_restart()` when `frozen`, or after `MAX_SOFT_RECOVERY`
   (default 3) soft re-inits without a decode since the first attempt, or when the
   temperature path fails twice in a row.
4. **Event** — every recovery step (soft re-init, reboot decision) increments
   `recoveryCount`, stamps `lastRecoveryAt`, logs to serial (`Log.warning`), and the
   next `recordReceiver()` carries the state out over SSE.

Edge behavior:

- A false-positive soft re-init on a healthy quiet band just re-inits the radio once
  (harmless, tens of milliseconds) and bumps `recoveryCount`; the pinned check's
  sustained window keeps this rare.
- Aliases (NVS) survive; the device table (RAM) clears only on the reboot path.
- SSE clients survive a soft re-init; they reconnect after a reboot as today.

## Temperature path fix

`radioTemperature()` keeps the manual bounded register read but no longer swallows
failures: after the `receiveDirect()` attempt it verifies the radio is back in RX
(return code plus a confirming OpMode read). Any failure records a recovery event and
runs the soft re-init immediately, so a failed dance recovers in seconds instead of
waiting for the monitor window. `radio_C` stays on its 60 s cadence.

## Telemetry, NVS history, and boot logging

New fields on the `Receiver/0` telemetry message, produced by the health module and a
boot record:

| Field | Source |
|---|---|
| `uptime_s` | `millis() / 1000` |
| `boot_count` | NVS counter, incremented each boot |
| `last_reset_reason` | `esp_reset_reason()` captured in `setup()` |
| `recovery_count` | NVS counter, incremented per soft re-init |
| `last_recovery_s` | uptime at last soft re-init, 0 until first |
| `radio_ok` | 1 healthy, 0 recovering |
| `rssi_thresh` | `rtl_433_ESP::rssiThreshold` |
| `coredump_pending` | `esp_core_dump_image_check()` at boot; 1 if a dump is in flash |

The dashboard renders unknown fields automatically, so these appear on the receiver
card without a dashboard change. Optional polish (not in this work): add them to the
dashboard's `STATUS_FIELDS` so they do not clutter the card body.

NVS history lives in a `Preferences` namespace `"health"`, separate from
alias_store's. Keys: `boot_count`, `last_reset_reason` (int enum),
`recovery_count`, `last_recovery` (epoch seconds once SNTP is set), `last_boot_utc`
(stamped once on the first SNTP sync). Writes are bounded: once at boot, once on
first SNTP sync, once per recovery event.

Boot logging: in `setup()`, before `rf.initReceiver()`, log build, reset reason,
boot count, free heap, and coredump presence. The ESP-IDF `Found core dump N bytes
in flash` line already prints on the USB console when a dump exists; our line adds
reset reason and boot count on the same stream.

## Tooling

- Coredump fetch: a short doc (or `receiver/tools/coredump.md`) plus optional
  one-liner script — `esptool.py read_flash 0x3f0000 0x10000 core.bin` decoded with
  the xtensa `espcoredump.py`/gdb from the PlatformIO toolchain against
  `firmware.elf`.
- `receiver/docs/backlog.md`: remove the shared-SPI race entry (replaced by the
  mutex finding above) and update the partition-table entry (a 64 K `coredump`
  partition already exists at `0x3f0000` in the built table; the entry's table is
  outdated).
- `monitor.py` needs no functional change.

## Testing

- Host tests for the health-decision logic, following the existing `topic.cpp`
  pattern (`receiver/test/host/run.sh`): a pure decision function (inputs: silent,
  pinned, frozen, recovery attempt count, elapsed) returning the action enum. Cases:
  quiet-band no-op; parked -> soft; wedged -> reboot; a decode resets counters;
  backoff suppresses re-trigger; `MAX_SOFT_RECOVERY` -> reboot;
  pinned-but-not-frozen -> soft.
- `FAKE_SIGNALS` gains a recovery-exercise mode: a build flag that makes the health
  check see `silent` + `pinned` after N minutes so the soft re-init path runs and
  logs on real hardware. Requires a board.
- Binding and dashboard suites: the new telemetry fields are additive; the binding
  tests assert specific fields exist, so no breakage is expected. The plan runs them
  to confirm.

## Documentation

- `receiver/docs/architecture.md`: add the `radio_health` module boundary and the
  recovery data flow.
- `receiver/README.md` "Limits" section: add the recovery behavior.
