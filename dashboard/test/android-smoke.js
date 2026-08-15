// CDP smoke test for the Capacitor Android app.
// Assumes adb forward tcp:9222 localabstract:webview_devtools_remote is active.
import { chromium, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACURITE } from "./fixtures.js";

const require = createRequire(import.meta.url);
const { startServer: startBinding } = require("../../receiver/test/binding-server.js");

const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(HERE, "..", "dist", "index.html"), "utf8");

let src;
let browser;
let reversedPort = null;

try {
  src = await startBinding({ html, devices: [ACURITE] });
  const base = src.url.replace(/\/$/, "");
  reversedPort = new URL(src.url).port;

  // Let the Android device reach the mock source via the host's loopback.
  execFileSync("adb", ["reverse", `tcp:${reversedPort}`, `tcp:${reversedPort}`]);

  browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error("no CDP browser context");
  const page = context.pages()[0];
  if (!page) throw new Error("no CDP page");

  // Clear any persisted state from previous installs/runs.
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // The app should land on the Sources tab with no sources configured.
  await page.waitForSelector("#tab-sources[aria-selected='true']", { timeout: 15000 });
  await page.waitForSelector("#source-list li", { state: "detached", timeout: 5000 });

  // Add the mock source.
  await page.fill("#source-url", base);
  await page.click("#source-add");
  await page.waitForSelector("#source-list li", { timeout: 10000 });
  const sourceCount = await page.locator("#source-list li").count();
  if (sourceCount !== 1) throw new Error(`expected 1 source, got ${sourceCount}`);

  const dot = page.locator("#source-list li .dot");
  await expect(dot).toHaveAttribute("data-state", "live", { timeout: 10000 });

  // Receiver data should show in the device table.
  await page.click("#tab-devices");
  await page.waitForSelector("#devices tr[data-key]", { timeout: 10000 });
  const rows = await page.locator("#devices tr[data-key]:not(.vrow)").count();
  if (rows !== 1) throw new Error(`expected 1 device row, got ${rows}`);

  console.log("[android-smoke] CDP smoke test passed");
} finally {
  if (browser) await browser.close();
  if (src) await src.close();
  if (reversedPort) {
    try { execFileSync("adb", ["reverse", "--remove", `tcp:${reversedPort}`]); } catch {}
  }
}
