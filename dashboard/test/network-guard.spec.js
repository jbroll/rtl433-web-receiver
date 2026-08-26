import { test, expect } from "./pw.js";
import { startServer, routeTiles } from "./harness.js";
import { ACURITE } from "./fixtures.js";

const CARD = '.card:not(.ghostcard)[data-key="local feed/Weather"]';

let server;
test.afterEach(async () => { if (server) await server.close(); server = null; });

test("a spec that forgets routeWeather() gets an error card, not a live answer", async ({ page }) => {
  await routeTiles(page);
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);

  await page.evaluate(() => setLocation({ lat: 40.015, lon: -105.2705, zone: "America/Denver" }));

  await expect(page.locator(`${CARD} .val[data-f="feed_error"] .fv`)).toBeVisible();
});
