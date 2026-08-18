#!/bin/sh
# topic.cpp and radio_health.cpp are the firmware modules with no Arduino
# dependency, so their rules are checked here rather than by compilation alone.
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
