# BMP280 I2C Connection Design

## Scope

Add a dedicated I2C bus to the `rtl433-carrier` PCB and an ESP32-S3 firmware path
that records BMP280 temperature and pressure readings as if they were rtl_433
decodes. The bus is sized for a BMP280 now and an AHT20 later, sharing SDA/SCL
with no address collision. The microSD socket on the Freenove ESP32-S3-WROOM CAM
is sacrificed: the SDMMC pins it sits on become the I2C bus, and future card
access is dropped.

A prerequisite, folded into this spec, is a six-value pin-map fix in
`receiver/platformio.ini` so the firmware actually drives the carrier's RFM69HCW.
Without it the wrong pins are claimed as radio lines and the new I2C lines are
fought at boot.

The carrier is in `/home/john/src/rtl433-carrier` (its own git repo). The firmware
is in `/home/john/src/rtl433-web-receiver/receiver`. Implementation will split
across the two repos; this spec is the single shared design.

## Carrier wiring today

The carrier joins a Freenove ESP32-S3-WROOM CAM to a HopeRF RFM69HCW 433 MHz
transceiver running `rtl_433_ESP`. The schematic is a SKiDL script (`board.py`)
that generates `rtl433-carrier.net`; `seed_board.py` turns that into a placed
PCB. The preferred wiring is the Pin map in the carrier README:

| Signal | GPIO | Freenove header | RFM69HCW pin |
|---|---|---|---|
| MISO | 1 | right 3 | 2 |
| NSS | 2 | right 4 | 5 |
| MOSI | 42 | right 5 | 3 |
| SCK | 41 | right 6 | 4 |
| DIO2 (data) | 47 | right 16 | 16 |
| DIO0 | 21 | right 17 | 14 |
| GND | - | right 20 | 1, 8, 10 |
| 3V3 | - | left 1 | 13 |
| RESET | 14 | left 19 | 6 |
| ANT | - | - | 9 |

R1 10k pulls RESET to GND, R2 10k pulls NSS to 3V3. C1 100 nF, C2 1 uF, C3 47 uF
decouple. ANT1 is a quarter-wave whip pad. DIO1 (RFM69 pin 15) is deliberately
not connected; `rtl_433_ESP` never calls the FIFO hooks that read it, and `RADIOLIB_NC`
is a supported configuration for that pin.

## Pin budget

The Freenove ESP32-S3-WROOM CAM commits most of its GPIO before anything is
added. The camera takes 4-13 and 15-18. Octal PSRAM takes 33-37. Strapping is
0, 3, 45, 46. USB is 19 and 20. UART0 is 43 and 44. SDMMC is 38 (CMD), 39 (CLK)
and 40 (DATA0). Header order, from `docs/architecture.md`:

```
left : 3V3 EN 4 5 6 7 15 16 17 18 8 3 46 9 10 11 12 13 14 5V
right: 43 44 1 2 42 41 40 39 38 37 36 35 0 45 48 47 21 20 19 GND
```

That leaves 1, 2, 14, 21, 41, 42, 47 and 48 as the free set. The radio uses seven
of those (1, 2, 14, 21, 41, 42, 47), and the eighth is GPIO 48, deliberately left
for the onboard WS2812 NeoPixel status indicator.

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

## Design: dedicated I2C on the SDMMC pins

A separate I2C bus is added on GPIO 40 (SDA) and GPIO 39 (SCL), the SDMMC pins
the Freenove hard-wires to its microSD socket. GPIO 38 (CMD) is left unsocketed
and unused. Future microSD use is dropped from the platform.

The pins are electrically suitable: the Freenove already pulls DATA0 (GPIO 40) to
3V3 with 10 k, which is a valid I2C pull-up for SDA. SDMMC CLK (GPIO 39) has no
socket pull-up, so the carrier adds one.

This choice preserves everything that the carrier went out of its way to keep:
the NeoPixel on GPIO 48, the radio's soft-reset on GPIO 14, full UART0 (TX on 43
and RX on 44), the camera, the existing SPI block, and every existing radio DIO
line including the inert DIO0. The receiver task is untouched: the BMP280 read
shares no bus with the radio, so the SPI contention the backlog already flags
stays exactly where it is and gets no worse.

