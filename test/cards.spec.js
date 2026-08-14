const { test, expect } = require("@playwright/test");
const { startServer } = require("./harness");
const { ACURITE, OREGON, THERMO, LONGNAME } = require("./fixtures");

const CARD = '.card[data-key="Acurite-5n1/396"]';
const LONG_KEY = LONGNAME.model + "/" + LONGNAME.id;
const LONG_CARD = `.card[data-key="${LONG_KEY}"]`;

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

async function setSize(page, key, w, h) {
  await page.evaluate(([k, w, h]) => {
    cardState.cards[k].w = w;
    cardState.cards[k].h = h;
    renderCards();
  }, [key, w, h]);
}

async function setGrid(page, cols, rows) {
  await page.evaluate(([c, r]) => {
    cardState.grid = { cols: c, rows: r };
    measureGrid();
    renderCards();
  }, [cols, rows]);
}

function spans(page, sel) {
  return page.locator(sel).evaluate(n => {
    const s = getComputedStyle(n);
    return { col: s.gridColumnStart + " " + s.gridColumnEnd, row: s.gridRowStart + " " + s.gridRowEnd };
  });
}

test("a new device gets defaults: appended, visible, status fields hidden", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");

  // A key distinct from ACURITE's: rendering already seeds a card for every
  // loaded device, so reusing that key would no longer be "new" by this point.
  const state = await page.evaluate(() => {
    const merged = { temperature_F: 71.2, humidity: 38, battery_ok: 1, wind_avg_mi_h: 4.6 };
    ensureCard("New-Device/1", merged);
    saveCardState();
    return { s: cardState, vis: visibleValues("New-Device/1", merged) };
  });

  expect(state.s.order).toEqual(["Acurite-5n1/396", "New-Device/1"]);
  expect(state.s.cards["New-Device/1"].hiddenValues).toEqual(["battery_ok"]);
  expect(state.s.cards["New-Device/1"].valueOrder)
    .toEqual(["temperature_F", "humidity", "battery_ok", "wind_avg_mi_h"]);
  expect(state.vis).toEqual(["temperature_F", "humidity", "wind_avg_mi_h"]);
});

