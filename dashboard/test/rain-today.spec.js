import { test, expect } from "./pw.js";
import { startServer, routeWeather } from "./harness.js";
import { ACURITE } from "./fixtures.js";

const RAIN = { ...ACURITE, message_type: 1, rain_mm: 0.5 };

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page) {
  await routeWeather(page);
  server = await startServer({ devices: [RAIN] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
}

test("setting a location POSTs the GMT offset to /$tz", async ({ page }) => {
  await open(page);

  await page.evaluate(() => {
    setLocation({ lat: 40.015, lon: -105.2705, zone: "America/Denver" });
  });

  // setLocation's POST is fire-and-forget, so wait for it to land rather than
  // reading the server's state the instant evaluate() returns.
  await expect.poll(() => server.tzOffset()).not.toBe(-240);
  // Denver is -6:00 (MDT) or -7:00 (MST); accept either since DST depends on date.
  expect([-360, -420]).toContain(server.tzOffset());
});

test("clearing a location does not POST", async ({ page }) => {
  await open(page);

  await page.evaluate(() => {
    setLocation({ lat: 40.015, lon: -105.2705, zone: "America/Denver" });
  });
  await expect.poll(() => server.tzOffset()).not.toBe(-240);
  const offsetBefore = server.tzOffset();

  await page.evaluate(() => {
    clearLocation();
  });
  await page.waitForTimeout(300);
  expect(server.tzOffset()).toBe(offsetBefore);
});
