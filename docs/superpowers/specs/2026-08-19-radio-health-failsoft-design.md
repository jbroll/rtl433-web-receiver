# Radio health fail-soft remediation

## Problem

The receiver's radio became unreliable after `318046d` added radio health
detection, recovery, and telemetry. That commit introduced a buggy
`radioBackInRx()` compare (against `RADIOLIB_RF69_RX >> 2` instead of
`RADIOLIB_RF69_RX`) that made every temperature read look like a failed RX
restart, triggering spurious re-inits and board reboots; and a recovery ladder
that escalated to `esp_restart()`, which does not power-cycle the radio, so a
stuck chip produced a ~60s reboot loop that took the web server down each cycle.

`abe3b14` fixed the `radioBackInRx` compare and `ce563ba` stopped the pinned
signature from rebooting. But the temperature read still blocks `loop()` for up
to ~120ms in a 12-iteration `delay(10)` retry loop, prints ~10 `dbg`
`Log.warning` lines on every telemetry cycle, and the wedged-task
(`frozen && !pinned`) path still calls `esp_restart()`.

## Goal

Keep the radio health detection and telemetry (`boot_count`, `recovery_count`,
`last_recovery_s`, `radio_ok`, `coredump_pending`, pinned detection, soft
re-init on backoff) while removing every source of unreliability the feature
introduced:

- No `esp_restart()` anywhere in the recovery path.
- The temperature read is non-blocking and fails soft: a single `setMode`
  attempt, skip the measurement on failure, and never escalate.
- No `dbg` diagnostic logging and no debug-only register reads in the
  temperature path.
- Drop the now-consumerless `frozen` detection and `FROZEN_MS`.

## Changes

### `receiver/radio_health.h` and `receiver/radio_health.cpp`

- `HealthAction` becomes `{ none, softReinit }`; `reboot` is removed.
- `HealthState` drops `lastFloor` and `floorSince`.
- `decide()` drops the `frozen` parameter and the
  `silent && frozen && !pinned -> reboot` branch. Only
  `silent && pinned` with a lapsed backoff returns `softReinit`.
- `evaluate()` keeps the decode-reset and `lastRecoveryAt` stamping; the
  floor-since tracking goes.
- The `FROZEN_MS` default in the header goes.

### `receiver/WebReceiver.ino`

`radioTemperature()`:

- Replace the 12-iteration `delay(10)` `setMode(STANDBY)` retry with a single
  attempt. On failure, log one warning and skip the temperature measurement.
- Remove the `dbg` `Log.warning` lines and the debug-only register reads
  (`DIO_MAPPING_2`, `RSSI_CONFIG`, rssi, opmode, opfull, irq1, irq2, thresh).
- Keep the active-reception guard, `disableReceiver`/`enableReceiver`, the
  measurement itself, the `receiveDirect` retry, the correct `radioBackInRx`
  check, and the fail-soft recovery (`reinitRadio` + `recordRecoveryEvent` +
  return `INT16_MIN`).

`monitorRadioHealth()`:

- Remove the `else if (action == reboot) { esp_restart(); }` branch. Only
  `softReinit` remains.
- Keep the `esp_core_dump.h`/`esp_system.h` includes: `setup()` still uses
  `esp_core_dump_image_check()` and `esp_reset_reason()`.

### `receiver/platformio.ini`

- Remove the `-DFROZEN_MS=300000` flag. Keep `SILENT_MS`, `NOISE_FLOOR_DBM`,
  `RECOVERY_BACKOFF_MS`.

### `receiver/test/host/radio_health_test.cpp`

- Remove the `reboot` assertions and the frozen-window block.
- Update `decide()` calls to the new signature (no `frozen` parameter).
- Keep pinned, backoff, decode-reset, and `noteRecovery` coverage.

### Docs

- `receiver/docs/architecture.md`: rewrite the `radio_health` module blurb and
  the "Radio health and recovery" section to describe the single soft-reinit
  recovery, the fail-soft temperature read, and the absence of reboots. Keep the
  below-floor-noise-as-error note and the stuck-chip-needs-power-cycle note.
- `receiver/docs/development.md`: update the `FAKE_RADIO_FAIL_MS` exercise text
  to match the new recovery behavior.

## Tradeoff

A wedged receiver task (frozen, healthy floor) is no longer auto-rebooted. It
reports `radio_ok` 0 and waits for a manual power cycle. This is accepted: a
wedged task survives `esp_restart()` anyway, and the reboot only took the web
server down.

## Out of scope

- The pinout rewiring and BMP280 sensor work in `655f8ca`.
- The `radioBackInRx` correctness fix from `abe3b14` (kept).
- The pinned detection, soft re-init, backoff, and health telemetry (kept).