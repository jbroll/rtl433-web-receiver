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
