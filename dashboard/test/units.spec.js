import { test, expect } from "@playwright/test";
import { startServer, startPage } from "./harness.js";
import { OREGON, topicOf } from "./fixtures.js";

const OREGON_KEY = topicOf(OREGON, "srcA");

const IMPERIAL = {
  units: "imperial", decimals: 1,
  custom: { temp: "F", rain: "in", wind: "mi/h", pressure: "hPa" },
};

let servers = [];

test.afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

function base(server) { return server.url.replace(/\/$/, ""); }

const CARD = `.card:not(.ghostcard)[data-key$="${OREGON_KEY}"]`;

async function showAllCards(page) {
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  await page.click("#tab-cards");
}

test("a receiver's imperial units reach a visitor with nothing stored", async ({ page }) => {
  const host = await startPage();
  const src = await startServer({ devices: [OREGON], source: "srcA" });
  servers.push(host, src);
  await src.emitUnits(IMPERIAL);
  await page.addInitScript((list) => {
    localStorage.setItem("rtl433.sources.v1", JSON.stringify(list));
  }, [base(src)]);
  await page.goto(host.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await showAllCards(page);
  await expect(page.locator(CARD).locator('.val[data-f="temperature_C"] .fn .u')).toHaveText("°F");
  await expect(page.locator(CARD).locator('.val[data-f="temperature_C"] .fv')).toHaveText("66.9");
});

test("a $units frame leaves a visitor who already stored settings alone", async ({ page }) => {
  const host = await startPage();
  const src = await startServer({ devices: [OREGON], source: "srcA" });
  servers.push(host, src);
  await src.emitUnits(IMPERIAL);
  await page.addInitScript((list) => {
    localStorage.setItem("rtl433.sources.v1", JSON.stringify(list));
    localStorage.setItem("rtl433.settings.v1", JSON.stringify({
      units: "metric", decimals: 1,
      custom: { temp: "C", rain: "mm", wind: "km/h", pressure: "hPa" },
    }));
  }, [base(src)]);
  await page.goto(host.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await showAllCards(page);
  await expect(page.locator(CARD).locator('.val[data-f="temperature_C"] .fn .u')).toHaveText("°C");
});

test("changing units POSTs $units when the serving origin is a configured source", async ({ page }) => {
  const server = await startServer({ devices: [OREGON] });
  servers.push(server);
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.click("#tab-devices");
  await page.click("#subtab-settings");
  await page.locator("#settings-units").selectOption("imperial");
  await page.locator("#settings-decimals").selectOption("2");

  await expect.poll(async () => (await server.get(server.source + "/$units")).status).toBe(200);
  const u = JSON.parse((await server.get(server.source + "/$units")).body);
  expect(u.units).toBe("imperial");
  expect(u.decimals).toBe(2);
  expect(u.custom).toEqual({ temp: "F", rain: "in", wind: "mi/h", pressure: "hPa" });
});
