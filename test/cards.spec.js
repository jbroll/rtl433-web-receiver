const { test, expect } = require("@playwright/test");
const { startServer } = require("./harness");
const { ACURITE, OREGON } = require("./fixtures");

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page, devices) {
  server = await startServer({ devices: devices || [] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText("live");
  return server;
}

test("the served page lists devices and streams live signals", async ({ page }) => {
  await open(page, [ACURITE]);
  await expect(page.locator("#devices tr")).toHaveCount(1);
  await expect(page.locator("#devices tr").first()).toContainText("Acurite-5n1");

  server.emit(OREGON);
  await expect(page.locator("#devices tr")).toHaveCount(2);
});

test("the Cards tab shows an empty grid and switches views", async ({ page }) => {
  await open(page, [ACURITE]);
  await expect(page.locator("#view-cards")).toBeHidden();

  await page.click("#tab-cards");
  await expect(page.locator("#view-cards")).toBeVisible();
  await expect(page.locator("#view-devices")).toBeHidden();
  await expect(page.locator("#tab-cards")).toHaveAttribute("aria-selected", "true");

  await page.click("#tab-devices");
  await expect(page.locator("#view-cards")).toBeHidden();
});

async function cardState(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("rtl433.cards.v1") || "null"));
}

test("a new device gets defaults: appended, visible, status fields hidden", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");

  const state = await page.evaluate(() => {
    const merged = { temperature_F: 71.2, humidity: 38, battery_ok: 1, wind_avg_mi_h: 4.6 };
    ensureCard("Acurite-5n1/396", merged);
    saveCardState();
    return { s: cardState, vis: visibleValues("Acurite-5n1/396", merged) };
  });

  expect(state.s.order).toEqual(["Acurite-5n1/396"]);
  expect(state.s.cards["Acurite-5n1/396"].hiddenValues).toEqual(["battery_ok"]);
  expect(state.s.cards["Acurite-5n1/396"].valueOrder)
    .toEqual(["temperature_F", "humidity", "battery_ok", "wind_avg_mi_h"]);
  expect(state.vis).toEqual(["temperature_F", "humidity", "wind_avg_mi_h"]);
});

test("a field added later appends without disturbing stored order", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const order = await page.evaluate(() => {
    cardState = { order: ["k"], hidden: [],
      cards: { k: { aspect: "sq", valueOrder: ["humidity", "temperature_F"], hiddenValues: [] } } };
    ensureCard("k", { temperature_F: 1, humidity: 2, rain_in: 3 });
    return cardState.cards.k.valueOrder;
  });
  expect(order).toEqual(["humidity", "temperature_F", "rain_in"]);
});

test("corrupt storage is discarded and defaults rebuild", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.evaluate(() => localStorage.setItem("rtl433.cards.v1", "{not json"));
  await page.reload();
  await expect(page.locator("#status")).toHaveText("live");
  const s = await page.evaluate(() => cardState);
  expect(s).toEqual({ order: [], hidden: [], cards: {} });
});
