#include <stdio.h>
#include <time.h>
#include <cmath>

#include "device_hooks.h"

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-64s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

static float rainToday(const char* key, const char* model, float rain_mm, bool has_rain = true) {
  device_hooks::Reading r;
  r.model = model;
  r.has_rain_mm = has_rain;
  r.rain_mm = rain_mm;
  r.has_rain_in = false;
  r.rain_in = 0;
  r.set_rain_today_mm = false;
  r.rain_today_mm = 0;
  device_hooks::dispatch(key, r);
  return r.set_rain_today_mm ? r.rain_today_mm : -1.0f;
}

int main() {
  device_hooks::begin();

  // A model with no registered hook is untouched.
  {
    device_hooks::Reading r;
    r.model = "Acurite-Tower";
    r.has_rain_mm = true;
    r.rain_mm = 5.0f;
    r.has_rain_in = false;
    r.rain_in = 0;
    r.set_rain_today_mm = false;
    r.rain_today_mm = 0;
    device_hooks::dispatch("src/Acurite-Tower/1", r);
    check("an unregistered model is untouched", !r.set_rain_today_mm);
  }

  // No rain_mm and no rain_in: untouched.
  {
    device_hooks::Reading r;
    r.model = "Acurite-5n1";
    r.has_rain_mm = false;
    r.rain_mm = 0;
    r.has_rain_in = false;
    r.rain_in = 0;
    r.set_rain_today_mm = false;
    r.rain_today_mm = 0;
    device_hooks::dispatch("src/Acurite-5n1/1", r);
    check("a rain model with no rain field is untouched", !r.set_rain_today_mm);
  }

  // First reading: baseline set, delta is 0.
  device_hooks::setNow(1700000000);  // 2023-11-14 UTC
  device_hooks::setTzOffset(-240);   // EDT
  check("first reading sets rain_today to 0",
        fabs(rainToday("src/Acurite-5n1/1", "Acurite-5n1", 10.0f) - 0.0f) < 0.01f);

  // Subsequent reading same day: delta accumulates.
  check("second reading same day shows the delta",
        fabs(rainToday("src/Acurite-5n1/1", "Acurite-5n1", 12.5f) - 2.5f) < 0.01f);

  // Day change: baseline resets, delta is 0.
  // 1700000000 + 86400 = 1700086400 (next UTC day). With -240 offset, local
  // day changes when UTC crosses midnight minus 4h, i.e. at 1700000000 + ...
  // Actually localDay = (utc + offset*60) / 86400. At t=1700000000, offset=-240:
  //   localDay = (1700000000 - 14400) / 86400 = 1699985600 / 86400 = 19675
  // At t=1700086400 ( +86400 ):
  //   localDay = (1700086400 - 14400) / 86400 = 1700072000 / 86400 = 19676
  device_hooks::setNow(1700086400);
  check("day change resets baseline to 0 delta",
        fabs(rainToday("src/Acurite-5n1/1", "Acurite-5n1", 15.0f) - 0.0f) < 0.01f);

  // Station power-cycle (counter drops below baseline): baseline resets.
  device_hooks::setNow(1700086400 + 60);
  check("counter roll resets baseline to 0 delta",
        fabs(rainToday("src/Acurite-5n1/1", "Acurite-5n1", 3.0f) - 0.0f) < 0.01f);

  // rain_in converted to mm when rain_mm absent.
  device_hooks::setNow(1700000000);
  device_hooks::setTzOffset(0);
  rainToday("src/Acurite-5n1/2", "Acurite-5n1", 0.0f, false);
  {
    device_hooks::Reading r;
    r.model = "Acurite-5n1";
    r.has_rain_mm = false;
    r.rain_mm = 0;
    r.has_rain_in = true;
    r.rain_in = 1.0f;  // 1 inch = 25.4 mm
    r.set_rain_today_mm = false;
    r.rain_today_mm = 0;
    device_hooks::dispatch("src/Acurite-5n1/2", r);
    check("first rain_in reading sets baseline (delta 0)",
          r.set_rain_today_mm && fabs(r.rain_today_mm - 0.0f) < 0.01f);
  }
  {
    device_hooks::Reading r;
    r.model = "Acurite-5n1";
    r.has_rain_mm = false;
    r.rain_mm = 0;
    r.has_rain_in = true;
    r.rain_in = 2.0f;  // 2 inches; delta = 1 inch = 25.4 mm
    r.set_rain_today_mm = false;
    r.rain_today_mm = 0;
    device_hooks::dispatch("src/Acurite-5n1/2", r);
    check("second rain_in reading shows 25.4 mm delta",
          r.set_rain_today_mm && fabs(r.rain_today_mm - 25.4f) < 0.1f);
  }

  // Clock unset (time < 1700000000): baseline tracks, no day reset.
  device_hooks::setNow(0);
  check("clock-unset first reading: delta 0",
        fabs(rainToday("src/Acurite-5n1/3", "Acurite-5n1", 100.0f) - 0.0f) < 0.01f);
  device_hooks::setNow(0);
  check("clock-unset second reading: delta accumulates",
        fabs(rainToday("src/Acurite-5n1/3", "Acurite-5n1", 105.0f) - 5.0f) < 0.01f);

  // TZ offset change moves the day boundary. At t=1700006400 (86400*19676),
  // offset 0 gives day 19676, but offset -240 gives day 19675: the -4h shift
  // puts local midnight 4 hours into the future, so UTC midnight is still
  // "yesterday" locally.
  device_hooks::setNow(1700006400);
  device_hooks::setTzOffset(-240);
  rainToday("src/Acurite-5n1/5", "Acurite-5n1", 10.0f);
  device_hooks::setNow(1700006400 + 60);
  device_hooks::setTzOffset(0);
  check("TZ offset change can cross a day boundary",
        fabs(rainToday("src/Acurite-5n1/5", "Acurite-5n1", 11.0f) - 0.0f) < 0.01f);

  printf("%d failures\n", failures);
  return failures ? 1 : 0;
}
