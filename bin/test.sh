#!/bin/sh
# Runs every sub-project's test suite, in order, stopping at the first
# failure. Each suite still runs standalone from its own directory; this is
# the one command that runs all of them.
#
# `pio test` is not included: it has no PlatformIO `native` environment yet
# (see receiver/docs/backlog.md), so it tries to build and flash
# esp32s3-generic and errors without a connected board.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)

echo "== receiver: test/host/run.sh =="
(cd "$root/receiver" && bash test/host/run.sh)

echo "== receiver: npm test =="
(cd "$root/receiver" && npm test)

echo "== bridge: npm test =="
(cd "$root/bridge" && npm test)

echo "== dashboard: npm test =="
(cd "$root/dashboard" && npm test)

echo "all suites passed"
