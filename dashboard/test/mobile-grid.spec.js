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

test("a card wider than the cap renders at the cap", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.evaluate(k => setCardSize(k, 5, 2), await page.evaluate(() =>
    Object.keys(cardState.cards).find(k => k.includes("Acurite"))));
  await page.waitForTimeout(120);

  await expect(page.locator(CARD)).toHaveCSS("grid-column", /span 3/);
});

test("a card wider than the cap keeps its stored width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const key = await page.evaluate(() =>
    Object.keys(cardState.cards).find(k => k.includes("Acurite")));
  await page.evaluate(k => setCardSize(k, 5, 2), key);
  await page.waitForTimeout(120);

  const c = await page.evaluate(k => cardState.cards[k], key);
  expect(c.w).toBe(5);
});

test("the bottom strip is not drawn through the values", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.waitForTimeout(120);

  const overlaps = await page.evaluate(() => {
    const bad = [];
    for (const card of document.querySelectorAll("#cards .card")) {
      const body = card.querySelector(".body");
      for (const sel of [".btm", ".age"]) {
        const node = card.querySelector(sel);
        if (!body || !node) continue;
        const a = body.getBoundingClientRect(), b = node.getBoundingClientRect();
        const hit = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        if (hit) bad.push(card.dataset.key + " " + sel);
      }
    }
    return bad;
  });
  expect(overlaps).toEqual([]);
});

test("a long field name ellipsizes rather than clipping mid-word", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.waitForTimeout(120);

  const styles = await page.locator("#cards .card .fn > span:first-child").evaluateAll(
    els => els.map(e => getComputedStyle(e).textOverflow));
  expect(styles.length).toBeGreaterThan(0);
  expect(styles.every(s => s === "ellipsis")).toBe(true);
});

test("saving from a capped view writes the saved column count, not the cap", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.waitForTimeout(120);

  const m = await page.evaluate(() => ({ view: viewCols, template: deriveTemplate() }));
  expect(m.view).toBe(3);
  expect(m.template.grid.cols).toBe(6);
  expect(m.template.grid.rows).toBe(4);
});