test("a field added later appends without disturbing stored order", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const order = await page.evaluate(() => {
    cardState = { grid: { cols: 6, rows: 4 }, order: ["k"], hidden: [],
      cards: { k: { w: 1, h: 1, valueOrder: ["humidity", "temperature_F"], hiddenValues: [] } } };
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
  expect(s).toEqual({
    grid: { cols: 6, rows: 4 },
    order: ["Acurite-5n1/396"],
    hidden: [],
    cards: {
      "Acurite-5n1/396": {
        w: 2, h: 2,
        valueOrder: ["battery_ok", "wind_avg_mi_h", "temperature_F", "humidity"],
        hiddenValues: ["battery_ok"],
      },
    },
  });
});

test("a __proto__ key in stored cards can't taint an untouched device's defaults", async ({ page }) => {
  await open(page, [ACURITE]);
  // Written as raw JSON text: an object literal's __proto__ key sets a
  // prototype rather than an own property, which would defeat the test.
  const payload = '{"order":[],"hidden":[],"cards":{"__proto__":' +
    '{"w":4,"h":4,"valueOrder":["bogus"],"hiddenValues":["bogus"]}}}';
  await page.evaluate((p) => localStorage.setItem("rtl433.cards.v1", p), payload);
  await page.reload();
  await expect(page.locator("#status")).toHaveText("live");

  const result = await page.evaluate(() => {
    try {
      const merged = { temperature_F: 71.2, humidity: 38, battery_ok: 1 };
      ensureCard("toString", merged);
      return { ok: true, card: cardState.cards["toString"] };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  expect(result.ok).toBe(true);
  expect(result.card.w).toBe(2);
  expect(result.card.h).toBe(1);
  expect(result.card.valueOrder).toEqual(["temperature_F", "humidity", "battery_ok"]);
  expect(result.card.hiddenValues).toEqual(["battery_ok"]);
});

test("default card size packs values into the most compact rectangle", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const sizes = await page.evaluate(() =>
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => { const s = defaultSize(n); return [s.w, s.h]; }));
  expect(sizes).toEqual([[1, 1], [2, 1], [2, 2], [2, 2], [3, 2], [3, 2], [3, 3], [3, 3], [3, 3]]);
});

test("an Acurite 5n1 with three readings defaults to 2x2", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const c = (await page.evaluate(() => cardState)).cards["Acurite-5n1/396"];
  expect([c.w, c.h]).toEqual([2, 2]);
  expect(await spans(page, CARD)).toEqual({ col: "span 2 auto", row: "span 2 auto" });
});

test("the cell side is the smaller of the two divisions and re-measures on resize", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  await setGrid(page, 6, 4);

  const read = () => page.evaluate(() => {
    const g = document.getElementById("cards");
    const cs = getComputedStyle(g);
    return {
      cell: cellSide,
      width: g.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      height: window.innerHeight - g.getBoundingClientRect().top
              - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
      prop: parseFloat(cs.getPropertyValue("--cell")),
    };
  });

  for (const [w, h] of [[1200, 800], [640, 900], [1400, 500]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(120);
    const m = await read();
    expect(m.cell).toBeCloseTo(Math.min(m.width / 6, m.height / 4), 1);
    expect(m.prop).toBeCloseTo(m.cell, 1);
  }
});

test("an old aspect entry migrates to a width and height", async ({ page }) => {
  await open(page, [ACURITE, OREGON, THERMO]);
  await page.evaluate(() => localStorage.setItem("rtl433.cards.v1", JSON.stringify({
    order: ["Acurite-5n1/396", "Oregon-THN132N/23", "Fineoffset-WH2/174"],
    hidden: [],
    cards: {
      "Acurite-5n1/396": { aspect: "h", valueOrder: [], hiddenValues: [] },
      "Oregon-THN132N/23": { aspect: "v", valueOrder: [], hiddenValues: [] },
      "Fineoffset-WH2/174": { aspect: "sq", valueOrder: [], hiddenValues: [] },
    },
  })));
  await page.reload();
  await page.click("#tab-cards");

  const cards = (await page.evaluate(() => cardState)).cards;
  expect([cards["Acurite-5n1/396"].w, cards["Acurite-5n1/396"].h]).toEqual([2, 1]);
  expect([cards["Oregon-THN132N/23"].w, cards["Oregon-THN132N/23"].h]).toEqual([1, 2]);
  expect([cards["Fineoffset-WH2/174"].w, cards["Fineoffset-WH2/174"].h]).toEqual([1, 1]);
  expect(cards["Acurite-5n1/396"].aspect).toBeUndefined();
});

test("an entry with neither a size nor an aspect is sized from its value count", async ({ page }) => {
  await open(page, [LONGNAME]);
  await page.evaluate(k => localStorage.setItem("rtl433.cards.v1", JSON.stringify({
    order: [k], hidden: [], cards: { [k]: { valueOrder: [], hiddenValues: [] } },
  })), LONG_KEY);
  await page.reload();
  await page.click("#tab-cards");

  // Eight readings, battery_ok hidden as a status field, leaves seven visible.
  const c = (await page.evaluate(() => cardState)).cards[LONG_KEY];
  expect([c.w, c.h]).toEqual([3, 3]);
});

test("a card renders label, visible values, rssi and age", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");

  const card = page.locator('.card[data-key="Acurite-5n1/396"]');
  await expect(card).toHaveCount(1);
  await expect(card.locator(".nm")).toHaveText("Acurite-5n1/396");
  await expect(card.locator(".rs")).toHaveText("-72");
  await expect(card.locator(".val")).toHaveCount(3);
  await expect(card.locator('.val[data-f="battery_ok"]')).toHaveCount(0);
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toContainText("71.2");
  await expect(card.locator(".age")).not.toBeEmpty();
});

test("value font follows the measured box", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const sizes = await page.evaluate(() => ({
    one: valueFont(1, 150, 1), two: valueFont(2, 150, 2),
    packed: valueFont(1, 150, 4), floor: valueFont(1, 20, 1), ceil: valueFont(3, 200, 1),
  }));
  expect(sizes).toEqual({ one: "63px", two: "63px", packed: "16px", floor: "11px", ceil: "64px" });
});

test("a live update flashes the card", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  server.emit(ACURITE);
  await expect(page.locator('.card[data-key="Acurite-5n1/396"]')).toHaveClass(/flash/);
});

async function edit(page) {
  await page.click("#tab-cards");
  await page.click("#edit-cards");
  await expect(page.locator("#view-cards")).toHaveClass(/editing/);
}

