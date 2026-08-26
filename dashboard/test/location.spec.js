import { test, expect } from "./pw.js";
import { startServer, routeTiles } from "./harness.js";
import { ACURITE } from "./fixtures.js";

const NOMINATIM = "**/nominatim.openstreetmap.org/**";
const TILES = "**/tile.openstreetmap.org/**";

// A 1x1 transparent png, so no tile request ever leaves the machine.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64");
const BOULDER = [
  { lat: "40.0149856", lon: "-105.2705456", display_name: "Boulder, Boulder County, Colorado, United States" },
  { lat: "39.9944", lon: "-105.1731", display_name: "Boulder County, Colorado, United States" },
];

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page, route = BOULDER) {
  await routeTiles(page);
  await page.route(NOMINATIM, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(route) }));
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.locator("#tab-devices").click();
  await page.locator("#subtab-settings").click();
  await expect(page.locator("#settings-location")).toBeVisible();
}

test("no location is set on first load", async ({ page }) => {
  await open(page);
  await expect(page.locator("#settings-location-status")).toHaveText("No location set");
  await expect(page.locator("#settings-lat")).toHaveValue("");
  await expect(page.locator("#settings-lon")).toHaveValue("");
});

test("searching a place and picking a result sets the coordinates", async ({ page }) => {
  await open(page);
  await page.locator("#settings-place").fill("boulder");
  await page.locator("#settings-place-go").click();

  const results = page.locator("#settings-place-results li");
  await expect(results).toHaveCount(2);
  await results.first().locator("button").click();

  await expect(page.locator("#settings-lat")).toHaveValue("40.0149856");
  await expect(page.locator("#settings-lon")).toHaveValue("-105.2705456");
  await expect(page.locator("#settings-location-status"))
    .toHaveText("Boulder, Boulder County, Colorado, United States");
  await expect(page.locator("#settings-place-results")).toHaveCount(0);
});

test("Enter in the place box searches, and no request goes out before that", async ({ page }) => {
  const seen = [];
  await page.route(NOMINATIM, r => {
    seen.push(r.request().url());
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BOULDER) });
  });
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.locator("#tab-devices").click();
  await page.locator("#subtab-settings").click();

  await page.locator("#settings-place").pressSequentially("boulder");
  expect(seen).toHaveLength(0);

  await page.locator("#settings-place").press("Enter");
  await expect(page.locator("#settings-place-results li")).toHaveCount(2);
  expect(seen).toHaveLength(1);
});

test("a search that finds nothing says so", async ({ page }) => {
  await open(page, []);
  await page.locator("#settings-place").fill("nowhere at all");
  await page.locator("#settings-place-go").click();
  await expect(page.locator("#settings-location-status")).toHaveText("Nothing found");
});

test("a coordinate outside its range is refused", async ({ page }) => {
  await open(page);
  await page.locator("#settings-lat").fill("91");
  await page.locator("#settings-lon").fill("0");
  await page.locator("#settings-lon").blur();
  await expect(page.locator("#settings-location-status")).toHaveText("No location set");
});

test("a location survives a reload", async ({ page }) => {
  await open(page);
  await page.locator("#settings-place").fill("boulder");
  await page.locator("#settings-place-go").click();
  await page.locator("#settings-place-results li").first().locator("button").click();
  await expect(page.locator("#settings-lat")).toHaveValue("40.0149856");

  await page.reload();
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.locator("#tab-devices").click();
  await page.locator("#subtab-settings").click();
  await expect(page.locator("#settings-lat")).toHaveValue("40.0149856");
  await expect(page.locator("#settings-location-status"))
    .toHaveText("Boulder, Boulder County, Colorado, United States");
});

test("clearing a location empties the coordinates", async ({ page }) => {
  await open(page);
  await page.locator("#settings-place").fill("boulder");
  await page.locator("#settings-place-go").click();
  await page.locator("#settings-place-results li").first().locator("button").click();
  await expect(page.locator("#settings-location-clear")).toBeVisible();

  await page.locator("#settings-location-clear").click();
  await expect(page.locator("#settings-location-status")).toHaveText("No location set");
  await expect(page.locator("#settings-lat")).toHaveValue("");
});

