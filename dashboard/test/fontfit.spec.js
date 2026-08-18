import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { ACURITE, topicOf } from "./fixtures.js";

const ACURITE_KEY = topicOf(ACURITE);
const CARD = `.card:not(.ghostcard)[data-key$="${ACURITE_KEY}"]`;
const RICH_KEY = "local feed/Rich";

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page) {
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  await expect(page.locator(CARD)).toBeVisible();
}

// A rich value long enough that, were it measured as a .fv, it would drag the
// page-wide cap well below what the device card alone settles on.
async function addRichCard(page) {
  await page.evaluate(() => {
    const key = "local feed/Rich";
    const merged = {
      note: { $r: "text", label: "Forecast", brief: "long", text: "Partly sunny then chance showers and thunderstorms" },
    };
    upsert({ key, merged, seenAt: 0, flashUntil: 0, rssi: undefined, count: 0, obj: null, raw: "" });
    ensureCard(key, merged, { autoShow: true });
    saveCardState();
  });
  await expect(page.locator(`.card[data-key="${RICH_KEY}"]`)).toBeVisible();
}

async function fontSizes(page) {
  return page.locator(`${CARD} .fv`).evaluateAll(
    els => els.map(e => getComputedStyle(e).fontSize));
}

test("a rich value does not change the font size of scalar values", async ({ page }) => {
  await open(page);
  const before = await fontSizes(page);
  expect(before.length).toBeGreaterThan(0);

  await addRichCard(page);
  await page.evaluate(() => fitValues());

  expect(await fontSizes(page)).toEqual(before);
});

test("a rich value emits no .fv and keeps .val with its field name", async ({ page }) => {
  await open(page);
  await addRichCard(page);

  const rich = page.locator(`.card[data-key="${RICH_KEY}"] .val.cval`);
  await expect(rich).toHaveCount(1);
  await expect(rich).toHaveAttribute("data-f", "note");
  await expect(page.locator(`.card[data-key="${RICH_KEY}"] .fv`)).toHaveCount(0);
  await expect(page.locator("#cards .val.cval .fv")).toHaveCount(0);
});

test("a rich value shows its brief in the devices table, not its object", async ({ page }) => {
  await open(page);
  await addRichCard(page);
  await page.locator("#tab-devices").click();

  const cell = page.locator(`tr[data-key="${RICH_KEY}"] td`).nth(2);
  await expect(cell).toHaveText("note: long");
  await expect(cell).not.toContainText("$r");
});
