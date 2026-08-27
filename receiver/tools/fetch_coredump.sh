#!/bin/sh
# Read and decode the receiver's coredump partition (offset/size from partitions.csv).
# Usage: tools/fetch_coredump.sh [serial-port]
set -e
port=${1:-/dev/ttyACM0}
here=$(cd "$(dirname "$0")" && pwd)
build="$here/../.pio/build/esp32s3-generic"
esptool=$HOME/.platformio/packages/tool-esptoolpy/esptool.py
espcoredump=$HOME/.platformio/penv/bin/esp-coredump

for f in "$esptool" "$espcoredump"; do
    if [ ! -e "$f" ]; then
        echo "missing: $f" >&2
        exit 1
    fi
done

partitions="$here/../partitions.csv"
line=$(grep '^coredump' "$partitions") || { echo "no coredump row in $partitions" >&2; exit 1; }
offset=$(echo "$line" | awk -F, '{gsub(/ /,"",$4); print $4}')
size=$(echo "$line" | awk -F, '{gsub(/ /,"",$5); print $5}')

# Prefer the ELF saved for the build currently checked out (tools/save_elf.py),
# since a later build can overwrite $build/firmware.elf before a dump is fetched.
build_id=$(git -C "$here/.." describe --always --dirty --exclude '*' 2>/dev/null || echo dev)
elf="$here/elf/$build_id.elf"
[ -f "$elf" ] || elf="$build/firmware.elf"
if [ ! -f "$elf" ]; then
    echo "missing: $elf" >&2
    exit 1
fi

# The esp32s3-generic-fakesignals environment builds to its own directory and
# is never saved to tools/elf/ (see platformio.ini), but an ELF saved before
# that separation, or one copied in by hand, could still carry FAKE_SIGNALS'
# symbols; symbolicating a real dump against it produces plausible wrong
# frames rather than an obvious failure.
command -v strings >/dev/null 2>&1 || { echo "missing: strings (binutils)" >&2; exit 1; }
if strings "$elf" 2>/dev/null | grep -q '^fakeSignal'; then
    echo "warning: $elf looks like a FAKE_SIGNALS build (has fakeSignal symbols)" >&2
    echo "it will not symbolicate a real coredump correctly; rebuild esp32s3-generic and retry" >&2
    exit 1
fi

"$esptool" --port "$port" --baud 921600 read_flash "$offset" "$size" "$here/core.bin"
"$espcoredump" info_corefile "$here/core.bin" --elf "$elf"
