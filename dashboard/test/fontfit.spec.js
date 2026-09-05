import { test, expect } from "./pw.js";
import { startServer, openSettings, closeSettings } from "./harness.js";
import { ACURITE, ACURITE_WIND, ACURITE_RAIN, LONGNAME, topicOf } from "./fixtures.js";

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
    upsert({ key, merged, seenAt: 0, rssi: undefined, count: 0, obj: null, raw: "" });
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
  await openSettings(page);

  const cell = page.locator(`tr[data-key="${RICH_KEY}"] td`).nth(2);
  await expect(cell).toHaveText("note: long");
  await expect(cell).not.toContainText("$r");
});

// .fv is a shrink-to-fit flex item, so its own scrollWidth/clientWidth is
// always 1; measure against the box fitValues() sized it for, the .val
// parent. See docs/architecture.md's "Value fit" for why width and height
// fill are both checked.
function fillRatios(page, selector) {
  return page.locator(selector).evaluateAll(
    nodes => nodes.map(n => {
      const val = n.closest(".val");
      const fn = val.querySelector(".fn");
      return Math.max(n.scrollWidth / val.clientWidth,
                      n.getBoundingClientRect().height / (val.clientHeight - fn.offsetHeight));
    }));
}

test("a value fills most of the width it is given, at any grid size", async ({ page }) => {
  server = await startServer({ devices: [LONGNAME] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  await closeSettings(page);

  for (const [cols, rows] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 3]]) {
    await page.evaluate(([c, r]) => { setGrid("cols", c); setGrid("rows", r); }, [cols, rows]);
    // fitValues() runs from a useEffect deferred to the next frame, so poll
    // for the fit to settle instead of racing it with a fixed wait.
    await expect.poll(() => fillRatios(page, ".val .fv").then(rs => Math.max(...rs)),
      { message: `${cols}x${rows}` }).toBeGreaterThan(0.9);
    // No value may overflow the box it was sized for.
    for (const r of await fillRatios(page, ".val .fv")) expect(r).toBeLessThanOrEqual(1.02);
  }
});

