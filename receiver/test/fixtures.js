const ACURITE = {
  model: "Acurite-5n1", id: 396, channel: "A", protocol: 40,
  sequence_num: 0, battery_ok: 1, wind_avg_mi_h: 4.6,
  temperature_F: 71.2, humidity: 38, mic: "CHECKSUM",
};

const OREGON = {
  model: "Oregon-THN132N", id: 23, channel: 1, protocol: 12,
  battery_ok: 1, temperature_C: 19.4, mic: "CRC",
};

const THERMO = {
  model: "Fineoffset-WH2", id: 174, protocol: 55,
  battery_ok: 0, temperature_C: 4.1, humidity: 91, mic: "CRC",
};

// A long model name and full rtl_433 float precision, for the card overflow
// and rounding tests.
const LONGNAME = {
  model: "Fineoffset-WH65B-AggregateWeatherStationLongModelName", id: 174, channel: 3, protocol: 55,
  battery_ok: 1, temperature_F: 71.23456789, humidity: 38, wind_avg_mi_h: 4.6,
  wind_max_mi_h: 9.123456, wind_direction_deg: 180.5, rain_mm: 0.0300,
  pressure_hPa: 1013.25, mic: "CHECKSUM",
};

// rtl_433 reports temperatures below zero; fmtValue branches on Math.abs.
const FREEZER = {
  model: "Fineoffset-WH51", id: 88, channel: 2, protocol: 55,
  battery_ok: 1, temperature_C: -12.345, temperature_F: -4.5678, humidity: 71, mic: "CRC",
};

// What the firmware records about itself, keyed on the model alone.
const RECEIVER = {
  model: "Receiver", build: "test", temperature_C: 47.2, radio_C: 31,
  radio_ok: 1, noise_dBm: -104, heap_kB: 177, decodes: 42, drops: 3,
};

const ACURITE_WIND = {
  model: "Acurite-5n1", id: 396, channel: "A", protocol: 40,
  message_type: 0, battery_ok: 1,
  wind_avg_mi_h: 4.6, wind_max_mi_h: 9.1,
  mic: "CHECKSUM",
};

const ACURITE_RAIN = {
  model: "Acurite-5n1", id: 396, channel: "A", protocol: 40,
  message_type: 1, battery_ok: 1,
  rain_mm: 0.5,
  mic: "CHECKSUM",
};

const SOURCE = "rtl433-test";

// The same rule as signal_store::buildKey(): id, then channel, then 0.
function topicOf(payload, source) {
  const id = payload.id !== undefined ? payload.id
           : payload.channel !== undefined ? payload.channel : 0;
  return (source || SOURCE) + "/" + payload.model + "/" + id;
}

// Keep this a literal object, not built up by assignment or a loop:
// dashboard/test/fixtures.js re-exports this CommonJS module via `export *`,
// which only works because cjs-module-lexer can read named exports out of a
// literal `module.exports = { ... }` shape.
module.exports = { ACURITE, ACURITE_WIND, ACURITE_RAIN, OREGON, THERMO, LONGNAME, FREEZER, RECEIVER, SOURCE, topicOf };
