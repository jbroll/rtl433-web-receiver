import { test, expect } from "@playwright/test";
import { startPage } from "./harness.js";

const SUN_KEY = "local feed/Sun";
const SUN_CARD = `.card:not(.ghostcard)[data-key="${SUN_KEY}"]`;

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

// startPage serves the bundle with no binding behind it, so the page has no
// source and the device cap is zero. That is the case a feed has to survive.
// startPage serves no binding, so the origin probe fails and the app settles
// on the sources tab. Wait that out before switching to cards, or the abort
// lands after the click and puts the tab back.
async function openCards(page) {
  await expect(page.locator("#tab-sources")).toHaveAttribute("aria-selected", "true");
  await page.locator("#tab-cards").click();
  await expect(page.locator("#cards")).toBeVisible();
}

async function open(page) {
  server = await startPage();
  await page.goto(server.url);
  await openCards(page);
  return server;
}

async function addSunFeed(page) {
  await page.evaluate(() => {
    const key = "local feed/Sun";
    const merged = { sunrise: "05:42", sunset: "20:11", solar_noon: "12:56" };
    upsert({ key, merged, seenAt: 0, flashUntil: 0, rssi: undefined, count: 0, obj: null, raw: "" });
    ensureCard(key, merged, { autoShow: true });
    saveCardState();
  });
}

test("a feed card appears with no source configured and no unhiding", async ({ page }) => {
  await open(page);
  await addSunFeed(page);

  await expect(page.locator(SUN_CARD)).toBeVisible();
  await expect(page.locator(`${SUN_CARD} .val`)).toHaveCount(3);
  await expect(page.locator(`${SUN_CARD} .lbl .nm`)).toHaveText("Sun");
});

test("a feed card shows no age and no rssi", async ({ page }) => {
  await open(page);
  await addSunFeed(page);

  await expect(page.locator(`${SUN_CARD} .age`)).toHaveCount(0);
  await expect(page.locator(`${SUN_CARD} .lbl .rs`)).toHaveText("");
});

test("a feed card keeps its size across a reload", async ({ page }) => {
  await open(page);
  await addSunFeed(page);
  await page.evaluate(() => { setCardSize("local feed/Sun", 3, 2); saveCardState(); });

  await page.reload();
  await openCards(page);
  await addSunFeed(page);

  const span = await page.locator(SUN_CARD).evaluate(el => el.style.gridColumn + " / " + el.style.gridRow);
  expect(span).toBe("span 3 / span 2");
});
