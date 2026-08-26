import { test, expect } from "./pw.js";
import { startServer, routeWeather } from "./harness.js";
import { ACURITE, OREGON, topicOf } from "./fixtures.js";

const ACURITE_KEY = topicOf(ACURITE);
const OREGON_KEY = topicOf(OREGON);

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page) {
  await routeWeather(page);
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.evaluate(() => setLocation({ lat: 40.015, lon: -105.2705, zone: "America/Denver" }));
  await page.locator("#tab-devices").click();
  await expect(page.locator('#devices tr[data-key="local feed/Sun"]').first()).toBeVisible();
  await page.waitForTimeout(300);
}

test("a rich value's row shows its brief text instead of an empty cell", async ({ page }) => {
  await open(page);
  const cell = page.locator('#devices tr.vrow[data-key="local feed/Sun"][data-f="sun"] td').nth(1);
  await expect(cell).toHaveText(/\d{1,2}:\d{2} \/ \d{1,2}:\d{2}/);
});

// Changing a select re-renders the table while that select still has focus.
// The table used to answer that by rendering an empty tbody, which removed
// every row until something else happened to re-render it.
test("changing a display mode leaves the table standing", async ({ page }) => {
  await open(page);
  expect(await page.locator("#devices tr").count()).toBeGreaterThan(5);

  const sel = page.locator('#devices tr.vrow[data-key="local feed/Sun"][data-f="solar_noon"] select');
  await sel.click();
  await sel.selectOption("hidden");

  // Not an exact count: a feed publishing mid-test would move it. The failure
  // being guarded against emptied the table outright.
  expect(await page.locator("#devices tr").count()).toBeGreaterThan(5);
  await expect(page.locator(`#devices tr:not(.vrow)[data-key$="${ACURITE_KEY}"]`)).toHaveCount(1);
  await expect(sel).toHaveValue("hidden");
});

test("the select keeps focus through its own change", async ({ page }) => {
  await open(page);
  const sel = page.locator(`#devices tr.vrow[data-key$="${ACURITE_KEY}"][data-f="humidity"] select`);
  await sel.click();
  await sel.selectOption("bottom");

  expect(await page.evaluate(() => {
    const tr = document.activeElement.closest("tr");
    return tr ? `${tr.dataset.f}` : "(none)";
  })).toBe("humidity");
});

test("the table survives a packet arriving while a select has focus", async ({ page }) => {
  await open(page);
  const sel = page.locator('#devices tr.vrow[data-key="local feed/Sun"][data-f="civil_dawn"] select');
  await sel.click();
  await sel.selectOption("hidden");

  await page.evaluate(() => {
    const rec = [...devices.values()].find(d => !d.key.startsWith("local "));
    upsert({ key: rec.key, merged: { ...rec.merged, humidity: 41 }, obj: rec.obj, raw: rec.raw,
             rssi: -70, count: 9, seenAt: Date.now(), flashUntil: Date.now() + 1000 });
  });

  await expect(page.locator(`#devices tr:not(.vrow)[data-key$="${ACURITE_KEY}"]`)).toHaveCount(1);
  expect(await page.locator("#devices tr").count()).toBeGreaterThan(5);
});

test("the change reaches the card it was made for", async ({ page }) => {
  await open(page);
  await page.locator("#tab-cards").click();
  await page.evaluate(() => { setHideNewCards(false); cardState = { ...cardState, hidden: [] }; saveCardState(); });
  const sun = '.card:not(.ghostcard)[data-key="local feed/Sun"]';
  await expect(page.locator(`${sun} .val[data-f="solar_noon"]`)).toHaveCount(1);

  await page.locator("#tab-devices").click();
  await page.locator('#devices tr.vrow[data-key="local feed/Sun"][data-f="solar_noon"] select')
    .selectOption("hidden");

  await page.locator("#tab-cards").click();
  await expect(page.locator(`${sun} .val[data-f="solar_noon"]`)).toHaveCount(0);
});

test("a packet for one device does not re-render another device's row", async ({ page }) => {
  server = await startServer({ devices: [ACURITE, OREGON] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.locator("#tab-devices").click();
  await expect(page.locator(`#devices tr:not(.vrow)[data-key$="${ACURITE_KEY}"]`)).toHaveCount(1);

  const before = await page.evaluate(() => deviceRowRenders);
  server.emit(OREGON);
  await page.waitForFunction((tail) => {
    const key = [...devices.keys()].find(k => k.endsWith(tail));
    return key && devices.get(key).count === 2;
  }, OREGON_KEY);
  // Only the row for the device that got a packet should have re-rendered.
  expect(await page.evaluate(() => deviceRowRenders)).toBe(before + 1);
});

test("the table fills in on the first render after switching to it", async ({ page }) => {
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.locator("#tab-cards").click();
  await expect(page.locator("#devices tr")).toHaveCount(0);

  await page.locator("#tab-devices").click();
  await expect(page.locator(`#devices tr:not(.vrow)[data-key$="${ACURITE_KEY}"]`)).toHaveCount(1);
});
