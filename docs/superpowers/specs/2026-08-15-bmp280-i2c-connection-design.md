# BMP280 I2C Connection Design

## Scope

Add a dedicated I2C bus to the `rtl433-carrier` PCB and an ESP32-S3 firmware path
that records BMP280 temperature and pressure readings as if they were rtl_433
decodes. The bus is sized for a BMP280 now and an AHT20 later, sharing SDA/SCL
with no address collision. The microSD socket on the Freenove ESP32-S3-WROOM CAM
is sacrificed: the SDMMC pins it sits on become radio control/data lines, and
future card access is dropped.

A prerequisite, folded into this spec, is a pin-map fix in
`receiver/platformio.ini` so the firmware actually drives the carrier's RFM69CW.
Without it the wrong pins are claimed as radio lines and the new I2C lines are
fought at boot.

The carrier is in `/home/john/src/rtl433-carrier` (its own git repo). The firmware
is in `/home/john/src/rtl433-web-receiver/receiver`. Implementation will split
across the two repos; this spec is the single shared design.

## Carrier wiring today

The carrier joins a Freenove ESP32-S3-WROOM CAM to a HopeRF RFM69CW 433 MHz
transceiver running `rtl_433_ESP`. The RFM69CW is a 14-pin module. Side A
(pins 8-14) reads `MISO, DIO0, DIO2, DIO1, DIO5, RESET, GND`; side B
(pins 7-1) reads `NSS, SCK, MOSI, DIO3, GND, 3.3V, ANT`. The schematic is a
SKiDL script (`board.py`) that generates `rtl433-carrier.net`; `seed_board.py`
turns that into a placed PCB. The chosen wiring uses only the pins
`rtl_433_ESP` actually touches for RF69 continuous-data mode:

| Signal | GPIO | Freenove header | RFM69CW pin |
|---|---|---|---|
| MISO | 1 | right 3 | 8 |
| MOSI | 42 | right 5 | 5 |
| SCK | 41 | right 6 | 6 |
| NSS | 39 | right 8 | 7 |
| DIO2 (data) | 40 | right 7 | 10 |
| GND | - | right 20 | 3, 14 |
| 3V3 | - | left 1 | 2 |
| RESET | 38 | right 9 | 13 |
| ANT | - | - | 1 |

R1 10k pulls RESET to GND, R2 10k pulls NSS to 3V3. C1 100 nF, C2 1 uF, C3 47 uF
decouple. ANT1 is a quarter-wave whip pad. DIO0 (RFM69CW pin 9), DIO1
(RFM69CW pin 11), DIO3 (RFM69CW pin 4) and DIO5 (RFM69CW pin 12) are not
connected; `rtl_433_ESP` never uses them in RF69 continuous-data mode, and
`RADIOLIB_NC` is a supported configuration. GPIO 40 has the Freenove board's
existing 10k pull-up on SDMMC DATA0, which keeps DIO2 at a defined level while
the radio is in reset.

## Pin budget

The Freenove ESP32-S3-WROOM CAM commits most of its GPIO before anything is
added. The camera takes 4-13 and 15-18. Octal PSRAM takes 33-37. Strapping is
0, 3, 45, 46. USB is 19 and 20. UART0 is 43 and 44. The onboard LED is on GPIO 2.
SDMMC is 38 (CMD), 39 (CLK) and 40 (DATA0). Header order, from `docs/architecture.md`:

```
left : 3V3 EN 4 5 6 7 15 16 17 18 8 3 46 9 10 11 12 13 14 5V
right: 43 44 1 2 42 41 40 39 38 37 36 35 0 45 48 47 21 20 19 GND
```

The SDMMC pins (38, 39, 40) are repurposed for the radio, sacrificing the
microSD socket. With the radio on GPIO 1, 38, 39, 40, 41, 42, I2C on GPIO 21
and 47, and the NeoPixel on GPIO 48, GPIO 14 is the only spare general-purpose
pin.

### DIO0 is functionally inert in `rtl_433_ESP`

In the RF69/SX1231 receive path the library's edge ISR attaches to
`RF_MODULE_RECEIVER_GPIO`, which `rtl_433_ESP.h:180` defines as `RF_MODULE_DIO2`.
`rtl_433_ESP.cpp:317` maps only DIO2 to continuous-data output
(`setDIOMapping(2, RADIOLIB_RF69_DIO2_CONT_DATA >> 2)`); the only
`attachInterrupt` is on `receiverGpio` (DIO2). There is no `setDio0Action` and no
`setDIOMapping(0, ...)` call. DIO0 is passed to RadioLib's `Module()` but never
read. It has the same status as DIO1: wired, but droppable to `RADIOLIB_NC`.

