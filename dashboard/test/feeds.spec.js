import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { ACURITE } from "./fixtures.js";

const CLOCK = '.card:not(.ghostcard)[data-key="local feed/Clock"]';

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page) {
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
}

async function setPlace(page, lat, lon, zone) {
  await page.evaluate(([la, lo, z]) => setLocation({ lat: la, lon: lo, zone: z }), [lat, lon, zone]);
}

test("no feed card exists until a location is set", async ({ page }) => {
  await open(page);
  await expect(page.locator(CLOCK)).toHaveCount(0);

  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();
});

test("the clock card appears without being unhidden", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");

  await expect(page.locator(CLOCK)).toBeVisible();
  expect(await page.evaluate(() => cardState.hidden)).not.toContain("local feed/Clock");
});

test("the clock reads in the chosen zone and shows its offset", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();

  const shown = await page.locator(`${CLOCK} .val.cval .big`).textContent();
  const expected = await page.evaluate(() => new Intl.DateTimeFormat(undefined, {
    timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()));
  expect(shown).toBe(expected);

  await expect(page.locator(`${CLOCK} .val[data-f="utc_offset"] .fv`)).toHaveText(/^[-+]0[67]:00$/);
  await expect(page.locator(`${CLOCK} .val[data-f="time_zone"] .fv`)).toHaveText("America/Denver");
});

test("changing the zone moves the clock", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();
  const denver = await page.locator(`${CLOCK} .val.cval .big`).textContent();

  await setPlace(page, 35.68, 139.69, "Asia/Tokyo");
  await expect(page.locator(`${CLOCK} .val[data-f="time_zone"] .fv`)).toHaveText("Asia/Tokyo");
  expect(await page.locator(`${CLOCK} .val.cval .big`).textContent()).not.toBe(denver);
});

test("the clock survives a reload without waiting on anything", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();

  await page.reload();
  await expect(page.locator("#status")).toHaveText(/^live/);
  await expect(page.locator(CLOCK)).toBeVisible();
});

test("a feed card carries no age and no rssi", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();

  await expect(page.locator(`${CLOCK} .age`)).toHaveCount(0);
  await expect(page.locator(`${CLOCK} .lbl .nm`)).toHaveText("Clock");
});

test("hiding one value on a feed card leaves the rest", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();
  const before = await page.locator(`${CLOCK} .val`).count();

  await page.evaluate(() => {
    const s = cardState;
    s.cards["local feed/Clock"].hiddenValues = ["dst"];
    cardState = { ...s };
    saveCardState();
  });

  await expect(page.locator(`${CLOCK} .val`)).toHaveCount(before - 1);
  await expect(page.locator(`${CLOCK} .val[data-f="dst"]`)).toHaveCount(0);
});
