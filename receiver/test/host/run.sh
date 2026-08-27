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
# The firmware's ARDUINOJSON_POOL_CAPACITY override (platformio.ini) and
# ARDUINOJSON_SIZEOF_POINTER=4 (the host is 64-bit; the target is 32-bit, and
# ArduinoJson's slot size depends on it) keep every ArduinoJson-using host
# test's pool arithmetic the same as the firmware's.
ajflags="-DARDUINOJSON_SIZEOF_POINTER=4 -DARDUINOJSON_POOL_CAPACITY=16"
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/topic_test" "$root/topic.cpp" "$root/test/host/topic_test.cpp"
"$out/topic_test" "$(dirname "$root")/test/topic_cases.txt"
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/radio_health_test" "$root/radio_health.cpp" "$root/test/host/radio_health_test.cpp"
"$out/radio_health_test"
g++ -std=c++17 -Wall -Wextra -Werror $ajflags -I"$root" -I"$aj" \
    -o "$out/device_hooks_test" "$root/device_hooks.cpp" "$root/test/host/device_hooks_test.cpp"
"$out/device_hooks_test"
g++ -std=c++17 -Wall -Wextra -Werror -DFAKE_SIGNALS -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 $ajflags \
    -I"$shim" -I"$root" -I"$aj" \
    -o "$out/signal_store_test" "$root/signal_store.cpp" "$root/device_hooks.cpp" \
    "$root/test/host/signal_store_test.cpp"
"$out/signal_store_test"
g++ -std=c++17 -Wall -Wextra -Werror -DFAKE_SIGNALS -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 $ajflags \
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
g++ -std=c++17 -Wall -Wextra -Werror -DFAKE_SIGNALS -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 \
    -I"$shim" -I"$root" \
    -o "$out/units_store_test" "$root/units_store.cpp" "$root/test/host/units_store_test.cpp"
"$out/units_store_test"
# tz_store.cpp has no FAKE_SIGNALS selfTest; this drives its public API
# (begin/offsetMinutes/set) directly, same shape as topic_test/radio_health_test.
g++ -std=c++17 -Wall -Wextra -Werror -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 $ajflags \
    -I"$shim" -I"$root" -I"$aj" \
    -o "$out/tz_store_test" "$root/tz_store.cpp" "$root/device_hooks.cpp" \
    "$root/test/host/tz_store_test.cpp"
"$out/tz_store_test"
# MQTT_BROKER_URL exercises add()'s rejection of the build-flag broker's own url.
g++ -std=c++17 -Wall -Wextra -Werror -DFAKE_SIGNALS -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 $ajflags \
    -DMQTT_BROKER_URL='"mqtt://buildflag.example:1883"' \
    -I"$shim" -I"$root" -I"$aj" \
    -o "$out/mqtt_publish_store_test" "$root/mqtt_publish_store.cpp" "$root/test/host/mqtt_publish_store_test.cpp"
"$out/mqtt_publish_store_test"
# Same build-flag broker as above, so scenario (f) can fill _conn[] exactly.
g++ -std=c++17 -Wall -Wextra -Werror -DFAKE_SIGNALS -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 $ajflags \
    -DMQTT_BROKER_URL='"mqtt://buildflag.example:1883"' -DMQTT_MAX_PACKET_SIZE=5300 \
    -I"$shim" -I"$root" -I"$aj" \
    -o "$out/mqtt_publish_test" "$root/mqtt_publish.cpp" "$root/mqtt_publish_store.cpp" \
    "$root/json_string.cpp" "$root/signal_store.cpp" "$root/device_hooks.cpp" \
    "$root/alias_store.cpp" "$root/layout_store.cpp" "$root/location_store.cpp" \
    "$root/units_store.cpp" "$root/tz_store.cpp" \
    "$root/test/host/mqtt_publish_test.cpp"
"$out/mqtt_publish_test"
# frame.h is header-only: no Arduino headers beyond Print, so no shim -I needed
# for anything but Print.h itself.
g++ -std=c++17 -Wall -Wextra -Werror -I"$shim" -I"$root" \
    -o "$out/frame_test" "$root/test/host/frame_test.cpp"
"$out/frame_test"
