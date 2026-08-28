// Everything rtl_433 and the binding add around the actual sensor readings.
export const META = new Set(["model", "id", "channel", "protocol", "rssi", "duration",
                      "mic", "message_type", "sequence_num", "time", "count",
                      "build"]);

// rtl_433 flags rather than readings: useful, but not what a card is for.
export const STATUS_FIELDS = new Set(["battery_ok", "battery", "battery_low", "test", "tamper",
                               "status", "integrity", "alarm", "learn", "unknown"]);

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function readings(obj) {
  const out = {};
  if (obj) for (const k of Object.keys(obj)) if (!META.has(k)) out[k] = obj[k];
  return out;
}

// The Acurite 5n1 splits its readings across alternating message types, so keep
// what earlier messages reported instead of showing only the latest half.
export function mergeReadings(prev, obj) {
  return Object.assign({}, prev || {}, readings(obj))
}

export function ageText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60) + "s";
  return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
}

// rtl_433 puts the unit in the field name, so the name and the unit come apart
// here rather than from a table of every sensor.
const UNITS = [["_mi_h", "mi/h"], ["_km_h", "km/h"], ["_m_s", "m/s"], ["_hPa", "hPa"],
               ["_kPa", "kPa"], ["_in", "in"], ["_mm", "mm"], ["_F", "°F"],
               ["_C", "°C"], ["_V", "V"], ["_deg", "°"], ["_ppm", "ppm"],
               ["_dBm", "dBm"], ["_kB", "kB"]];

export function splitUnit(field) {
  for (const [suffix, unit] of UNITS) {
    if (field.length > suffix.length && field.endsWith(suffix)) {
      return { name: field.slice(0, -suffix.length).replace(/_/g, " "), unit: unit };
    }
  }
  if (field === "humidity") return { name: "humidity", unit: "%" };
  return { name: field.replace(/_/g, " "), unit: "" };
}

// rtl_433 sends full float precision; the card only needs enough to read at a glance.
export function fmtValue(v, decimals = 1) {
  if (typeof v !== "number") return String(v);
  return String(parseFloat(v.toFixed(decimals)));
}

// A radio stuck refusing OP_MODE writes reads at or below the SX1231's own
// measurement floor: see receiver/docs/architecture.md, "A refused OP_MODE
// write is not an SPI fault".
export const NOISE_FLOOR_DBM = -120;

export function isBadReading(field, raw) {
  if (field === "radio_ok") return raw === 0;
  if (field === "noise_dBm") return typeof raw === "number" && raw <= NOISE_FLOOR_DBM;
  return false;
}

// Unit groups that convert at display time, keyed on the display unit from splitUnit.
const GROUP_OF_UNIT = {
  "°F": "temperature", "°C": "temperature",
  "mm": "rain", "in": "rain",
  "mi/h": "wind", "km/h": "wind", "m/s": "wind",
  "hPa": "pressure", "kPa": "pressure",
};

// Maps group names to the key used in settings.custom.
const GROUP_SETTING_KEY = {
  temperature: "temp",
  rain: "rain",
  wind: "wind",
  pressure: "pressure",
};

// Every group converts through one canonical unit so any two units in the group
// compose. Settings name targets by the suffix-less labels from the spec.
const LABEL_UNIT = {
  temperature: { C: "°C", F: "°F" },
  rain: { mm: "mm", in: "in" },
  wind: { "km/h": "km/h", "mi/h": "mi/h", "m/s": "m/s" },
  pressure: { hPa: "hPa", kPa: "kPa" },
};

function toCanonical(group, unit, v) {
  switch (group) {
    case "temperature": return unit === "°F" ? (v - 32) * 5 / 9 : v;
    case "rain": return unit === "in" ? v * 25.4 : v;
    case "wind": return unit === "mi/h" ? v * 1.60934 : unit === "m/s" ? v * 3.6 : v;
    case "pressure": return unit === "kPa" ? v * 10 : v;
  }
  return v;
}

function fromCanonical(group, v, label) {
  switch (group) {
    case "temperature": return label === "F" ? v * 9 / 5 + 32 : v;
    case "rain": return label === "in" ? v / 25.4 : v;
    case "wind": return label === "mi/h" ? v / 1.60934 : label === "m/s" ? v / 3.6 : v;
    case "pressure": return label === "kPa" ? v / 10 : v;
  }
  return v;
}

export function displayValue(field, raw, settings) {
  const parts = splitUnit(field);
  const decimals = settings && Number.isInteger(settings.decimals) ? settings.decimals : 1;
  const group = typeof raw === "number" ? GROUP_OF_UNIT[parts.unit] : undefined;
  const settingKey = group ? GROUP_SETTING_KEY[group] : undefined;
  if (!group || !settings || !settings.custom || !settings.custom[settingKey]) {
    return { name: parts.name, num: fmtValue(raw, decimals), unit: parts.unit };
  }
  const label = settings.custom[settingKey];
  const num = fromCanonical(group, toCanonical(group, parts.unit, raw), label);
  return { name: parts.name, num: fmtValue(num, decimals), unit: LABEL_UNIT[group][label] || parts.unit };
}
