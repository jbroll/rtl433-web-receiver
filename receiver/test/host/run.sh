#!/bin/sh
# topic.cpp and radio_health.cpp are the firmware modules with no Arduino
# dependency, so their rules are checked here rather than by compilation alone.
# device_hooks.cpp includes ArduinoJson, fetched by PlatformIO into libdeps.
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
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/topic_test" "$root/topic.cpp" "$root/test/host/topic_test.cpp"
"$out/topic_test" "$(dirname "$root")/test/topic_cases.txt"
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/radio_health_test" "$root/radio_health.cpp" "$root/test/host/radio_health_test.cpp"
"$out/radio_health_test"
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" -I"$aj" \
    -o "$out/device_hooks_test" "$root/device_hooks.cpp" "$root/test/host/device_hooks_test.cpp"
"$out/device_hooks_test"
