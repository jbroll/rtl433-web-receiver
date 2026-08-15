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
export function fmtValue(v) {
  if (typeof v !== "number") return String(v);
  return String(parseFloat(v.toFixed(Math.abs(v) >= 10 ? 1 : 2)));
}