// The button is guarded on isSecureContext because the firmware serves the
// page over plain http on a LAN address, where the browser refuses the
// request. That branch cannot be exercised here: the harness serves on
// 127.0.0.1, which counts as secure. What is checkable is that the button
// appears and works when the context does allow it.
test("the geolocate button fills in the browser's coordinates", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 40.015, longitude: -105.2705 });
  await open(page);

  expect(await page.evaluate(() => isSecureContext)).toBe(true);
  await page.locator("#settings-geolocate").click();

  await expect(page.locator("#settings-lat")).toHaveValue("40.015");
  await expect(page.locator("#settings-lon")).toHaveValue("-105.2705");
});

test("the map is drawn from OpenStreetMap tiles and credits them", async ({ page }) => {
  const tiles = [];
  await page.route(TILES, r => {
    tiles.push(r.request().url());
    return r.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
  });
  await page.route(NOMINATIM, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BOULDER) }));
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.locator("#tab-devices").click();
  await page.locator("#subtab-settings").click();

  await expect(page.locator("#settings-map")).toBeVisible();
  await expect.poll(() => tiles.length).toBeGreaterThan(0);
  expect(tiles[0]).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
  await expect(page.locator("#settings-map")).toContainText("OpenStreetMap");
  await expect(page.locator("#settings-map")).not.toContainText("Pigeon");
});

test("picking a search result drops a pin on the map", async ({ page }) => {
  await open(page);
  expect(await page.locator("#settings-map svg").count()).toBe(0);

  await page.locator("#settings-place").fill("boulder");
  await page.locator("#settings-place-go").click();
  await page.locator("#settings-place-results li").first().locator("button").click();

  await expect(page.locator("#settings-lat")).toHaveValue("40.0149856");
  expect(await page.locator("#settings-map svg").count()).toBeGreaterThan(0);
});

test("changing only the zoom issues no further $location POST", async ({ page }) => {
  await open(page);
  await page.locator("#settings-place").fill("boulder");
  await page.locator("#settings-place-go").click();
  await page.locator("#settings-place-results li").first().locator("button").click();
  await expect(page.locator("#settings-lat")).toHaveValue("40.0149856");

  let posts = 0;
  await page.route("**/$location", r => { posts++; r.continue(); });
  await page.evaluate(() => window.setLocation({ zoom: 8 }));
  await page.waitForTimeout(200);
  expect(posts).toBe(0);
});

test("a newer pick wins over a reverse geocode still in flight", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 51.5, longitude: -0.1 });
  await routeTiles(page);

  let releaseReverse;
  const reverseGate = new Promise(r => { releaseReverse = r; });
  await page.route(NOMINATIM, async r => {
    const url = r.request().url();
    if (url.includes("/reverse")) {
      await reverseGate;
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ lat: "51.5", lon: "-0.1", display_name: "London, UK" }) });
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BOULDER) });
  });

  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.locator("#tab-devices").click();
  await page.locator("#subtab-settings").click();

  await page.locator("#settings-place").fill("boulder");
  await page.locator("#settings-place-go").click();
  await expect(page.locator("#settings-place-results li")).toHaveCount(2);

  // geocode.js serializes search and reverse lookups behind a shared
  // one-second gap, so wait for the reverse request itself rather than a
  // fixed delay before treating it as "in flight".
  const reverseRequested = page.waitForRequest(r => r.url().includes("/reverse"));
  await page.locator("#settings-geolocate").click();
  await expect(page.locator("#settings-lat")).toHaveValue("51.5");
  await reverseRequested;

  await page.locator("#settings-place-results li").first().locator("button").click();
  await expect(page.locator("#settings-lat")).toHaveValue("40.0149856");

  const reverseResponded = page.waitForResponse(r => r.url().includes("/reverse"));
  releaseReverse();
  await reverseResponded;
  await expect(page.locator("#settings-location-status"))
    .toHaveText("Boulder, Boulder County, Colorado, United States");
});

test("clicking the map sets the coordinates to the point clicked", async ({ page }) => {
  await open(page);
  await page.locator("#settings-place").fill("boulder");
  await page.locator("#settings-place-go").click();
  await page.locator("#settings-place-results li").first().locator("button").click();
  await expect(page.locator("#settings-lat")).toHaveValue("40.0149856");

  const box = await page.locator("#settings-map").boundingBox();
  await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30);

  await expect(page.locator("#settings-lat")).not.toHaveValue("40.0149856");
  const lat = Number(await page.locator("#settings-lat").inputValue());
  const lon = Number(await page.locator("#settings-lon").inputValue());
  expect(Math.abs(lat - 40.015)).toBeLessThan(2);
  expect(Math.abs(lon + 105.2705)).toBeLessThan(2);
});

