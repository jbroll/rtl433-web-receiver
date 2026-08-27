# Backlog

Work that spans sub-projects. Each sub-project's own backlog holds the rest.

## The receiver's C++ host suite runs in no CI job

`receiver/test/host/run.sh` compiles nine firmware modules against `test/host/arduino_shim/`
and runs their `selfTest()`s, then builds the firmware twice, once plain and once with
`FAKE_SIGNALS`. It is the only vehicle that runs firmware code, and nothing invokes it
outside a developer's machine. `.github/workflows/ios.yml` skips it because the GitHub
macOS runner has no ArduinoJson headers; `ci/android` skips it because the gpu host has no
`pio` on `PATH` and no `.pio/libdeps`. Giving either runner PlatformIO would close it, at
the cost of a first-run toolchain download.
