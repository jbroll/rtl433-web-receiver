import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { ACURITE, OREGON, LONGNAME, topicOf } from "./fixtures.js";

const ACURITE_KEY = topicOf(ACURITE);
const OREGON_KEY = topicOf(OREGON);
const LONG_KEY = topicOf(LONGNAME);

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page, devices) {
  server = await startServer({ devices: devices || [] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  await page.click("#tab-devices");
  return server;
}

async function showCards(page) {
  await page.click("#tab-cards");
}

async function openSettings(page) {
  await page.click("#subtab-settings");
  await expect(page.locator("#pane-settings")).toBeVisible();
}

test("the Settings tab is reached from the Devices tab and holds the controls", async ({ page }) => {
  await open(page, [ACURITE]);
  await expect(page.locator("#pane-settings")).not.toBeVisible();
  await openSettings(page);
  await expect(page.locator("#settings-decimals")).toHaveValue("1");
  await expect(page.locator("#settings-units")).toHaveValue("metric");
  await expect(page.locator("#settings-custom")).toHaveCount(0);
});

test("changing decimals re-renders the card and the devices table", async ({ page }) => {
  await open(page, [LONGNAME]);
  const card = page.locator(`.card:not(.ghostcard)[data-key$="${LONG_KEY}"]`);
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toHaveText("21.8");
  await page.click("#tab-devices");
  await openSettings(page);
  await page.locator("#settings-decimals").selectOption("3");
  await page.click("#subtab-devices");
  const row = page.locator(`#devices tr:not(.vrow)[data-key$="${LONG_KEY}"]`);
  await expect(row).toContainText("21.797");
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toHaveText("21.797");
  const stored = await page.evaluate(
    k => devices.get(k).merged.temperature_F, server.url.replace(/\/$/, "") + " " + LONG_KEY);
  expect(stored).toBeCloseTo(71.23456789, 6);
});

test("switching to Imperial shows °F, in, and mi/h", async ({ page }) => {
  await open(page, [LONGNAME]);
  const card = page.locator(`.card:not(.ghostcard)[data-key$="${LONG_KEY}"]`);
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_F"] .fn .u')).toHaveText("°C");
  await page.click("#tab-devices");
  await openSettings(page);
  await page.locator("#settings-units").selectOption("imperial");
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_F"] .fn .u')).toHaveText("°F");
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toHaveText("71.2");
  await expect(card.locator('.val[data-f="wind_avg_mi_h"] .fn .u')).toHaveText("mi/h");
  await expect(card.locator('.val[data-f="rain_mm"] .fn .u')).toHaveText("in");
  await expect(card.locator('.val[data-f="pressure_hPa"] .fn .u')).toHaveText("hPa");
});

test("Imperial converts a Celsius reading to Fahrenheit", async ({ page }) => {
  await open(page, [OREGON]);
  const card = page.locator(`.card:not(.ghostcard)[data-key$="${OREGON_KEY}"]`);
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_C"] .fv')).toHaveText("19.4");
  await page.click("#tab-devices");
  await openSettings(page);
  await page.locator("#settings-units").selectOption("imperial");
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_C"] .fn .u')).toHaveText("°F");
  await expect(card.locator('.val[data-f="temperature_C"] .fv')).toHaveText("66.9");
});

test("Custom mode exposes the four selects and applies them", async ({ page }) => {
  await open(page, [LONGNAME]);
  const card = page.locator(`.card:not(.ghostcard)[data-key$="${LONG_KEY}"]`);
  await page.click("#tab-devices");
  await openSettings(page);
  await expect(page.locator("#settings-custom")).toHaveCount(0);
  await page.locator("#settings-units").selectOption("custom");
  await expect(page.locator("#settings-temp")).toBeVisible();
  await expect(page.locator("#settings-rain")).toBeVisible();
  await expect(page.locator("#settings-wind")).toBeVisible();
  await expect(page.locator("#settings-pressure")).toBeVisible();
  await expect(page.locator("#settings-temp")).toHaveValue("C");
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_F"] .fn .u')).toHaveText("°C");
  await page.click("#tab-devices");
  await page.locator("#settings-temp").selectOption("F");
  await showCards(page);
  await expect(card.locator('.val[data-f="temperature_F"] .fn .u')).toHaveText("°F");
});

test("settings changes are saved and survive a reload", async ({ page }) => {
  await open(page, [OREGON]);
  await openSettings(page);
  await page.locator("#settings-units").selectOption("imperial");
  await page.locator("#settings-decimals").selectOption("3");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("rtl433.settings.v1")));
  expect(saved.units).toBe("imperial");
  expect(saved.decimals).toBe(3);
  expect(saved.custom).toEqual({ temp: "F", rain: "in", wind: "mi/h", pressure: "hPa" });

  await page.reload();
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.click("#tab-devices");
  await openSettings(page);
  await expect(page.locator("#settings-units")).toHaveValue("imperial");
  await expect(page.locator("#settings-decimals")).toHaveValue("3");
  await showCards(page);
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  const card = page.locator(`.card:not(.ghostcard)[data-key$="${OREGON_KEY}"]`);
  await expect(card.locator('.val[data-f="temperature_C"] .fn .u')).toHaveText("°F");
});
