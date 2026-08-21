#!/bin/sh
# topic.cpp and radio_health.cpp are the firmware modules with no Arduino
# dependency, so their rules are checked here rather than by compilation alone.
# device_hooks.cpp includes ArduinoJson, fetched by PlatformIO into libdeps.
# signal_store.cpp and alias_store.cpp additionally reach into Arduino.h,
# ArduinoLog.h and (for alias_store) Preferences.h; arduino_shim/ provides
# just enough of each to host-compile and run their selfTest()s.
set -e
root=$(cd "$(dirname "$0")/../.." && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
# device_hooks.cpp compiles against the ArduinoJson headers in libdeps.
# Run 'pio run' once so the include path exists.
aj="$root/.pio/libdeps/esp32s3-generic/ArduinoJson/src"
if [ ! -d "$aj" ]; then
  echo "ArduinoJson headers not found at $aj" >&2
  echo "Run 'pio run' in receiver/ once to fetch dependencies." >&2
  exit 1
fi
shim="$root/test/host/arduino_shim"
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/topic_test" "$root/topic.cpp" "$root/test/host/topic_test.cpp"
"$out/topic_test" "$(dirname "$root")/test/topic_cases.txt"
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/radio_health_test" "$root/radio_health.cpp" "$root/test/host/radio_health_test.cpp"
"$out/radio_health_test"
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" -I"$aj" \
    -o "$out/device_hooks_test" "$root/device_hooks.cpp" "$root/test/host/device_hooks_test.cpp"
"$out/device_hooks_test"
g++ -std=c++17 -Wall -Wextra -Werror -DFAKE_SIGNALS -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 \
    -I"$shim" -I"$root" -I"$aj" \
    -o "$out/signal_store_test" "$root/signal_store.cpp" "$root/device_hooks.cpp" \
    "$root/test/host/signal_store_test.cpp"
"$out/signal_store_test"
g++ -std=c++17 -Wall -Wextra -Werror -DFAKE_SIGNALS -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 \
    -I"$shim" -I"$root" -I"$aj" \
    -o "$out/alias_store_test" "$root/alias_store.cpp" "$root/test/host/alias_store_test.cpp"
"$out/alias_store_test"
g++ -std=c++17 -Wall -Wextra -Werror -DFAKE_SIGNALS -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 \
    -I"$shim" -I"$root" \
    -o "$out/layout_store_test" "$root/layout_store.cpp" "$root/test/host/layout_store_test.cpp"
"$out/layout_store_test"
g++ -std=c++17 -Wall -Wextra -Werror -DFAKE_SIGNALS -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 \
    -I"$shim" -I"$root" \
    -o "$out/location_store_test" "$root/location_store.cpp" "$root/test/host/location_store_test.cpp"
"$out/location_store_test"
