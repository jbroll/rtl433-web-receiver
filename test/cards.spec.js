const { test, expect } = require("@playwright/test");
const { startServer } = require("./harness");
const { ACURITE, OREGON, THERMO } = require("./fixtures");

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
    cardState = { order: ["k"], hidden: [],
      cards: { k: { aspect: "sq", valueOrder: ["humidity", "temperature_F"], hiddenValues: [] } } };
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
    order: ["Acurite-5n1/396"],
    hidden: [],
    cards: {
      "Acurite-5n1/396": {
        aspect: "sq",
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
    '{"aspect":"v","valueOrder":["bogus"],"hiddenValues":["bogus"]}}}';
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
  expect(result.card.aspect).toBe("sq");
  expect(result.card.valueOrder).toEqual(["temperature_F", "humidity", "battery_ok"]);
  expect(result.card.hiddenValues).toEqual(["battery_ok"]);
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

test("value font follows cells over visible count", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const sizes = await page.evaluate(() => ({
    one: valueFont(1, 1), three: valueFont(1, 3), big: valueFont(4, 8), floor: valueFont(1, 40),
  }));
  expect(sizes.one).toBe("2.4rem");
  expect(sizes.three).toBe("1.386rem");
  expect(sizes.big).toBe("1.697rem");
  expect(sizes.floor).toBe("0.9rem");
});

test("a card with more than six visible values spans 2x2", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const cells = await page.evaluate(() => {
    cardState.cards["k"] = { aspect: "sq", valueOrder: [], hiddenValues: [] };
    return [cardCells("k", 3), cardCells("k", 7)];
  });
  expect(cells).toEqual([1, 4]);
});

test("a live update flashes the card", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  server.emit(ACURITE);
  await expect(page.locator('.card[data-key="Acurite-5n1/396"]')).toHaveClass(/flash/);
});

const CARD = '.card[data-key="Acurite-5n1/396"]';

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

test("hiding a value grows the rest", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-cards");
  const before = await page.locator(CARD + ' .val[data-f="temperature_F"] .fv').evaluate(n => n.style.fontSize);
  await page.click("#edit-cards");
  await page.click(CARD + ' .val[data-f="humidity"]');
  await page.click("#edit-cards");
  const after = await page.locator(CARD + ' .val[data-f="temperature_F"] .fv').evaluate(n => n.style.fontSize);
  expect(parseFloat(after)).toBeGreaterThan(parseFloat(before));
});

test("the aspect button cycles square, horizontal, vertical", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await page.evaluate(() => { cardState.cards["Acurite-5n1/396"].aspect = "sq"; renderCards(); });

  await page.click(CARD + " .ca");
  await expect(page.locator(CARD)).toHaveClass(/\bh\b/);
  await page.click(CARD + " .ca");
  await expect(page.locator(CARD)).toHaveClass(/\bv\b/);
  await page.click(CARD + " .ca");
  await expect(page.locator(CARD)).toHaveClass(/\bsq\b/);
  expect((await cardState(page)).cards["Acurite-5n1/396"].aspect).toBe("sq");
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
  await page.click(CARD + " .ca");
  expect((await cardState(page)).hidden).toEqual(["Acurite-5n1/396"]);

  page.once("dialog", d => d.accept());
  await page.click("#forget-cards");

  expect(await cardState(page)).toBeNull();
  await expect(page.locator(CARD)).not.toHaveClass(/ghost/);
  await expect(page.locator(CARD)).toHaveClass(/\bsq\b/);
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