This spec keeps DIO0 wired on the carrier to preserve the option of using it in
future firmware (packet mode, TX). The pin-budget lever it creates is noted but
not spent.

## Design: dedicated I2C bus

A separate I2C bus is added on GPIO 21 (SDA) and GPIO 47 (SCL). GPIO 21 and 47
are adjacent on the Freenove right header and were previously used for the
radio's inert DIO0 and DIO2 lines. With those lines removed from the radio,
21/47 become a clean I2C home. The carrier adds 10k pull-ups on both lines.

This choice preserves everything that does not move: the NeoPixel on GPIO 48,
full UART0 (TX on 43 and RX on 44), the camera, the existing SPI block, and the
radio's soft-reset line on GPIO 38. The receiver task is untouched: the BMP280
read shares no bus with the radio, so the SPI contention the backlog already flags
stays exactly where it is and gets no worse.

The cost is the microSD socket: GPIO 38, 39 and 40 are now used for the radio,
so the Freenove microSD socket is not usable. If microSD is ever enabled later
in firmware, the SDMMC peripheral will drive those pins with arbitrary push-pull
traffic and corrupt the radio interface.

### Why not share with the radio SPI or with UART0

Multiplexing I2C SDA with SPI MOSI (and I2C SCL with SPI SCK) sounds attractive
but is not robust: the I2C sensors hard-listen on SDA at all times, so arbitrary
radio MOSI transitions while SCK is high will, with certainty, occasionally cross
the I2C START pattern and desync the sensor state machine. Disabling the ESP32's
I2C peripheral does nothing to the sensors' input buffers. There is no
waveform-level guarantee that avoids this for arbitrary radio traffic.

Sharing one pin with the radio SPI bus is no better: NSS (GPIO 39) is pulsed by
the receiver task continuously for RSSI reads, MOSI/SCK are actively driven, and
MISO is acted on by the radio. Reusing any of them forces the receiver task to
suspend during every sensor read and adds a third client to a bus the backlog
already flags as contended (`receiver/docs/backlog.md:43-54`).

Reusing UART0 RX (GPIO 44) works electrically but loses a future serial-console
input. Reusing the radio RESET line (GPIO 38) works electrically but loses radio
soft-reset. The chosen I2C placement on GPIO 21/47 is the only path that
preserves every other hardware feature.

## Prerequisite: pin-map fix in `receiver/platformio.ini`

The `RF_MODULE_*` map tells the firmware which GPIOs the radio occupies. The
chosen map assigns the six pins `rtl_433_ESP` actually uses and passes the two
unused DIO lines as `RADIOLIB_NC`:

| `RF_MODULE_*` flag | GPIO | Note |
|---|---|---|
| `MISO` | 1 | SPI MISO |
| `MOSI` | 42 | SPI MOSI |
| `SCK`  | 41 | SPI SCK |
| `CS`   | 39 | NSS/CS |
| `RST`  | 38 | reset pulse |
| `DIO0` | `RADIOLIB_NC` | unused in RF69 continuous-data mode |
| `DIO1` | `RADIOLIB_NC` | unused in RF69 continuous-data mode |
| `DIO2` | 40 | continuous data output |

The comment on `platformio.ini:58` ("ESP32-S3-CAM") is updated in the same edit.

## Carrier hardware changes

Edit `rtl433-carrier/board.py` (the authoritative SKiDL script), regenerate the
netlist and seeded PCB, and re-run DRC.

### RFM69 net changes

The radio keeps MISO/MOSI/SCK on GPIO 1/42/41 and moves the remaining signals:

| Signal | Old GPIO | New GPIO | Freenove header |
|---|---|---|---|
| NSS | 2 | 39 | right 8 |
| RESET | 14 | 38 | right 9 |
| DIO2 (data) | 47 | 40 | right 7 |
| DIO0 | 21 | NC | — |
| DIO1 | NC | NC | — |

