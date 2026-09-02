# Backlog

Work blocked on a board being on the bench. Nothing here breaks the receiver
as it stands; each item needs hardware in hand to verify or land safely.

## The provisioning portal is an open AP that hands out an OTA token

`WiFi.softAP(ap, nullptr)` in `provisioning.cpp` brings up an unencrypted network, and
`handleRoot()` generates a fresh token with `randomToken()` and renders it
into the form on every GET; `handleSave()` stores whatever the form returns.
Anyone in range of a board sitting in the portal can join, submit their own SSID and a token they chose,
and take the board onto their network with an OTA credential they control. `POST /$update`
then accepts arbitrary firmware.

The smallest fix is a WPA2 password on the SoftAP, derived from the chip ID so it is
reproducible without a label on the case. The AP name already uses the last two MAC bytes;
the password would use more of the MAC, or a hash of `esp_efuse_mac_get_default()`,
rendered as 8 to 10 hex characters and printed over serial at portal start alongside the
existing `provisioning: AP "%s" up at %s` line, which is how an operator learns it.
`install.md` and `quickstart.md` both currently tell the reader the AP takes no password,
so both change with it.

Deferred on lockout risk. A password derived wrongly, or printed in a format the AP does
not actually accept, leaves a board that cannot be provisioned at all except by reflashing
over USB, and the portal is the path back from a bad flash. It needs proving on a bench
board before it goes anywhere near a board that is not physically reachable.

## The firmware self-test has never been read on a live device

Eight `selfTest()` calls run at startup on real hardware, but only under
`FAKE_SIGNALS`, and nobody has read their PASS/FAIL lines from a board.
`WebReceiver.ino` already points `Log.begin()` at `Serial`, the S3's USB CDC
device, on a `FAKE_SIGNALS` build, so no UART adapter on the TX pin is needed
any more; a production build keeps `Serial0` at 921600, which is what
`monitor.py` expects. What is left is running a `FAKE_SIGNALS` build on a
board and reading it, which takes that board off the air for the duration.

The checks themselves run on every commit through `test/host/run.sh` (see
`architecture.md`): `signal_store` 87, `mqtt_publish_store` 43, `alias_store`
31, `layout_store` 18, `location_store` 12, `units_store` 12.

## An alias surviving a power cycle is unverified

`Preferences::putBytes()` is now known to land in NVS and read back on real
hardware: the deployed board reports `boot_count` 52 and
`last_reset_reason` 3 (`ESP_RST_SW`), and five aliases set through the
dashboard are still served by `GET .../$alias` after that reset cleared RAM.

Two gaps remain, both needing a board in hand. A software reset is not a
power cycle, so nothing yet proves the write survives power actually being
removed. And the migration off the `putString`-based storage this store used
before is covered only host-side, against `arduino_shim`'s `Preferences`
fake; proving it means starting from a board still running the pre-`putBytes`
firmware with aliases already set, then flashing this one.

## The raised OTA_TOKEN_STORE_MAX is unverified against a stored 32-character token

`OTA_TOKEN_STORE_MAX` is now 65 bytes, raised from a smaller buffer sized
for a 32-character token. Nothing has confirmed that a board with a
32-character token already stored under the old cap still reads it back
correctly once flashed with firmware built against the new one; proving it
needs a board with that token set before the flash, not a freshly
provisioned one.

## The 915 board is parked: it hears, but nothing has decoded

Paused deliberately, not abandoned. The hardware and firmware work; what is
missing is a known target and a trustworthy antenna. This records what was
established so none of it is re-derived.

The board carries an SX1276-family part, not the 433 board's SX1231:
`RegVersion` (0x42) reads 0x12. No record of its wiring existed, so
`receiver/probe/` recovered it by sweeping every free GPIO — SPI on the same
three pins as the 433 board, NSS on GPIO 40, DIO2 on GPIO 38, and nothing that
resets the part, so RESET, DIO0 and DIO1 are `RADIOLIB_NC`. `sx1276-915` builds
and runs end to end: `RegOpMode` accepts OOK RX continuous, `RegIrqFlags1`
reads 0xd8 (ModeReady, RxReady, PllLock, RssiOK), and the web server and MQTT
publish come up.

