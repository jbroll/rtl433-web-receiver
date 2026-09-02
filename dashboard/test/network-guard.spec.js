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

  // The failure is reported in Settings rather than on the card, so that is
  // where a spec missing routeWeather() shows up.
  await page.locator("#tab-devices").click();
  await page.locator("#subtab-settings").click();
  const row = page.locator('#settings-feeds .feed[data-feed="weather"]');
  await expect(row).toHaveAttribute("data-status", "error");
  await expect(row.locator(".feed-err")).not.toBeEmpty();
});
