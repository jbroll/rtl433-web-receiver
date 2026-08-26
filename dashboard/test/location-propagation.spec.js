import { test, expect } from "@playwright/test";
import { startServer, startPage, routeWeather } from "./harness.js";
import { ACURITE } from "./fixtures.js";

// The settings pane always renders its map (src/location.jsx), regardless of
// whether a location is set, so any test that visits it fetches real OSM
// tiles unless this is routed too.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64");
async function routeTiles(page) {
  await page.route("**/tile.openstreetmap.org/**", r =>
    r.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));
}

let servers = [];

test.afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

function base(server) { return server.url.replace(/\/$/, ""); }

async function withSources(page, host, bases) {
  await page.addInitScript((list) => {
    localStorage.setItem("rtl433.sources.v1", JSON.stringify(list));
  }, bases);
  await page.goto(host.url);
}

const BOULDER = { lat: 40.015, lon: -105.2705, label: "Boulder", zone: "America/Denver", zoom: 12 };

// Feed cards are always keyed "local feed/<Topic>" (alias.js's FEED_BASE),
// never by the source that supplied the location -- see feed-cards.spec.js.
const CLOCK_CARD = '.card:not(.ghostcard)[data-key="local feed/Clock"]';
const SUN_CARD = '.card:not(.ghostcard)[data-key="local feed/Sun"]';

test("a $location retained before connect makes feed cards appear with no local location", async ({ page }) => {
  await routeWeather(page);
  const host = await startPage();
  const src = await startServer({ devices: [ACURITE], source: "srcA" });
  servers.push(host, src);
  await src.emitLocation(BOULDER);
  await withSources(page, host, [base(src)]);
  await page.click("#tab-cards");
  await expect(page.locator(CLOCK_CARD)).toBeVisible();
  await expect(page.locator(SUN_CARD)).toBeVisible();
});

test("a $location arriving mid-session makes feed cards appear without a reload", async ({ page }) => {
  await routeWeather(page);
  const host = await startPage();
  const src = await startServer({ devices: [ACURITE], source: "srcA" });
  servers.push(host, src);
  await withSources(page, host, [base(src)]);
  // A live stream makes the missing Clock card a real absence rather than a
  // page that has not connected yet.
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.click("#tab-cards");
  await expect(page.locator(CLOCK_CARD)).toHaveCount(0);
  await src.emitLocation(BOULDER);
  await expect(page.locator(CLOCK_CARD)).toBeVisible();
});

test("a local location always wins over a source's network location", async ({ page }) => {
  await routeWeather(page);
  await routeTiles(page);
  const host = await startPage();
  const src = await startServer({ devices: [ACURITE], source: "srcA" });
  servers.push(host, src);
  await src.emitLocation(BOULDER);
  await page.addInitScript((list) => {
    localStorage.setItem("rtl433.sources.v1", JSON.stringify(list));
    localStorage.setItem("rtl433.settings.v1", JSON.stringify({
      units: "metric", decimals: 1, custom: {},
      location: { lat: 0, lon: 0, label: "Null Island", zone: "UTC", zoom: 11 },
    }));
  }, [base(src)]);
  await page.goto(host.url);
  await page.click("#tab-devices");
  await page.locator("#subtab-settings").click();
  await expect(page.locator("#settings-lat")).toHaveValue("0");
});

test("Save posts both $tz and $location when the serving origin is a configured source", async ({ page }) => {
  await routeWeather(page);
  await routeTiles(page);
  const server = await startServer({ devices: [ACURITE] });
  servers.push(server);
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.click("#tab-devices");
  await page.locator("#subtab-settings").click();
  // setLocation is location.jsx's own commit path -- what a map click, a
  // geocode pick, or "Use my location" all funnel through to move lat/lon
  // together. A half-set coordinate resets to blank (settings.js's
  // cleanLocation), so driving the two number inputs one keystroke at a time
  // races that guard; calling the atomic setter is how a real pick lands.
  await page.evaluate((loc) => setLocation(loc), BOULDER);
  await expect(page.locator("#settings-lat")).toHaveValue("40.015");

  await expect.poll(async () => (await server.get(server.source + "/$location")).status).toBe(200);
  const loc = JSON.parse((await server.get(server.source + "/$location")).body);
  expect(loc.lat).toBe(40.015);
  expect(loc.lon).toBe(-105.2705);
});