Roughly twenty minutes of scanning across four configurations produced no
recognised device. `receiver/probe915/` holds those scans, one environment per
hypothesis, because a single radio tests exactly one combination of frequency,
modulation, bitrate and pulse length per build.

Four reasons a scan could not have worked, each found after the scan ran:

- US utility smart meters (Itron ERT SCM+ and IDM) are at **912.6 MHz**, not
  915 — `scmplus.c` and `ert_idm.c` both record `Freq 912600155`. At a 250 kHz
  RX bandwidth that is ten bandwidths off channel.
- Their packets run a few milliseconds, and `MINIMUM_SIGNAL_DURATION` was
  30000 (30 ms), copied from the Acurite 433 packet. Anything shorter was
  discarded before reaching a decoder.
- `rtl_433_ESP.cpp:363-372` pins the SX1276 FSK front end to 17.24 kbps,
  40 kHz deviation and 83 kHz bandwidth, values copied from a Bresser 868 MHz
  station. The `short_width` values across the 915 decoders are 30, 56, 58,
  100, 104, 105, 116, 500 and 504 us, so that setting suits about four of the
  fourteen FSK ones. Ambient Weather's WH31E documents itself as
  "FSK_PCM @915 MHz, 116usec/bit", half the rate we listened at.
- `MINIMUM_PULSE_LENGTH` is 50 us in OOK mode, and upstream defines it
  unconditionally, so no build flag reaches it. SCM+ symbols are 30 us.
  `probe915/lib/` is a gitignored copy of the pinned library with an `#ifndef`
  added; recreate it with `cp -r ../.pio/libdeps/rfm69-433/rtl_433_ESP lib/`
  and re-apply that guard. Worth proposing upstream.

Two things are known and unexplained, and both need settling before any
further scan is worth running.

**Every burst quantises to multiples of 16 us with a dominant 64 us period,
regardless of band or modulation.** This is not the pulse filter: sweeping
`MINIMUM_PULSE_LENGTH` across 50, 20 and 12 us left the dominant period at
64 us. Below 20 us the capture saturates — the smallest recorded pulse becomes
0 us and the burst count pins at 122 — so sampling finer buys nothing. The
structure appears in bursts at -101 to -106 dBm, at or below the detection
threshold, so it is the instrument or the SX1276's OOK slicer rather than a
transmitter. Its origin is open.

**The noise floor fell from -96/-99 dBm in the first scans to -113/-115 dBm in
every later one**, about 18 dB, with no configuration change that accounts for
it. -115 dBm is roughly thermal noise for a 250 kHz bandwidth, which is what an
unconnected front end reads. **Check the antenna is attached and seated before
anything else** — every negative result after the first scan is suspect until
that is ruled out.

The only unambiguous signals seen were two bursts at -66 dBm, 89 and 90 ms
long, in the very first scan. That is 21 dB above threshold, so real RF energy
from something close by, transmitting twice. Its structure was unresolvable
through this capture path.

The catalogue is thinner at 915 than at 433 but not empty: 20 of the 234
decoder files name 915 MHz or 902-928, against 100 for 433, and 14 of the 20
need FSK. Frequency hopping is not the obstacle it was assumed to be — exactly
one decoder in the whole set documents hopping, and it is not a 915 sensor.

To resume, in order: confirm the antenna; if a known 915 device is available,
tune one build to that device alone, which is what this hardware does well;
otherwise identify targets with an RTL-SDR and `rtl_433 -A`, which reads 2 MHz
of spectrum at once and demodulates each protocol at its own parameters,
rather than one guess per firmware build.

## The 915 build has no radio health telemetry

`radioTemperature()` and `reinitRadio()`'s register diagnostics are SX1231
code, compiled out under `RF_RF69` rather than ported, so `sx1276-915` reports
no `radio_C` and no `irq1`, and a refused mode change cannot be told from an
SPI fault. The SX127x equivalents are `RegIrqFlags1` at 0x3E and `RegVersion`
at 0x42; the part has no temperature register comparable to the SX1231's.

`NOISE_FLOOR_DBM` (-120) is shared with the 433 board and has not been checked
against the SX1276's own measurement floor, so the `pinned` signature may not
mean the same thing there. The observed floor swing between -96 and -115 dBm
suggests it needs its own value.