R1 10k now pulls RESET (GPIO 38) to GND. R2 10k now pulls NSS (GPIO 39) to 3V3.
GPIO 40 already has the Freenove 10k pull-up on SDMMC DATA0, so no extra pull-up
is needed for DIO2.

### New I2C nets

- `I2C_SDA` on GPIO 21 (Freenove right pos 17)
- `I2C_SCL` on GPIO 47 (Freenove right pos 16)

### New components

- **J6** `PinHeader_1x04_P2.54mm`, F.Cu, near the top edge of the carrier.
  Pinout `+3V3 | GND | I2C_SDA | I2C_SCL`. This is the off-board I2C header the
  BMP280 breakout plugs into. `+3V3` taps the +3V3 net; `GND` reaches the existing
  ground pour through a via. Placement away from the bottom edge avoids the
  USB-C cable zone and the radio/antenna keepouts on the back.
- **R3** 10 k 0603, `I2C_SCL` to `+3V3`.
- **R4** 10 k 0603, `I2C_SDA` to `+3V3`.

R3 and R4 sit on the front, near J6, so the pull-ups live with the off-board
header rather than somewhere electrically convenient but visually obscure.

### What does not change on the carrier

The SPI block on GPIO 1/42/41 is unchanged. U1 (RFM69CW), ANT1, C1, C2, C3 and
the ground/+3V3 distribution stay exactly as they are. The placement script's
keepout and ground-stitch logic is unchanged; the new components sit outside the
antenna, radio, and whip rule areas.

## Firmware

Implementation is in `receiver/`. The recording path reuses the existing
`signal_store::record()` API so the dashboard, aliasing, and SSE replay
machinery work without changes.

### I2C bus

`Wire.begin(21, 47)` in `setup()`, default 100 kHz. Move to 400 kHz only if a
longer cable or slower rise time demands it. No I2C peripheral reconfiguration
is needed after boot; the bus is dedicated.

### BMP280 driver

The receiver follows a "static allocation only" house rule
(`receiver/docs/architecture.md`), so the driver preferred is a minimal register
driver over Adafruit_BMP280, which pulls Adafruit_BusIO and roughly 6-7 KB of
flash. If the flash budget allows it after `MY_DEVICES` narrows the decoders,
the Adafruit driver is acceptable; the design does not mandate either.

Read cadence is 10-30 s on the core-1 `loop()` task, low priority. The BMP280's
typical conversion time is in the millisecond range and does not block the loop
meaningfully.

### Recording

Each reading is recorded via `signal_store::record()` with a synthetic rtl_433
JSON payload. The model is `"BMP280"`, the id is a stable value derived from the
ESP32's MAC, and the channel is a fixed constant. Fields are `temperature_C` and
`pressure_hPa`, matching the field names rtl_433 already uses for the weather
sensors this receiver decodes. This is the "receiver's own card" pattern already
documented in `receiver/docs/backlog.md:23-32`.

### AHT20 later

The AHT20 lives at fixed I2C address 0x38, which does not collide with the BMP280
at 0x76 (SDO to GND) or 0x77 (SDO to VDD). Adding the AHT20 is a second driver and
a second recorded "device" on the same `Wire` bus. The breakout must hold CSB
high on the BMP280 to lock I2C mode; the AHT20 has no equivalent strapping pin.

### What does not change in firmware

Logging stays on UART0 TX (`Serial0`, 921600 baud, GPIO 43). The radio SPI path
is untouched. The receiver task and its DIO2 edge ISR are untouched.
`signal_store`, `alias_store`, `web_ui`, and `topic` are unchanged. The pin-map
fix above is the only edit to `platformio.ini`.

## Testing

Carrier: re-run `python board.py && python seed_board.py`, open the board in
KiCad, and confirm DRC clean with the new components. Visually confirm R3 and R4
sit clear of the antenna, radio, and whip rule areas.

Firmware: extend the existing `native` host tests for `signal_store` to cover
the synthetic BMP280 payload shape (model, id, fields). The driver itself is
bench-verified on hardware; a self-test guarded by `FAKE_SIGNALS=true` mirrors
the existing `signal_store` and `alias_store` self-tests. No new dashboard test
is required; the BMP280 reads as a normal device on the existing page.

## Documentation

