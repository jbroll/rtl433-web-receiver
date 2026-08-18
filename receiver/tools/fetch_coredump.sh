#!/bin/sh
# Read and decode the receiver's coredump partition (64 KiB at 0x3f0000).
# Usage: tools/fetch_coredump.sh [serial-port]
set -e
port=${1:-/dev/ttyACM0}
here=$(cd "$(dirname "$0")" && pwd)
build="$here/../.pio/build/esp32s3-generic"
esptool=$HOME/.platformio/packages/tool-esptoolpy/esptool.py
espcoredump=$HOME/.platformio/penv/bin/esp-coredump
"$esptool" --port "$port" --baud 921600 read_flash 0x3f0000 0x10000 "$here/core.bin"
"$espcoredump" info_corefile "$here/core.bin" --elf "$build/firmware.elf"
