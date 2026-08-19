#!/bin/sh
# topic.cpp, radio_health.cpp and device_hooks.cpp are the firmware modules
# with no Arduino dependency, so their rules are checked here rather than by
# compilation alone.
set -e
root=$(cd "$(dirname "$0")/../.." && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/topic_test" "$root/topic.cpp" "$root/test/host/topic_test.cpp"
"$out/topic_test"
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/radio_health_test" "$root/radio_health.cpp" "$root/test/host/radio_health_test.cpp"
"$out/radio_health_test"
g++ -std=c++17 -Wall -Wextra -Werror -I"$root" \
    -o "$out/device_hooks_test" "$root/device_hooks.cpp" "$root/test/host/device_hooks_test.cpp"
"$out/device_hooks_test"