test("edit mode toggles a value's visibility and persists it", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);

  await page.click(CARD + ' .val[data-f="humidity"]');
  await expect(page.locator(CARD + ' .val[data-f="humidity"]')).toHaveClass(/ghost/);
  expect((await cardState(page)).cards["Acurite-5n1/396"].hiddenValues).toContain("humidity");

  await page.click("#edit-cards");
  await expect(page.locator(CARD + ' .val[data-f="humidity"]')).toHaveCount(0);

  await page.reload();
  await page.click("#tab-cards");
  await expect(page.locator(CARD + ' .val[data-f="humidity"]')).toHaveCount(0);
});

test("hiding a value in a card smaller than its value count grows the rest", async ({ page }) => {
  await open(page, [LONGNAME]);
  await page.click("#tab-cards");
  await setSize(page, LONG_KEY, 2, 1);
  const font = () => page.locator(LONG_CARD + ' .val[data-f="temperature_F"] .fv')
    .evaluate(n => parseFloat(n.style.fontSize));

  // Seven values in two columns need four rows; hiding one drops it to three.
  const before = await font();
  await page.click("#edit-cards");
  await page.click(LONG_CARD + ' .val[data-f="rain_mm"]');
  await page.click("#edit-cards");
  expect(await font()).toBeGreaterThan(before);
});

test("hiding a card ghosts it in edit mode and drops it in normal mode", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  await page.click(CARD + " .cx");
  await expect(page.locator(CARD)).toHaveClass(/ghost/);
  await expect(page.locator("#cards .card").last()).toHaveAttribute("data-key", "Acurite-5n1/396");

  await page.click("#edit-cards");
  await expect(page.locator(CARD)).toHaveCount(0);
  expect((await cardState(page)).hidden).toEqual(["Acurite-5n1/396"]);

  await page.click("#edit-cards");
  await page.click(CARD + " .cx");
  await expect(page.locator(CARD)).not.toHaveClass(/ghost/);
  expect((await cardState(page)).hidden).toEqual([]);
});

test("renaming the label sticks, and an empty name reverts to the key", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await page.dblclick(CARD + " .nm");
  await page.fill(CARD + " .lbl input", "Roof station");
  await page.press(CARD + " .lbl input", "Enter");
  await expect(page.locator(CARD + " .nm")).toHaveText("Roof station");
  expect((await cardState(page)).cards["Acurite-5n1/396"].name).toBe("Roof station");

  await page.dblclick(CARD + " .nm");
  await page.fill(CARD + " .lbl input", "");
  await page.press(CARD + " .lbl input", "Enter");
  await expect(page.locator(CARD + " .nm")).toHaveText("Acurite-5n1/396");
});

test("a double-click inside the open rename input doesn't reset it", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await page.dblclick(CARD + " .nm");
  await page.fill(CARD + " .lbl input", "Roof station");

  await page.dblclick(CARD + " .lbl input");
  await expect(page.locator(CARD + " .lbl input")).toHaveValue("Roof station");
});

test("a long-press timer that outlives its rename doesn't reopen it", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);

  const box = await page.locator(CARD + " .nm").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();

  // Open a rename without going through this pointer's up event, e.g. a
  // second pointer double-clicking while the first is still held.
  await page.evaluate(key => {
    document.querySelector(`.card[data-key="${key}"] .lbl`)
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  }, "Acurite-5n1/396");
  await page.evaluate(() => {
    const input = document.querySelector(".lbl input");
    input.focus();
    input.value = "Roof station";
  });

  await page.waitForTimeout(700);
  await page.mouse.up();

  await expect(page.locator(CARD + " .lbl input")).toHaveCount(1);
  await expect(page.locator(CARD + " .lbl input")).toHaveValue("Roof station");
});

test("Forget layouts clears stored state and rebuilds defaults", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  await page.click(CARD + " .cx");
  expect((await cardState(page)).hidden).toEqual(["Acurite-5n1/396"]);

  page.once("dialog", d => d.accept());
  await page.click("#forget-cards");

  expect(await cardState(page)).toBeNull();
  await expect(page.locator(CARD)).not.toHaveClass(/ghost/);
  expect(await spans(page, CARD)).toEqual({ col: "span 2 auto", row: "span 2 auto" });
  await expect(page.locator("#cards .card")).toHaveCount(2);
});

async function dragTo(page, from, to) {
  const a = await page.locator(from).boundingBox();
  const b = await page.locator(to).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("dragging a card reorders the grid and persists", async ({ page }) => {
  await open(page, [ACURITE, OREGON, THERMO]);
  await edit(page);
  const keys = () => page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));
  expect(await keys()).toEqual(["Acurite-5n1/396", "Oregon-THN132N/23", "Fineoffset-WH2/174"]);

  await dragTo(page, CARD + " .lbl", '.card[data-key="Fineoffset-WH2/174"]');
  expect(await keys()).toEqual(["Oregon-THN132N/23", "Fineoffset-WH2/174", "Acurite-5n1/396"]);

  await page.reload();
  await page.click("#tab-cards");
  expect(await keys()).toEqual(["Oregon-THN132N/23", "Fineoffset-WH2/174", "Acurite-5n1/396"]);
});

