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

module.exports = { ACURITE, OREGON, THERMO };
