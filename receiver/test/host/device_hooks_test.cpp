#include <stdio.h>
#include <time.h>
#include <cmath>

#include <ArduinoJson.h>

#include "device_hooks.h"

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-64s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

static float rainToday(const char* key, const char* model, float rain_mm, bool has_rain = true) {
  JsonDocument doc;
  doc["model"] = model;
  if (has_rain) {
    doc["rain_mm"] = rain_mm;
  }
  device_hooks::dispatch(key, doc);
  return doc["rain_today_mm"].is<float>() ? doc["rain_today_mm"].as<float>() : -1.0f;
}

int main() {
  device_hooks::begin();

  // A model with no registered hook is untouched.
  {
    JsonDocument doc;
    doc["model"] = "Acurite-Tower";
    doc["rain_mm"] = 5.0f;
    device_hooks::dispatch("src/Acurite-Tower/1", doc);
    check("an unregistered model is untouched", !doc["rain_today_mm"].is<float>());
  }

  // A rain model with no rain field is untouched.
  {
    JsonDocument doc;
    doc["model"] = "Acurite-5n1";
    device_hooks::dispatch("src/Acurite-5n1/1", doc);
    check("a rain model with no rain field is untouched", !doc["rain_today_mm"].is<float>());
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
  // At t=1700000000, offset=-240: localDay = (1700000000-14400)/86400 = 19675.
  // At t=1700086400 (+86400): localDay = 19676.
  device_hooks::setNow(1700086400);
  check("day change resets baseline to 0 delta",
        fabs(rainToday("src/Acurite-5n1/1", "Acurite-5n1", 15.0f) - 0.0f) < 0.01f);

  // Station power-cycle (counter drops below baseline): baseline resets.
  device_hooks::setNow(1700086400 + 60);
  check("counter roll resets baseline to 0 delta",
        fabs(rainToday("src/Acurite-5n1/1", "Acurite-5n1", 3.0f) - 0.0f) < 0.01f);

  // Clock unset (time < 1700000000): baseline tracks, no day reset.
  device_hooks::setNow(0);
  check("clock-unset first reading: delta 0",
        fabs(rainToday("src/Acurite-5n1/3", "Acurite-5n1", 100.0f) - 0.0f) < 0.01f);
  device_hooks::setNow(0);
  check("clock-unset second reading: delta accumulates",
        fabs(rainToday("src/Acurite-5n1/3", "Acurite-5n1", 105.0f) - 5.0f) < 0.01f);

  // TZ offset change moves the day boundary. At t=1700006400 (86400*19676),
  // offset -240 gives day 19675 but offset 0 gives day 19676: shifting west 4
  // hours puts UTC midnight one local day earlier.
  device_hooks::setNow(1700006400);
  device_hooks::setTzOffset(-240);
  rainToday("src/Acurite-5n1/5", "Acurite-5n1", 10.0f);
  device_hooks::setNow(1700006400 + 60);
  device_hooks::setTzOffset(0);
  check("TZ offset change can cross a day boundary",
        fabs(rainToday("src/Acurite-5n1/5", "Acurite-5n1", 11.0f) - 0.0f) < 0.01f);

  // validate(): range checks on humidity, wind_dir_deg, pressure_hPa.
  {
    JsonDocument doc;
    doc["humidity"] = 50;
    check("humidity in range passes", device_hooks::validate(doc));
  }
  {
    JsonDocument doc;
    doc["humidity"] = 154;
    check("humidity out of range fails", !device_hooks::validate(doc));
  }
  {
    JsonDocument doc;
    doc["wind_dir_deg"] = 180;
    check("wind_dir_deg in range passes", device_hooks::validate(doc));
  }
  {
    JsonDocument doc;
    doc["wind_dir_deg"] = 458;
    check("wind_dir_deg out of range fails", !device_hooks::validate(doc));
  }
  {
    JsonDocument doc;
    doc["pressure_hPa"] = 1013;
    check("pressure_hPa in range passes", device_hooks::validate(doc));
  }
  {
    JsonDocument doc;
    doc["pressure_hPa"] = 650;
    check("a low absolute station pressure (e.g. a wired sensor at altitude) passes",
          device_hooks::validate(doc));
  }
  {
    JsonDocument doc;
    doc["pressure_hPa"] = 5768;
    check("pressure_hPa out of range fails", !device_hooks::validate(doc));
  }
  {
    JsonDocument doc;
    doc["model"] = "Acurite-Tower";
    doc["temperature_C"] = 21.5f;
    check("a payload with none of the checked fields passes",
          device_hooks::validate(doc));
  }
  {
    JsonDocument doc;
    doc["humidity"] = 50;
    doc["wind_dir_deg"] = 458;
    check("one out-of-range field among several fails",
          !device_hooks::validate(doc));
  }

  printf("%d failures\n", failures);
  return failures ? 1 : 0;
}
