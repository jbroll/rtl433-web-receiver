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

module.exports = { ACURITE, OREGON, THERMO, LONGNAME };