The cost is real but deferred by design. The microSD socket becomes unusable. If
microSD is ever enabled later in firmware, the SDMMC peripheral will drive GPIO 39
and 40 with arbitrary push-pull traffic up to 40 MHz, producing spurious I2C
STARTs on the BMP280/AHT20 lines and, when a sensor falsely decodes its address,
risking ACKs and clock-stretching that corrupt SD data in both directions. The
design drops future SD use entirely rather than carry that footgun.

### Why not share with the radio SPI or with UART0

Multiplexing I2C SDA with SPI MOSI (and I2C SCL with SPI SCK) sounds attractive
but is not robust: the I2C sensors hard-listen on SDA at all times, so arbitrary
radio MOSI transitions while SCK is high will, with certainty, occasionally cross
the I2C START pattern and desync the sensor state machine. Disabling the ESP32's
I2C peripheral does nothing to the sensors' input buffers. There is no
waveform-level guarantee that avoids this for arbitrary radio traffic.

Sharing one pin with the radio SPI bus is no better: NSS (GPIO 2) is pulsed by
the receiver task continuously for RSSI reads, MOSI/SCK are actively driven, and
MISO is acted on by the radio. Reusing any of them forces the receiver task to
suspend during every sensor read and adds a third client to a bus the backlog
already flags as contended (`receiver/docs/backlog.md:43-54`).

Reusing UART0 RX (GPIO 44) works electrically but loses a future serial-console
input. Reusing the radio RESET line (GPIO 14) works electrically but loses radio
soft-reset. The SD pin reuse is the only path that preserves every other hardware
feature.

## Prerequisite: pin-map fix in `receiver/platformio.ini`

The firmware's `RF_MODULE_*` map in `receiver/platformio.ini:48-56` does not
match the carrier. SPI (MISO/MOSI/SCK) matches. Every other pin is wrong, and
in a way that interacts with the S2 hardware change:

| `RF_MODULE_*` flag | Current value | Is the carrier's | Carrier uses it for |
|---|---|---|---|
| `CS`   | 40 | SDMMC DATA0 | new `I2C_SDA` |
| `RST`  | 39 | SDMMC CLK   | new `I2C_SCL` |
| `DIO0` | 38 | SDMMC CMD   | NC |
| `DIO1` | 47 | DIO2 line   | RFM69 DIO2 (data) |
| `DIO2` | 21 | DIO0 line   | RFM69 DIO0 |

With the S2 change applied, the current map drives RFM69 NSS onto the I2C SDA
line, drives the RFM69 reset pulse onto the I2C SCL line at boot, and never
drives the actual radio. The carrier's RFM69 is left undriven, and the BMP280
takes reset pulses as I2C clocks. The fix is a six-value edit:

```ini
'-DRF_MODULE_MISO=1'
'-DRF_MODULE_MOSI=42'
'-DRF_MODULE_SCK=41'
'-DRF_MODULE_CS=2'       ; was 40, carrier NSS is GPIO 2 (right 4)
'-DRF_MODULE_RST=14'     ; was 39, carrier RESET is GPIO 14 (left 19)
'-DRF_MODULE_DIO0=21'    ; was 38, carrier DIO0 is GPIO 21 (right 17)
'-DRF_MODULE_DIO1=RADIOLIB_NC'  ; was 47, carrier leaves DIO1 unwired
'-DRF_MODULE_DIO2=47'    ; was 21, carrier DIO2 (data) is GPIO 47 (right 16)
```

The comment on `platformio.ini:48` ("ESP32-S3-CAM") is mislabelled per
`receiver/docs/backlog.md:174-175` and is updated in the same edit.

## Carrier hardware changes

Edit `rtl433-carrier/board.py` (the authoritative SKiDL script), regenerate the
netlist and seeded PCB, and re-run DRC.

### New nets

- `I2C_SDA` on GPIO 40 (Freenove right pos 7)
- `I2C_SCL` on GPIO 39 (Freenove right pos 8)

GPIO 38 (CMD) gains no net and no socket. The existing 10 nets are unchanged.

### New components

