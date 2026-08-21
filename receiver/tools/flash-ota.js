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

function readEnvToken() {
  if (process.env.OTA_TOKEN) return process.env.OTA_TOKEN;
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return null;
  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...rest] = line.split("=");
    if (key.trim() !== "OTA_TOKEN") continue;
    return rest.join("=").trim().replace(/^["']|["']$/g, "");
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

main();
