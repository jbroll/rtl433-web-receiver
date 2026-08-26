import { test, expect } from "./pw.js";
import { startServer } from "./harness.js";
import { ACURITE, LONGNAME, topicOf } from "./fixtures.js";

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

test("a value fills most of the width it is given, at any grid size", async ({ page }) => {
  server = await startServer({ devices: [LONGNAME] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  await page.click("#tab-cards");

  // .fv is a shrink-to-fit flex item, so its own scrollWidth/clientWidth is
  // always 1; measure against the box fitValues() sized it for, the .val
  // parent. See docs/architecture.md's "Value fit" for why width and height
  // fill are both checked.
  const fillRatios = () => page.locator(".val .fv").evaluateAll(
    nodes => nodes.map(n => {
      const val = n.closest(".val");
      const fn = val.querySelector(".fn");
      return Math.max(n.scrollWidth / val.clientWidth,
                      n.getBoundingClientRect().height / (val.clientHeight - fn.offsetHeight));
    }));

  for (const [cols, rows] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 3]]) {
    await page.evaluate(([c, r]) => { setGrid("cols", c); setGrid("rows", r); }, [cols, rows]);
    // fitValues() runs from a useEffect deferred to the next frame, so poll
    // for the fit to settle instead of racing it with a fixed wait.
    await expect.poll(() => fillRatios().then(rs => Math.max(...rs)),
      { message: `${cols}x${rows}` }).toBeGreaterThan(0.9);
    // No value may overflow the box it was sized for.
    for (const r of await fillRatios()) expect(r).toBeLessThanOrEqual(1.02);
  }
});

test("letter-spacing on .fv does not overflow the value box", async ({ page }) => {
  await open(page);
  await page.addStyleTag({ content: ".fv { letter-spacing: .2em; }" });
  await page.evaluate(() => fitValues());

  const fillRatios = () => page.locator(`${CARD} .fv`).evaluateAll(
    nodes => nodes.map(n => n.scrollWidth / n.closest(".val").clientWidth));
  for (const r of await fillRatios()) expect(r).toBeLessThanOrEqual(1.02);
});

test("hiding and showing a card repeatedly does not leak fitting entries", async ({ page }) => {
  await open(page);
  for (let i = 0; i < 50; i++) {
    await page.evaluate(() => {
      const key = [...devices.keys()][0];
      cardState = { ...cardState, hidden: [key] };
      saveCardState();
    });
    await expect(page.locator(CARD)).toHaveCount(0);
    await page.evaluate(() => { cardState = { ...cardState, hidden: [] }; saveCardState(); });
    await expect(page.locator(CARD)).toBeVisible();
  }
  // The card holds a handful of tracked value nodes; a leak would have added
  // one entry per node per cycle instead of settling back down each time.
  expect(await page.evaluate(() => fittingSize)).toBeLessThan(10);
});