- **J6** `PinSocket_1x01_P2.54mm_Vertical`, F.Cu, at Freenove right pos 7. Net
  `I2C_SDA`. Sits immediately above the existing J1 SPI block (right pos 3-6),
  on the same 2.54 mm grid.
- **J7** `PinSocket_1x01_P2.54mm_Vertical`, F.Cu, at Freenove right pos 8. Net
  `I2C_SCL`.
- **J8** `PinHeader_1x04_P2.54mm`, F.Cu, near the top edge of the carrier.
  Pinout `+3V3 | GND | I2C_SDA | I2C_SCL`. This is the off-board I2C header the
  BMP280 breakout plugs into. `+3V3` taps the J4 net; `GND` reaches the existing
  ground pour through a via. Placement away from the bottom edge avoids the
  USB-C cable zone and the radio/antenna keepouts on the back.
- **R3** 10 k 0603, `I2C_SCL` to `+3V3` (SDMMC CLK had no pull-up).
- **R4** 10 k 0603, `I2C_SDA` to `+3V3`, for symmetry and self-documenting pull-up
  placement near the new header. The Freenove's existing 10 k pull-up on DATA0
  stays in parallel, giving an effective SDA pull-up of about 5 k, safe at the
  100 kHz default and at 400 kHz.

R3 and R4 sit on the front, near J8, so the pull-ups live with the off-board
header rather than somewhere electrically convenient but visually obscure.

### What does not change on the carrier

All existing nets and components are unchanged. J1 (SPI), J2 (DIO0/DIO2), J3
(GND), J4 (+3V3), J5 (RESET), U1 (RFM69HCW), ANT1, R1, R2, C1, C2, C3 stay
exactly as they are. RFM69 pin 14 (DIO0) stays wired to GPIO 21; pin 15 (DIO1)
stays NC. No radio connection is rewired. The placement script's keepout and
ground-stitch logic is unchanged; the new components sit outside the antenna,
radio, and whip rule areas.

## Firmware

Implementation is in `receiver/`. The recording path reuses the existing
`signal_store::record()` API so the dashboard, aliasing, and SSE replay
machinery work without changes.

### I2C bus

`Wire.begin(40, 39)` in `setup()`, default 100 kHz. Move to 400 kHz only if a
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

Update `receiver/docs/architecture.md` to describe the I2C bus and the BMP280
recording path. Update `receiver/docs/backlog.md` to mark the "wired sensor"
item as delivered (this design) and to drop the future microSD mention. Update
the carrier README Pin map and `rtl433-carrier/docs/architecture.md` to record
the new `I2C_SDA` / `I2C_SCL` nets, J6/J7/J8, R3/R4, and the dropped microSD.

## Out of scope

- Reusing GPIO 21 (DIO0) as a freed pin for any other purpose. It stays wired to
  RFM69 DIO0 on the carrier.
- Adding the AHT20 in this change. The bus is sized for it; the driver is later.
- Replacing the receiver-task SPI race (`receiver/docs/backlog.md:43-54`). The
  BMP280 read shares no bus with the radio; the race is unchanged.
- Moving logging from UART0 to USB-CDC (`receiver/docs/backlog.md:150-159`).
  UART0 TX stays. That change is independent.
- Any pins on the back of the carrier or any change to the antenna, radio, or
  whip keepouts.

## Implementation outline

The detailed plan is produced by the writing-plans skill after the spec is
approved. The work splits at the repo boundary:

1. `rtl433-web-receiver/receiver`: the pin-map fix in `platformio.ini`. Land this
   first; without it, the carrier's RFM69 is undriven and the BMP280 lines are
   fought at boot.
2. `rtl433-carrier`: the hardware change in `board.py`, regenerate the netlist
   and seeded PCB, DRC clean.
3. `rtl433-web-receiver/receiver`: `Wire.begin(40, 39)`, BMP280 driver, recording
   through `signal_store::record()`, host tests, hardware self-test.
4. Documentation across both repos in the same commits as the code.

The carrier work happens in a separate worktree in the `rtl433-carrier` repo; the
firmware work happens in this worktree. The spec lives in `rtl433-web-receiver`
because the firmware work is the larger piece and the recording path is where
the design's runtime behavior is defined.