test("dragging a value reorders within its card only", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  const OTHER = '.card[data-key="Oregon-THN132N/23"]';
  const fields = sel => page.locator(sel + " .val").evaluateAll(n => n.map(v => v.dataset.f));
  const before = await fields(CARD);
  const otherBefore = await fields(OTHER);
  expect(otherBefore.length).toBeGreaterThan(0);

  await dragTo(page, CARD + ' .val[data-f="temperature_F"]', CARD + ' .val[data-f="wind_avg_mi_h"]');
  const after = await fields(CARD);
  expect(after).not.toEqual(before);
  expect(after.slice().sort()).toEqual(before.slice().sort());

  expect(await fields(OTHER)).toEqual(otherBefore);
  const stored = (await cardState(page)).cards;
  expect(stored["Oregon-THN132N/23"].valueOrder).toEqual(otherBefore);
  expect(stored["Acurite-5n1/396"].hiddenValues).toEqual(["battery_ok"]);
});

test("cards are inert outside edit mode", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await page.click("#tab-cards");
  await dragTo(page, CARD + " .lbl", '.card[data-key="Oregon-THN132N/23"]');
  const keys = await page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));
  expect(keys).toEqual(["Acurite-5n1/396", "Oregon-THN132N/23"]);
});

test("a press released off the card ends the drag and rendering resumes", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);

  const box = await page.locator(CARD).boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 4, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();

  expect(await page.evaluate(() => dragging)).toBeNull();
  server.emit(OREGON);
  await expect(page.locator('.card[data-key="Oregon-THN132N/23"]')).toHaveCount(1);
});

test("a card dropped past a midpoint takes that card's slot", async ({ page }) => {
  await open(page, [ACURITE, OREGON, THERMO]);
  await edit(page);
  const keys = () => page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));

  const a = await page.locator(CARD + " .lbl").boundingBox();
  const b = await page.locator('.card[data-key="Oregon-THN132N/23"]').boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.85, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();

  expect(await keys()).toEqual(["Oregon-THN132N/23", "Acurite-5n1/396", "Fineoffset-WH2/174"]);
});

test("a card dropped past the last card lands at the end", async ({ page }) => {
  await open(page, [ACURITE, OREGON, THERMO]);
  await edit(page);
  const keys = () => page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));

  const a = await page.locator(CARD + " .lbl").boundingBox();
  const b = await page.locator('.card[data-key="Fineoffset-WH2/174"]').boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 30, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();

  expect(await keys()).toEqual(["Oregon-THN132N/23", "Fineoffset-WH2/174", "Acurite-5n1/396"]);
});

test("a live signal does not re-render mid-drag", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  const box = await page.locator(CARD + " .lbl").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 40, { steps: 5 });
  await expect(page.locator(".ghostcard")).toHaveCount(1);
  await expect(page.locator(CARD)).toHaveClass(/lifting/);
  server.emit(OREGON);
  await page.waitForTimeout(200);
  await expect(page.locator(".ghostcard")).toHaveCount(1);
  // A re-render would rebuild the card and lose the class the drag put on it.
  await expect(page.locator(CARD)).toHaveClass(/lifting/);
  await page.mouse.up();
  await expect(page.locator(".ghostcard")).toHaveCount(0);
  await expect(page.locator(CARD)).not.toHaveClass(/lifting/);
});

test("a long device name ellipsizes instead of clipping, and rssi stays whole", async ({ page }) => {
  await open(page, [LONGNAME]);
  await page.click("#tab-cards");
  await setSize(page, LONG_KEY, 1, 1);

  const card = page.locator(LONG_CARD);
  const cardBox = await card.boundingBox();
  const lblBox = await card.locator(".lbl").boundingBox();
  expect(lblBox.x).toBeGreaterThanOrEqual(cardBox.x - 2);
  expect(lblBox.x + lblBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 2);

  // The fixture's model name is long enough that the label box alone (proven
  // above to fit) could not hold it without eliding the name.
  const nmOverflows = await card.locator(".nm")
    .evaluate(n => n.scrollWidth > n.clientWidth);
  expect(nmOverflows).toBe(true);

  const rsOverflows = await card.locator(".rs")
    .evaluate(n => n.scrollWidth > n.clientWidth);
  expect(rsOverflows).toBe(false);
  await expect(card.locator(".rs")).toHaveText("-72");
});