Update `receiver/docs/architecture.md` and `receiver/docs/install.md` with the
new RFM69 and I2C pin maps. Update `receiver/docs/backlog.md` to remove the
stale "ESP32-S3-CAM" comment and note the planned I2C bus on GPIO 21/47. Update
the carrier README Pin map and `rtl433-carrier/docs/architecture.md` to record
the new RFM69 wiring on GPIO 38/39/40, the `I2C_SDA` / `I2C_SCL` nets on GPIO
21/47, the J6 sensor header, R3/R4 pull-ups, and the dropped microSD.

## Out of scope

- Adding the AHT20 in this change. The bus is sized for it; the driver is later.
- Replacing the receiver-task SPI race. The BMP280 read shares no bus with the
  radio; the race is unchanged.
- Moving logging from UART0 to USB-CDC. UART0 TX stays. That change is independent.
- Any pins on the back of the carrier or any change to the antenna, radio, or
  whip keepouts.

## Archived pin maps

Older RFM69/I2C pin assignments that were considered or used before the chosen
design above. Kept for reference and hardware debugging.

### Pre-remap `platformio.ini` (used before 2026-08-19)

This was the firmware map checked in before the remap. It did not match the
carrier and left the radio undriven if wiring was not updated:

| `RF_MODULE_*` | GPIO |
|---|---|
| MISO | 1 |
| MOSI | 42 |
| SCK | 41 |
| CS | 40 |
| RST | 39 |
| DIO0 | 38 |
| DIO1 | 47 |
| DIO2 | 21 |

### Original primary proposal (I2C on SDMMC)

This design kept the radio on the carrier's original wiring (NSS=2, RESET=14,
DIO2=47, DIO0=21, DIO1=NC) and added I2C on GPIO 39/40, sacrificing the microSD
socket:

| `RF_MODULE_*` | GPIO |
|---|---|
| MISO | 1 |
| MOSI | 42 |
| SCK | 41 |
| CS | 2 |
| RST | 14 |
| DIO0 | 21 |
| DIO1 | RADIOLIB_NC |
| DIO2 | 47 |

I2C: `Wire.begin(40, 39)`.

### Original alternative proposal (keep microSD)

This design kept the microSD socket by moving SCK to the strapping pin GPIO 45,
dropping radio RESET and DIO0, and putting I2C on GPIO 14/21:

| Function | GPIO | Note |
|---|---|---|
| MISO | 41 | costs JTAG TDI |
| MOSI | 42 | |
| SCK | 45 | strapping: pull-down only, no pull-up |
| NSS | 1 | |
| DIO2 | 47 | continuous data |
| I2C SDA | 14 | 10 k pull-up |
| I2C SCL | 21 | 10 k pull-up |
| NeoPixel | 48 | |
| LED | 2 | Freenove on-board |

```ini
'-DRF_MODULE_MISO=41'
'-DRF_MODULE_MOSI=42'
'-DRF_MODULE_SCK=45'
'-DRF_MODULE_CS=1'
'-DRF_MODULE_RST=RADIOLIB_NC'
'-DRF_MODULE_DIO0=RADIOLIB_NC'
'-DRF_MODULE_DIO1=RADIOLIB_NC'
'-DRF_MODULE_DIO2=47'
```

I2C: `Wire.begin(14, 21)`.

Open items before adopting: confirm RFM69 initializes reliably with `RADIOLIB_NC`
RESET, confirm GPIO 45 SCK pull-down keeps `VDD_SPI` at 3.3 V through reset, and
decide whether losing JTAG TDI is acceptable.

## Implementation outline

The work splits at the repo boundary:

1. `rtl433-web-receiver/receiver`: the pin-map fix in `platformio.ini` to
   MISO=1, MOSI=42, SCK=41, CS=39, RST=38, DIO2=40, DIO0/DIO1=RADIOLIB_NC.
   Land this first; without it, the carrier's RFM69 is undriven.
2. `rtl433-carrier`: the hardware change in `board.py` (RFM69 nets moved to
   38/39/40, I2C nets added on 21/47), regenerate the netlist and seeded PCB,
   DRC clean.
3. `rtl433-web-receiver/receiver`: `Wire.begin(21, 47)`, BMP280 driver,
   recording through `signal_store::record()`, host tests, hardware self-test.
4. Documentation across both repos in the same commits as the code.

The carrier work happens in a separate worktree in the `rtl433-carrier` repo; the
firmware work happens in this worktree. The spec lives in `rtl433-web-receiver`
because the firmware work is the larger piece and the recording path is where
the design's runtime behavior is defined.
