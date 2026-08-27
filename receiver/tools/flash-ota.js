#!/usr/bin/env node
// Push a firmware image to a running receiver over OTA (POST /$update).
// See docs/user-manual.md for the endpoint's auth and failure-mode contract.
//
// Usage: npx flash-ota <host> [firmware-path]  (run from receiver/)
//   host           mDNS name (rtl433-xxxxxx.local) or IP of the device
//   firmware-path  defaults to .pio/build/esp32s3-generic/firmware.bin
//
// The token comes from OTA_TOKEN in the environment, or from receiver/.env.

const fs = require("fs");
const path = require("path");

// Port of Python's shlex.split(value, comments=False) in posix mode, matched
// token-for-token against load_env.py so the two parsers must agree — change
// them together.
function shlexSplit(s) {
  const tokens = [];
  let token = null;
  let state = " "; // " " = between tokens, "a" = in word, '"'/"'" = in quote, "\\" = escaping
  let quoteState = null; // the quote char we're escaping inside of, if any
  const escape = "\\";
  const quotes = "'\"";

  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s[i] : null;
    if (state === " ") {
      if (c === null) break;
      if (/\s/.test(c)) continue;
      if (c === escape) {
        state = escape;
        quoteState = "a";
      } else if (quotes.includes(c)) {
        state = c;
        token = token ?? "";
      } else {
        token = c;
        state = "a";
      }
    } else if (state === "'" || state === '"') {
      if (c === null) break; // unterminated quote: take what we have (diverges from Python's error)
      if (c === state) {
        state = "a";
      } else if (c === escape && state === '"') {
        state = escape;
        quoteState = '"';
      } else {
        token += c;
      }
    } else if (state === escape) {
      if (c === null) break;
      if (quoteState === '"' && c !== "\\" && c !== '"') token += "\\";
      token += c;
      state = quoteState;
    } else if (state === "a") {
      if (c === null) {
        tokens.push(token);
        token = null;
        break;
      }
      if (/\s/.test(c)) {
        tokens.push(token);
        token = null;
        state = " ";
      } else if (c === escape) {
        state = escape;
        quoteState = "a";
      } else if (quotes.includes(c)) {
        state = c;
      } else {
        token += c;
      }
    }
  }
  if (token !== null) tokens.push(token);
  return tokens;
}

function readEnvToken() {
  if (process.env.OTA_TOKEN) return process.env.OTA_TOKEN;
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return null;
  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    if (line.startsWith("export ")) line = line.slice(7);
    const [key, ...rest] = line.split("=");
    if (key.trim() !== "OTA_TOKEN") continue;
    const value = shlexSplit(rest.join("=")).join(" ");
    return value || null;
  }
  return null;
}

async function main() {
  const [host, firmwareArg] = process.argv.slice(2);
  if (!host) {
    console.error("usage: npx flash-ota <host> [firmware-path]");
    process.exit(2);
  }

  const token = readEnvToken();
  if (!token) {
    console.error("no OTA_TOKEN in the environment or receiver/.env");
    process.exit(2);
  }

  const firmwarePath =
    firmwareArg || path.join(__dirname, "..", ".pio", "build", "esp32s3-generic", "firmware.bin");
  if (!fs.existsSync(firmwarePath)) {
    console.error(`firmware not found: ${firmwarePath} (run "pio run" first)`);
    process.exit(2);
  }

  const bytes = fs.readFileSync(firmwarePath);
  const form = new FormData();
  form.append("firmware", new Blob([bytes]), path.basename(firmwarePath));

  const url = `http://${host}/$update`;
  console.log(`POST ${url} (${bytes.length} bytes)`);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await res.text();
  console.log(`${res.status} ${body}`);
  if (res.status !== 200) process.exit(1);
  console.log("device is rebooting into the new firmware");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