test("values spread across the card without overflowing it", async ({ page }) => {
  await open(page, [LONGNAME]);
  await page.click("#tab-cards");

  const card = page.locator(LONG_CARD);
  const body = card.locator(".body");
  const bodyBox = await body.boundingBox();
  const boxes = await body.locator(".val").evaluateAll(nodes => nodes.map(n => {
    const r = n.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
  expect(boxes.length).toBeGreaterThan(3);
  const spanX = Math.max(...boxes.map(b => b.right)) - Math.min(...boxes.map(b => b.left));
  const spanY = Math.max(...boxes.map(b => b.bottom)) - Math.min(...boxes.map(b => b.top));
  expect(spanX).toBeGreaterThan(bodyBox.width * 0.8);
  expect(spanY).toBeGreaterThan(bodyBox.height * 0.7);

  const overflow = await card.evaluate(n => ({
    w: n.scrollWidth - n.clientWidth, h: n.scrollHeight - n.clientHeight,
  }));
  expect(overflow.w).toBeLessThanOrEqual(0);
  expect(overflow.h).toBeLessThanOrEqual(0);
});

test("displayed values are rounded and trimmed, without touching stored data", async ({ page }) => {
  await open(page, [LONGNAME]);
  await page.click("#tab-cards");

  const card = page.locator(LONG_CARD);
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toHaveText("71.2°F");
  await expect(card.locator('.val[data-f="wind_avg_mi_h"] .fv')).toHaveText("4.6mi/h");
  await expect(card.locator('.val[data-f="rain_mm"] .fv')).toHaveText("0.03mm");
  await expect(card.locator('.val[data-f="pressure_hPa"] .fv')).toHaveText("1013.3hPa");
  await expect(card.locator('.val[data-f="humidity"] .fv')).toHaveText("38%");

  const stored = await page.evaluate(k => devices.get(k).merged.temperature_F, LONG_KEY);
  expect(stored).toBeCloseTo(71.23456789, 6);
});

test("fmtValue rounds by magnitude and leaves non-numbers untouched", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const out = await page.evaluate(() => [
    fmtValue(71.234), fmtValue(4.6), fmtValue(0.0300), fmtValue(1013.25),
    fmtValue(38), fmtValue("CHECKSUM"), fmtValue(true),
  ]);
  expect(out).toEqual(["71.2", "4.6", "0.03", "1013.3", "38", "CHECKSUM", "true"]);
});

test("the grid inputs are hidden until edit mode and set the tracks", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  await expect(page.locator("#grid-size")).toBeHidden();

  await page.click("#edit-cards");
  await expect(page.locator("#grid-size")).toBeVisible();
  await expect(page.locator("#grid-cols")).toHaveValue("6");
  await expect(page.locator("#grid-rows")).toHaveValue("4");

  await page.fill("#grid-cols", "8");
  await page.locator("#grid-cols").blur();
  await page.fill("#grid-rows", "3");
  await page.locator("#grid-rows").blur();

  expect((await cardState(page)).grid).toEqual({ cols: 8, rows: 3 });
  const tracks = await page.locator("#cards").evaluate(n => ({
    cols: getComputedStyle(n).gridTemplateColumns.split(" ").length,
    rows: getComputedStyle(n).gridTemplateRows.split(" ").length,
  }));
  expect(tracks).toEqual({ cols: 8, rows: 3 });
});

test("an out-of-range or non-numeric input reverts to the last good value", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await page.fill("#grid-cols", "9");
  await page.locator("#grid-cols").blur();
  expect((await cardState(page)).grid.cols).toBe(9);

  for (const bad of ["0", "25", "-3", ""]) {
    await page.fill("#grid-cols", bad);
    await page.locator("#grid-cols").blur();
    await expect(page.locator("#grid-cols")).toHaveValue("9");
    expect((await cardState(page)).grid.cols).toBe(9);
  }
});

test("the grid size survives a reload and Forget layouts resets it", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await page.fill("#grid-rows", "7");
  await page.locator("#grid-rows").blur();

  await page.reload();
  await edit(page);
  await expect(page.locator("#grid-rows")).toHaveValue("7");

  page.once("dialog", d => d.accept());
  await page.click("#forget-cards");
  await expect(page.locator("#grid-rows")).toHaveValue("4");
  expect(await cardState(page)).toBeNull();
});