test("one narrow box floors at 0.6 of the median fit, not the global minimum", async ({ page }) => {
  server = await startServer({ devices: [] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);

  const num = "1234567";
  const result = await page.evaluate((num) => {
    const widths = [400, 400, 400, 400, 400, 400, 120];
    const parents = widths.map(w => {
      const parent = document.createElement("div");
      parent.style.cssText = `width:${w}px; height:1000px;`;
      document.body.appendChild(parent);
      const node = document.createElement("span");
      parent.appendChild(node);
      trackFit(node, num);
      return parent;
    });
    const em = textWidthEm(num);
    fitValues();
    const sizes = parents.map(p => parseFloat(p.firstChild.style.fontSize));
    parents.forEach(p => p.remove());
    return { em, sizes };
  }, num);

  const normalFit = Math.floor(400 / result.em);
  const pathFit = Math.floor(120 / result.em);
  const expected = Math.max(11, pathFit, 0.6 * normalFit);

  // One page-wide size: the narrow box's own fit no longer sets it for all
  // seven, so every size lands at the 0.6-of-median floor instead of pathFit.
  for (const size of result.sizes) expect(size).toBeCloseTo(expected, 0);
  expect(expected).toBeGreaterThan(pathFit);
});

test("letter-spacing on .fv does not overflow the value box", async ({ page }) => {
  await open(page);
  await page.addStyleTag({ content: ".fv { letter-spacing: .2em; }" });
  await page.evaluate(() => fitValues());

  const ratios = await fillRatios(page, `${CARD} .fv`);
  // Lower bound too: a change that collapsed every value to the 11px floor
  // would still satisfy an upper-bound-only check.
  expect(Math.max(...ratios)).toBeGreaterThan(0.9);
  for (const r of ratios) expect(r).toBeLessThanOrEqual(1.02);
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

test("textWidthEm ignores a detached head entry instead of measuring garbage", async ({ page }) => {
  await open(page);

  // A card unmount can leave the head fitting entry detached until the next
  // fitValues() run purges it. textWidthEm() (called outside that loop by
  // every renderer) must not measure against a node with no computed style:
  // getComputedStyle on a detached node returns "" for every property, which
  // used to leave fontSizePx defaulted to 100 and the em far too small.
  const detachedEm = await page.evaluate(() => {
    const node = document.querySelector(".card .fv");
    trackFit(node, "88.8");
    node.remove();
    return textWidthEm("88.8");
  });
  expect(detachedEm).toBeGreaterThan(1);
});

// upsert() on an existing device mutates its signals in place and leaves
// devices.value's own identity untouched, so CardsView's fitValues() effect
// (keyed on devices.value) does not rerun for a reading that only got wider.
// I3: a widening value must still end up fitted. A single wide outlier on a
// small card can legitimately still overflow a little under the page-wide
// floor ("one narrow box floors..." above), so the proof here is not an
// absolute ratio bound -- it's that the automatic refit already reached the
// same steady state a full manual fitValues() pass would, i.e. nothing was
// left stale.
test("a live reading that grows wider gets refit", async ({ page }) => {
  await open(page);
  const val = page.locator(`${CARD} .val[data-f="temperature_F"]`);
  const fv = val.locator(".fv");
  const before = await fv.textContent();
  const callsBefore = await page.evaluate(() => fitValuesCalls);

  await server.emit({ ...ACURITE, temperature_F: 123456.789 });
  await expect.poll(() => fv.textContent()).not.toBe(before);

  const ratioOf = () => val.evaluate(v => v.querySelector(".fv").scrollWidth / v.clientWidth);
  const autoRatio = await ratioOf();
  // A single widening message must not force more than the one page-wide
  // fitValues() pass its own overflow check triggers.
  const callsAfter = await page.evaluate(() => fitValuesCalls);
  expect(callsAfter - callsBefore).toBeLessThanOrEqual(1);

  await page.evaluate(() => fitValues());
  const manualRatio = await ratioOf();
  // Stale would show up as autoRatio still reflecting the old, narrower fit --
  // a mismatch against what a fresh manual pass computes for the same content.
  expect(autoRatio).toBeCloseTo(manualRatio, 5);
});

// The Acurite 5n1 splits its readings across alternating message types, so the
// second half arrives as fields the card has never drawn. ensureCard() only
// bumps cardState when a field is new to valueOrder, and a published layout
// already lists every one, so CardsView's fit effect does not rerun either --
// the boxes that just mounted have to ask for the fit themselves.
test("a value box that appears on a later message is fitted like the rest", async ({ page }) => {
  server = await startServer({ devices: [ACURITE_WIND] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  await expect(page.locator(CARD)).toBeVisible();

  // Big enough that the inherited font size does not overflow the new boxes.
  // On a card small enough that it does, the overflow check hides the bug.
  await page.evaluate((topic) => {
    const key = Object.keys(cardState.cards).find(k => k.endsWith(topic));
    setGrid("cols", 4);
    setGrid("rows", 3);
    setCardSize(key, 4, 3);
    cardState.cards[key].valueOrder.push("rain_mm", "rain_today_mm");
    saveCardState();
  }, topicOf(ACURITE_WIND));

  const sizes = () => page.locator(`${CARD} .fv`)
    .evaluateAll(els => els.map(e => e.style.fontSize));

  // The load's own fits have to be done before the emit. One still in flight
  // sizes the new boxes for reasons that have nothing to do with them, which
  // is how this reproduces on a real dashboard but not on every page load.
  for (let calls = -1, seen = 0; calls !== seen; ) {
    calls = await page.evaluate(() => fitValuesCalls);
    await page.waitForTimeout(250);
    seen = await page.evaluate(() => fitValuesCalls);
  }

  await server.emit(ACURITE_RAIN);
  // An unfitted box has no inline size at all and draws at the inherited one.
  await expect.poll(() => sizes())
    .toEqual(Array(4).fill(expect.stringMatching(/^\d+(\.\d+)?px$/)));
  const auto = await sizes();
  expect(new Set(auto).size).toBe(1);

  await page.evaluate(() => fitValues());
  expect(await sizes()).toEqual(auto);
});

// iOS 15 has no container query units. An unknown unit voids the whole
// font-size declaration, so a rich cell's type silently drops to the inherited
// size instead of filling the cell.
test("rich value type uses no container query units", async ({ page }) => {
  await open(page);
  await addRichCard(page);

  const offenders = await page.evaluate(() => {
    const CQ = /\d\s*cq[hwib]\b/;
    const found = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (r.cssText && CQ.test(r.cssText)) found.push(r.cssText.slice(0, 90));
      }
    }
    for (const el of document.querySelectorAll("[style]")) {
      const s = el.getAttribute("style");
      if (CQ.test(s)) found.push(s.slice(0, 90));
    }
    return found;
  });

  expect(offenders).toEqual([]);
});

test("a rich cell's type grows with the cell", async ({ page }) => {
  await open(page);
  await addRichCard(page);

  const text = page.locator(`.card[data-key="${RICH_KEY}"] .ctext`);
  await expect(text).toBeVisible();
  const sizeOf = async () =>
    parseFloat(await text.evaluate(e => getComputedStyle(e).fontSize));

  await expect.poll(sizeOf).toBeGreaterThan(9);
  const small = await sizeOf();

  await page.evaluate(() => {
    const key = "local feed/Rich";
    cardState = {
      ...cardState,
      cards: { ...cardState.cards, [key]: { ...cardState.cards[key], w: 3, h: 3 } },
    };
    saveCardState();
  });

  await expect.poll(sizeOf).toBeGreaterThan(small);
});
