import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { ACURITE, topicOf } from "./fixtures.js";

const ACURITE_KEY = topicOf(ACURITE);
const CARD = `.card:not(.ghostcard)[data-key$="${ACURITE_KEY}"]`;

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

function columnCount(page) {
  return page.evaluate(() =>
    getComputedStyle(document.getElementById("cards")).gridTemplateColumns.split(/\s+/).length);
}

test("a 390px viewport renders three columns", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.waitForTimeout(120);

  expect(await page.evaluate(() => viewCols)).toBe(3);
  expect(await columnCount(page)).toBe(3);
});

test("a desktop viewport still renders the saved six columns", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await page.waitForTimeout(120);

  expect(await page.evaluate(() => viewCols)).toBe(6);
  expect(await columnCount(page)).toBe(6);
});

test("a capped grid sizes its cell from width alone and scrolls instead", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.waitForTimeout(120);

  const m = await page.evaluate(() => {
    const g = document.getElementById("cards");
    const cs = getComputedStyle(g);
    return {
      cell: cellSide,
      width: g.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      rows: cs.gridTemplateRows,
    };
  });
  expect(m.cell).toBeCloseTo(m.width / 3, 1);
  expect(m.rows.split(/\s+/).length).not.toBe(4);
});
