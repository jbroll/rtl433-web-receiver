# Coredump fetch and decode

When the ESP32-S3 crashes it writes a core dump to flash before resetting. The
coredump partition is 64 KiB at address `0xFF0000` (`receiver/partitions.csv`).

On the USB console the boot log prints `Found core dump N bytes in flash` if a
coredump is present. The `coredump_pending` telemetry field is set to `true`
while a dump is waiting to be collected.

## Fetch and decode

Connect the serial port and run:

    ./tools/fetch_coredump.sh /dev/ttyACM0

A second argument names the PlatformIO environment the board was built from,
defaulting to `rfm69-433`; pass `sx1276-915` for the 915 MHz board.

The script reads the coredump partition (offset and size from
`receiver/partitions.csv`) into `core.bin` and decodes it against the ELF saved
for the currently checked-out build
(`receiver/tools/elf/$BUILD_ID-$PIOENV.elf`, written by the `save_elf.py`
post-build hook), falling back to `receiver/.pio/build/$PIOENV/firmware.elf` if
that ELF isn't there. ELFs saved before the environment suffix existed are all
`rfm69-433` builds and are still found under their old name.

The tools used are:

- esptool (`tool-esptoolpy`) to read flash
- esp-coredump (`esp_coredump` Python package in PlatformIO's penv) to decode

On this machine the tools live at:

- `$HOME/.platformio/packages/tool-esptoolpy/esptool.py`
- `$HOME/.platformio/penv/bin/esp-coredump`
- `$HOME/.platformio/packages/toolchain-xtensa-esp32s3/bin/xtensa-esp32s3-elf-gdb`

## Interactive debugging

To open an interactive GDB session with the core dump:

    xtensa-esp32s3-elf-gdb -ex "corefile core.bin" receiver/.pio/build/rfm69-433/firmware.elf

Replace the GDB and ELF paths above as needed for your platform.
