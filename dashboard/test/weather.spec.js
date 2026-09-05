import { test, expect } from "./pw.js";
import { startServer, routeWeather, routeTiles, nwsJson, openSettings, closeSettings } from "./harness.js";
import { ACURITE } from "./fixtures.js";
import { OUTSIDE_US } from "./fixtures-nws.js";

const CARD = '.card:not(.ghostcard)[data-key="local feed/Weather"]';

let server;
let seen;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page, over) {
  seen = await routeWeather(page, over);
  await routeTiles(page);
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
}

async function setPlace(page, lat = 40.015, lon = -105.2705) {
  await page.evaluate(([la, lo]) => setLocation({ lat: la, lon: lo, zone: "America/Denver" }), [lat, lon]);
}

test("the weather card carries seven forecast days plus current conditions", async ({ page }) => {
  await open(page);
  await setPlace(page);
  await expect(page.locator(CARD)).toBeVisible();

  await expect(page.locator(`${CARD} .val[data-f="now"]`)).toHaveCount(1);
  for (let i = 0; i < 7; i++) {
    await expect(page.locator(`${CARD} .val[data-f="day${i}"]`)).toHaveCount(1);
  }
  await expect(page.locator(`${CARD} .val[data-f="day7"]`)).toHaveCount(0);
});

test("the observation station's identifier and distance show on the current-conditions cell", async ({ page }) => {
  await open(page);
  await setPlace(page);
  await expect(page.locator(CARD)).toBeVisible();

  const station = page.locator(`${CARD} .val[data-f="now"] .csub.station`);
  await expect(station).toHaveText("KBDU · 6 km");

  await openSettings(page);
  await page.locator("#subtab-settings").click();
  await page.locator("#settings-units").selectOption("imperial");
  await closeSettings(page);

  await expect(station).toHaveText("KBDU · 4 mi");
});

test("the point and station lookups happen once, the forecast every refresh", async ({ page }) => {
  await open(page);
  await setPlace(page);
  await expect(page.locator(CARD)).toBeVisible();

  expect(seen.filter(p => p.startsWith("/points/"))).toHaveLength(1);
  expect(seen.filter(p => p.endsWith("/stations"))).toHaveLength(1);
  expect(seen.filter(p => p.endsWith("/forecast"))).toHaveLength(1);
  expect(seen.filter(p => p.endsWith("/observations/latest"))).toHaveLength(1);
});

test("a reload paints from cache without touching weather.gov", async ({ page }) => {
  await open(page);
  await setPlace(page);
  await expect(page.locator(CARD)).toBeVisible();

  await page.reload();
  seen.length = 0;
  await expect(page.locator("#status")).toHaveText(/^live/);
  await expect(page.locator(CARD)).toBeVisible();
  await page.waitForTimeout(1500);
  expect(seen, "a reload refetched inside the interval").toHaveLength(0);
});

test("observations arrive as readings the unit setting converts", async ({ page }) => {
  await open(page);
  await setPlace(page);
  await expect(page.locator(CARD)).toBeVisible();

  const c = page.locator(`${CARD} .val[data-f="temperature_C"]`);
  await expect(c.locator(".fv")).toHaveText("20");
  await expect(c.locator(".fn .u")).toHaveText("°C");

  await openSettings(page);
  await page.locator("#subtab-settings").click();
  await page.locator("#settings-units").selectOption("imperial");
  await closeSettings(page);

  await expect(c.locator(".fv")).toHaveText("68");
  await expect(c.locator(".fn .u")).toHaveText("°F");
});

test("a location outside the united states says so and stops asking", async ({ page }) => {
  await open(page, { "/points/51.5074,-0.1278": nwsJson(OUTSIDE_US, 404) });
  await setPlace(page, 51.5074, -0.1278);

  await expect(page.locator(`${CARD} .val`)).toContainText(/United States only/);
  const after = seen.length;
  await page.waitForTimeout(2500);
  expect(seen.length, "kept retrying a permanent 404").toBe(after);
});

test("a server error keeps the last good forecast on the card", async ({ page }) => {
  await open(page);
  await setPlace(page);
  await expect(page.locator(`${CARD} .val[data-f="day0"]`)).toHaveCount(1);

  await page.unroute("**/api.weather.gov/**");
  await routeWeather(page, {});
  await page.route("**/api.weather.gov/**/forecast", r => r.fulfill(nwsJson({}, 500)));

  await page.evaluate(() => expireFeeds());
  await page.waitForTimeout(1500);

  await expect(page.locator(`${CARD} .val[data-f="day0"]`)).toHaveCount(1);
  // The failure belongs in Settings, not on the card a reader cannot dismiss.
  await expect(page.locator(`${CARD} .val[data-f="feed_error"]`)).toHaveCount(0);

  await openSettings(page);
  await page.locator("#subtab-settings").click();
  const row = page.locator('#settings-feeds .feed[data-feed="weather"]');
  await expect(row).toHaveAttribute("data-status", "error");
  await expect(row.locator(".feed-err")).toContainText("500");
});

test("moving the location refetches against the new point", async ({ page }) => {
  await open(page);
  await setPlace(page);
  await expect(page.locator(CARD)).toBeVisible();

  seen.length = 0;
  await setPlace(page, 39.7392, -104.9903);
  await expect.poll(() => seen.filter(p => p.startsWith("/points/")).length).toBe(1);
  expect(seen.some(p => p === "/points/39.7392,-104.9903")).toBe(true);
});

test("a forecast day's glyph and temperatures fill the row without clipping", async ({ page }) => {
  await open(page);
  await setPlace(page);
  await expect(page.locator(`${CARD} .val[data-f="day0"]`)).toHaveCount(1);
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.evaluate(() => {
    setGrid("cols", 4);
    setGrid("rows", 3);
    setCardSize("local feed/Weather", 2, 2);
    saveCardState();
  });
  await expect.poll(() => page.locator(`${CARD} .val[data-f="day0"]`)
    .evaluate(c => c.clientWidth)).toBeGreaterThan(200);

  const fit = await page.locator(`${CARD} .val[data-f="day0"] .wx`).evaluate(row => {
    let used = 0, tall = 0;
    for (const part of row.children) {
      const r = part.getBoundingClientRect();
      used += r.width;
      tall = Math.max(tall, r.height);
    }
    return { w: used / row.clientWidth, h: tall / row.clientHeight,
             clipped: Math.max(row.scrollWidth - row.clientWidth,
                               row.scrollHeight - row.clientHeight) };
  });

  expect(fit.clipped).toBe(0);
  expect(Math.max(fit.w, fit.h)).toBeGreaterThan(0.8);
});
