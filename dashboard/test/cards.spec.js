import { test, expect } from "@playwright/test";
import { startServer, startPage } from "./harness.js";
import { ACURITE, OREGON, THERMO, LONGNAME, FREEZER, RECEIVER, topicOf } from "./fixtures.js";

const ACURITE_KEY = topicOf(ACURITE);
const OREGON_KEY = topicOf(OREGON);
const THERMO_KEY = topicOf(THERMO);
const FREEZER_KEY = topicOf(FREEZER);
const RECEIVER_KEY = topicOf(RECEIVER);
// $= matches an unanchored tail, so this only picks one card as long as a
// spec runs a single source; a two-source test would need the full key.
// :not(.ghostcard) skips the drag ghost, which clones the card's data-key.
const CARD = `.card:not(.ghostcard)[data-key$="${ACURITE_KEY}"]`;
const LONG_KEY = topicOf(LONGNAME);
const LONG_CARD = `.card:not(.ghostcard)[data-key$="${LONG_KEY}"]`;
const shortKeyOf = payload => topicOf(payload).split("/").slice(1).join("/");

// The dashboard keys a device by its source's base URL and its topic, so a
// stored layout only matches when the port matches too.
function storeKey(server, topic) {
  return server.url.replace(/\/$/, "") + " " + topic;
}

function fullKeys(...topics) {
  return topics.map(t => storeKey(server, t));
}

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page, devices) {
  server = await startServer({ devices: devices || [] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await showEveryCard(page);
  return server;
}

// The page gives a new device no card. Tests about the cards themselves start
// from every device shown, and the ones about hiding opt back out.
async function showEveryCard(page) {
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
}

test("the served page lists devices and streams live signals", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-devices");
  await expect(page.locator("#devices tr:not(.vrow)")).toHaveCount(1);
  await expect(page.locator("#devices tr:not(.vrow)").first()).toContainText("Acurite-5n1");

  server.emit(OREGON);
  await expect(page.locator("#devices tr:not(.vrow)")).toHaveCount(2);
});

test("the devices table shows readings converted and formatted", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-devices");
  const reading = page.locator(`#devices tr:not(.vrow)[data-key$="${ACURITE_KEY}"] td`).nth(2);
  await expect(reading).toContainText("temperature: 21.8°C");
  await expect(reading).toContainText("wind avg: 7.4km/h");
  await expect(reading).toContainText("humidity: 38%");
});

test("a message with no time still renders, ages from arrival, and reaches the log", async ({ page }) => {
  await open(page, [ACURITE]);
  server.emit(OREGON, { time: null });

  await page.click("#tab-devices");
  const ageCell = page.locator(`#devices tr[data-key$="${OREGON_KEY}"] td`).nth(5);
  await expect(ageCell).not.toContainText("NaN");
  await expect(ageCell).not.toContainText("Invalid");

  await page.click("#tab-cards");
  await showEveryCard(page);
  const cardAge = page.locator(`.card[data-key$="${OREGON_KEY}"] .age`);
  await expect(cardAge).toHaveText(/^\d+[hms]/);

  await page.click("#tab-log");
  const logTime = page.locator("#logrows tr").first().locator("td").first();
  await expect(logTime).not.toContainText("NaN");
  await expect(logTime).not.toContainText("Invalid");
});

test("the page opens on Cards and switches views", async ({ page }) => {
  await open(page, [ACURITE]);
  await expect(page.locator("#view-cards")).toBeVisible();
  await expect(page.locator("#view-devices")).toBeHidden();
  await expect(page.locator("#tab-cards")).toHaveAttribute("aria-selected", "true");

  await page.click("#tab-devices");
  await expect(page.locator("#view-cards")).toBeHidden();
  await expect(page.locator("#view-devices")).toBeVisible();

  await page.click("#tab-cards");
  await expect(page.locator("#view-cards")).toBeVisible();
});

test("the page reloads when the device reports a different build", async ({ page }) => {
  await open(page, [RECEIVER]);
  await page.evaluate(() => { window.marker = 1; });
  server.emit(RECEIVER);
  await page.waitForFunction(key => devices.get(key).count === 2, storeKey(server, RECEIVER_KEY));
  expect(await page.evaluate(() => window.marker)).toBe(1);

  server.setBuild("other");
  server.emit(RECEIVER);
  await page.waitForFunction(() => window.marker === undefined);
});

test("a newly seen device gets no card until its box is checked", async ({ page }) => {
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/live/);
  await expect(page.locator("#cards .card")).toHaveCount(0);

  await page.click("#tab-devices");
  await expect(page.locator("#devices tr:not(.vrow)")).toHaveCount(1);
  const box = page.locator(`#devices tr[data-key$="${ACURITE_KEY}"] input[type=checkbox]`);
  await expect(box).not.toBeChecked();
  await box.check();

  await page.click("#tab-cards");
  await expect(page.locator(CARD)).toHaveCount(1);
});

test("the device table's checkbox shows and hides that device's card", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await expect(page.locator("#cards .card")).toHaveCount(2);

  await page.click("#tab-devices");
  const box = page.locator(`#devices tr[data-key$="${ACURITE_KEY}"] input[type=checkbox]`);
  await expect(box).toBeChecked();
  await box.uncheck();

  await page.click("#tab-cards");
  await expect(page.locator("#cards .card")).toHaveCount(1);
  await expect(page.locator(CARD)).toHaveCount(0);
  expect((await cardState(page)).hidden).toContain(storeKey(server, ACURITE_KEY));

  await page.click("#tab-devices");
  await box.check();
  await page.click("#tab-cards");
  await expect(page.locator(CARD)).toHaveCount(1);
});

test("the receiver's own card is shown without checking a box", async ({ page }) => {
  server = await startServer({ devices: [ACURITE, RECEIVER] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/live/);

  await expect(page.locator("#cards .card")).toHaveCount(1);
  const card = page.locator(`.card[data-key$="${RECEIVER_KEY}"]`);
  await expect(card.locator(".nm")).toHaveText("Receiver/0");
  await expect(card.locator('.val[data-f="noise_dBm"] .fn')).toHaveText("noise");
  await expect(card.locator('.val[data-f="noise_dBm"] .u')).toHaveText("dBm");
  await expect(card.locator('.val[data-f="heap_kB"] .u')).toHaveText("kB");
  await expect(card.locator('.val[data-f="radio_C"] .u')).toHaveText("°C");

  await page.click("#tab-log");
  await expect(page.locator("#logrows tr")).toHaveCount(1);
  await expect(page.locator("#logrows")).not.toContainText("Receiver");
});

test("a device the user never showed is dropped once it is gone", async ({ page }) => {
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/live/);
  server.emit(OREGON);
  await expect(page.locator("#devices tr")).toHaveCount(0); // the tab is hidden

  // Show one of them, then drop both from the device table and save.
  await page.click("#tab-devices");
  await page.locator(`#devices tr[data-key$="${ACURITE_KEY}"] input[type=checkbox]`).check();
  const stored = await page.evaluate(() => {
    devices.clear();
    saveCardState();
    return cardState;
  });
  expect(stored.order).toEqual([storeKey(server, ACURITE_KEY)]);
  expect(Object.keys(stored.cards)).toEqual([storeKey(server, ACURITE_KEY)]);
  expect(stored.hidden).toEqual([]);
});

test("an alias published on the stream names the card and the device table's box", async ({ page }) => {
  await open(page, [ACURITE]);
  server.emitAlias(ACURITE_KEY, "Back yard");
  await expect(page.locator(`${CARD} .nm`)).toHaveText("Back yard");

  await page.click("#tab-devices");
  await expect(page.locator(`#devices tr[data-key$="${ACURITE_KEY}"] input[type=text]`))
    .toHaveValue("Back yard");

  server.emitAlias(ACURITE_KEY, "");
  await page.click("#tab-cards");
  await expect(page.locator(`${CARD} .nm`)).toHaveText("Acurite-5n1/396");
});

test("an alias published by the source survives a reload", async ({ page }) => {
  await open(page, [ACURITE]);
  server.emitAlias(ACURITE_KEY, "Back yard");
  await expect(page.locator(`${CARD} .nm`)).toHaveText("Back yard");

  await page.reload();
  await expect(page.locator("#status")).toHaveText(/live/);
  await expect(page.locator(`${CARD} .nm`)).toHaveText("Back yard");
});

test("a card takes the name published for its topic", async ({ page }) => {
  await open(page, [ACURITE]);
  server.emitAlias(topicOf(ACURITE), "Back fence");
  await expect(page.locator(CARD + " .nm")).toHaveText("Back fence");

  server.emitAlias(topicOf(ACURITE), "");
  await expect(page.locator(CARD + " .nm")).toHaveText(shortKeyOf(ACURITE));
});

test("renaming a card posts an alias", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#edit-cards");
  await page.dblclick(CARD + " .lbl");
  await page.fill(CARD + " .lbl input", "Back fence");
  await page.press(CARD + " .lbl input", "Enter");

  await expect.poll(async () => (await server.get(topicOf(ACURITE) + "/$alias")).body)
    .toBe(JSON.stringify("Back fence"));
});

test("clearing the device table's alias field removes the alias", async ({ page }) => {
  await open(page, [ACURITE]);
  server.emitAlias(topicOf(ACURITE), "Back fence");
  await page.click("#tab-devices");
  const field = page.locator('#devices tr[data-key$="' + topicOf(ACURITE) + '"] input[type=text]');
  await expect(field).toHaveValue("Back fence");

  await field.fill("");
  await field.blur();
  await expect.poll(async () => (await server.get(topicOf(ACURITE) + "/$alias")).status)
    .toBe(404);
});

test("hiding a card in edit mode unchecks it in the device table", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#edit-cards");
  await page.click(`${CARD} .cx`);

  await page.click("#tab-devices");
  await expect(page.locator(`#devices tr[data-key$="${ACURITE_KEY}"] input[type=checkbox]`))
    .not.toBeChecked();
});

async function cardState(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("rtl433.dashboard.v1") || "null"));
}

async function setSize(page, key, w, h) {
  await page.evaluate(([k, w, h]) => {
    setCardSize(k, w, h);
  }, [storeKey(server, key), w, h]);
}

async function setGrid(page, cols, rows) {
  await page.evaluate(([c, r]) => {
    setGrid('cols', c);
    setGrid('rows', r);
  }, [cols, rows]);
}

function mode(page, key, field) {
  return page.locator(`#devices tr.vrow[data-key$="${key}"][data-f="${field}"] select`);
}

function spans(page, sel) {
  return page.locator(sel).evaluate(n => {
    const s = getComputedStyle(n);
    return { col: s.gridColumnStart + " " + s.gridColumnEnd, row: s.gridRowStart + " " + s.gridRowEnd };
  });
}

test("a new device gets defaults: appended, visible, status fields at the bottom", async ({ page }) => {
  await open(page, [ACURITE]);

  // A key distinct from ACURITE's: rendering already seeds a card for every
  // loaded device, so reusing that key would no longer be "new" by this point.
  const state = await page.evaluate(() => {
    const merged = { temperature_F: 71.2, humidity: 38, battery_ok: 1, wind_avg_mi_h: 4.6 };
    ensureCard("New-Device/1", merged);
    saveCardState();
    return { s: cardState, vis: visibleValues("New-Device/1", merged) };
  });

  expect(state.s.order).toEqual([storeKey(server, ACURITE_KEY), "New-Device/1"]);
  expect(state.s.cards["New-Device/1"].hiddenValues).toEqual([]);
  expect(state.s.cards["New-Device/1"].bottomValues).toEqual(["battery_ok"]);
  expect(state.s.cards["New-Device/1"].valueOrder)
    .toEqual(["temperature_F", "humidity", "battery_ok", "wind_avg_mi_h"]);
  expect(state.vis).toEqual(["temperature_F", "humidity", "wind_avg_mi_h"]);
});

test("a field added later appends without disturbing stored order", async ({ page }) => {
  await open(page, [ACURITE]);
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
  await page.evaluate(() => localStorage.setItem("rtl433.dashboard.v1", "{not json"));
  await page.reload();
  await expect(page.locator("#status")).toHaveText(/live/);

  const s = await page.evaluate(() => cardState);
  expect(s).toEqual({
    grid: { cols: 6, rows: 4 },
    order: [storeKey(server, ACURITE_KEY)],
    hidden: [storeKey(server, ACURITE_KEY)],
    cards: {
      [storeKey(server, ACURITE_KEY)]: {
        w: 2, h: 2,
        valueOrder: ["battery_ok", "wind_avg_mi_h", "temperature_F", "humidity"],
        hiddenValues: [],
        bottomValues: ["battery_ok"],
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
  await page.evaluate((p) => localStorage.setItem("rtl433.dashboard.v1", p), payload);
  await page.reload();
  await expect(page.locator("#status")).toHaveText(/live/);

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
  expect(result.card.hiddenValues).toEqual([]);
  expect(result.card.bottomValues).toEqual(["battery_ok"]);
});

test("default card size packs values into the most compact rectangle", async ({ page }) => {
  await open(page, [ACURITE]);
  const sizes = await page.evaluate(() =>
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => { const s = defaultSize(n); return [s.w, s.h]; }));
  expect(sizes).toEqual([[1, 1], [2, 1], [2, 2], [2, 2], [3, 2], [3, 2], [3, 3], [3, 3], [3, 3]]);
});

test("an Acurite 5n1 with three readings defaults to 2x2", async ({ page }) => {
  await open(page, [ACURITE]);
  const c = (await page.evaluate(() => cardState)).cards[storeKey(server, ACURITE_KEY)];
  expect([c.w, c.h]).toEqual([2, 2]);
  expect(await spans(page, CARD)).toEqual({ col: "span 2 auto", row: "span 2 auto" });
});

test("the cell side is the smaller of the two divisions and re-measures on resize", async ({ page }) => {
  await open(page, [ACURITE]);
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

test("an entry with no stored size is sized from its value count", async ({ page }) => {
  await open(page, [LONGNAME]);
  await page.evaluate(k => localStorage.setItem("rtl433.dashboard.v1", JSON.stringify({
    order: [k], hidden: [], cards: { [k]: { valueOrder: [], hiddenValues: [] } },
  })), storeKey(server, LONG_KEY));
  await page.reload();
  await page.click("#tab-cards");

  // Eight readings, battery_ok hidden as a status field, leaves seven visible.
  const c = (await page.evaluate(() => cardState)).cards[storeKey(server, LONG_KEY)];
  expect([c.w, c.h]).toEqual([3, 3]);
});

test("a card renders label, visible values, rssi and age", async ({ page }) => {
  await open(page, [ACURITE]);

  const card = page.locator(`.card[data-key$="${ACURITE_KEY}"]`);
  await expect(card).toHaveCount(1);
  await expect(card.locator(".nm")).toHaveText("Acurite-5n1/396");
  await expect(card.locator(".rs")).toHaveText("-72");
  await expect(card.locator(".val")).toHaveCount(3);
  await expect(card.locator('.val[data-f="battery_ok"]')).toHaveCount(0);
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toContainText("21.8");
  await expect(card.locator(".age")).not.toBeEmpty();
});

test("value font follows the measured box", async ({ page }) => {
  await open(page, [ACURITE]);
  const sizes = await page.evaluate(() => ({
    one: valueFont(1, 150, 1), two: valueFont(2, 150, 2),
    packed: valueFont(1, 150, 4), floor: valueFont(1, 20, 1), ceil: valueFont(3, 200, 1),
  }));
  expect(sizes).toEqual({ one: "60px", two: "60px", packed: "15px", floor: "11px", ceil: "64px" });
});

test("resizing while scrolled fits to the same font as a fresh load", async ({ page }) => {
  await open(page, [ACURITE]);
  const font = () => page.locator(CARD + " .fv").first().evaluate(n => getComputedStyle(n).fontSize);
  await page.evaluate(() => {
    document.body.style.minHeight = "4000px";
    window.scrollTo(0, 250);
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  const resized = await font();

  await page.reload();
  await expect(page.locator("#status")).toHaveText(/live/);
  await showEveryCard(page);
  const reloaded = await font();

  expect(resized).toBe(reloaded);
});

test("a live update flashes the card", async ({ page }) => {
  await open(page, [ACURITE]);
  server.emit(ACURITE);
  await expect(page.locator(`.card[data-key$="${ACURITE_KEY}"]`)).toHaveClass(/flash/);
});

async function edit(page) {
  await page.click("#tab-cards");
  await page.click("#edit-cards");
  await expect(page.locator("#view-cards")).toHaveClass(/editing/);
}

async function activeZones(page) {
  return page.evaluate(() => ({
    card: document.querySelectorAll('.drop-layer.card-layer .drop-zone.active').length,
    value: document.querySelectorAll('.drop-layer.value-layer .drop-zone.active').length,
  }));
}

test("the devices tab sets a value's display mode", async ({ page }) => {
  await open(page, [ACURITE]);
  const stored = async () => (await cardState(page)).cards[storeKey(server, ACURITE_KEY)];
  const body = page.locator(CARD + ' .val[data-f="humidity"]');
  const strip = page.locator(CARD + ' .btm');

  await page.click("#tab-devices");
  await mode(page, ACURITE_KEY, "humidity").selectOption("bottom");
  await page.click("#tab-cards");
  await expect(body).toHaveCount(0);
  await expect(strip).toContainText("humidity");
  expect((await stored()).bottomValues).toContain("humidity");

  await page.click("#tab-devices");
  await mode(page, ACURITE_KEY, "humidity").selectOption("hidden");
  await page.click("#tab-cards");
  await expect(strip).not.toContainText("humidity");
  expect((await stored()).hiddenValues).toEqual(["humidity"]);

  await page.reload();
  await expect(page.locator("#status")).toHaveText(/live/);
  await expect(page.locator(CARD + ' .val[data-f="humidity"]')).toHaveCount(0);
  await page.click("#tab-devices");
  await expect(mode(page, ACURITE_KEY, "humidity")).toHaveValue("hidden");

  await mode(page, ACURITE_KEY, "humidity").selectOption("shown");
  await page.click("#tab-cards");
  await expect(page.locator(CARD + ' .val[data-f="humidity"]')).toHaveCount(1);
});

test("the mode a card shows a value in matches its row in the devices tab", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-devices");
  expect(await mode(page, ACURITE_KEY, "battery_ok").inputValue()).toBe("bottom");
  expect(await mode(page, ACURITE_KEY, "temperature_F").inputValue()).toBe("shown");
  await expect(page.locator(`#devices tr.vrow[data-key$="${ACURITE_KEY}"]`)).toHaveCount(4);
});

test("hiding a value in a card smaller than its value count grows the rest", async ({ page }) => {
  await open(page, [LONGNAME]);
  await setSize(page, LONG_KEY, 2, 1);
  const font = () => page.locator(LONG_CARD + ' .val[data-f="temperature_F"] .fv')
    .evaluate(n => parseFloat(n.style.fontSize));

  // Seven values in two columns need four rows; hiding one drops it to three.
  const before = await font();
  await page.click("#tab-devices");
  await mode(page, LONG_KEY, "rain_mm").selectOption("hidden");
  await page.click("#tab-cards");
  expect(await font()).toBeGreaterThan(before);
});

test("hiding a card drops it in edit mode as well as normal mode", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  await page.click(CARD + " .cx");
  await expect(page.locator(CARD)).toHaveCount(0);
  await expect(page.locator("#cards .card")).toHaveCount(1);
  expect((await cardState(page)).hidden).toEqual([storeKey(server, ACURITE_KEY)]);

  await page.click("#edit-cards");
  await expect(page.locator(CARD)).toHaveCount(0);
  await expect(page.locator("#cards .card")).toHaveCount(1);
});

// The card is gone from the grid, so its own ✕ can no longer bring it back.
test("the devices tab is what re-enables a hidden card", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  await page.click(CARD + " .cx");
  await expect(page.locator(CARD)).toHaveCount(0);

  await page.click("#tab-devices");
  await page.locator(`#devices tr:not(.vrow)[data-key$="${ACURITE_KEY}"] input[type=checkbox]`)
    .check();
  await page.click("#tab-cards");
  await expect(page.locator(CARD)).toHaveCount(1);
  expect((await cardState(page)).hidden).toEqual([]);
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
    document.querySelector(`.card[data-key$="${key}"] .lbl`)
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  }, ACURITE_KEY);
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
  expect((await cardState(page)).hidden).toEqual([storeKey(server, ACURITE_KEY)]);

  page.once("dialog", d => d.accept());
  await page.click("#forget-cards");

  expect(await cardState(page)).toBeNull();
  expect(await spans(page, CARD)).toEqual({ col: "span 2 auto", row: "span 2 auto" });
  await expect(page.locator("#cards .card")).toHaveCount(2);
});

test("Forget layouts leaves the devices it can see on the dashboard", async ({ page }) => {
  // Without the override: the re-seed must not put every device straight back
  // under the hide-new rule, which would blank the grid instead of resetting it.
  server = await startServer({ devices: [ACURITE, OREGON] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/live/);
  await page.click("#tab-devices");
  await page.locator(`#devices tr[data-key$="${ACURITE_KEY}"] input[type=checkbox]`).check();
  await page.click("#tab-cards");
  await expect(page.locator("#cards .card")).toHaveCount(1);

  await page.click("#edit-cards");
  page.once("dialog", d => d.accept());
  await page.click("#forget-cards");
  await page.click("#edit-cards");

  await expect(page.locator("#cards .card")).toHaveCount(2);
  // Nothing has been saved yet: forgetting cleared the key and re-seeding alone
  // does not write, so the live state is what says the cards are shown.
  expect(await page.evaluate(() => cardState.hidden)).toEqual([]);
});

test("an open rename survives the render tick", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#edit-cards");
  await page.dblclick(CARD + " .lbl");
  const input = page.locator(CARD + " .lbl input");
  await input.fill("Roof");
  await page.waitForTimeout(1300); // longer than the one second render tick
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("Roof");
});

test("committing a rename closes the input and shows the new name", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await page.dblclick(CARD + " .lbl");
  await page.fill(CARD + " .lbl input", "Roof station");
  await page.press(CARD + " .lbl input", "Enter");
  // Short enough that the 1s render tick can't be what closes the input.
  await expect(page.locator(CARD + " .lbl input")).toHaveCount(0, { timeout: 400 });
  await expect(page.locator(CARD + " .nm")).toHaveText("Roof station");
});

test("the device table keeps up after a checkbox takes focus", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-devices");
  await page.locator(`#devices tr[data-key$="${ACURITE_KEY}"] input[type=checkbox]`).uncheck();

  server.emit(OREGON);
  await expect(page.locator("#devices tr:not(.vrow)")).toHaveCount(2);
});

test("a card renders the same in edit mode as out of it", async ({ page }) => {
  await open(page, [ACURITE]);
  const shape = () => page.locator(CARD).evaluate(n => ({
    values: [...n.querySelectorAll(".val")].map(v => v.dataset.f),
    font: n.querySelector(".fv").style.fontSize,
    bottom: n.querySelector(".btm").textContent,
  }));
  const before = await shape();

  await page.click("#edit-cards");
  expect(await shape()).toEqual(before);
  await page.click(CARD + ' .val[data-f="humidity"]');
  expect(await shape()).toEqual(before);
  expect((await cardState(page)).cards[storeKey(server, ACURITE_KEY)].hiddenValues).toEqual([]);
});

test("a bottom value carries its label, reading and unit", async ({ page }) => {
  await open(page, [ACURITE]);
  await page.click("#tab-devices");
  await mode(page, ACURITE_KEY, "temperature_F").selectOption("bottom");
  await page.click("#tab-cards");

  const strip = page.locator(CARD + " .btm");
  await expect(strip.locator(".bn").last()).toHaveText("temperature");
  await expect(strip.locator(".bv").last()).toHaveText("21.8°C");
  await expect(page.locator(CARD + ' .val[data-f="temperature_F"]')).toHaveCount(0);
});

test("dismissing the Forget layouts prompt keeps the layout", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  await page.click(CARD + " .cx");

  let asked = "";
  page.once("dialog", d => { asked = d.message(); d.dismiss(); });
  await page.click("#forget-cards");

  expect(asked).toContain("Forget");
  expect((await cardState(page)).hidden).toEqual([storeKey(server, ACURITE_KEY)]);
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
  expect(await keys()).toEqual(fullKeys(ACURITE_KEY, OREGON_KEY, THERMO_KEY));

  const from = await page.locator(CARD + " .lbl").boundingBox();
  const b = await page.locator(`.card[data-key$="${THERMO_KEY}"]`).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 30, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  expect(await keys()).toEqual(fullKeys(OREGON_KEY, THERMO_KEY, ACURITE_KEY));

  await page.reload();
  await page.click("#tab-cards");
  expect(await keys()).toEqual(fullKeys(OREGON_KEY, THERMO_KEY, ACURITE_KEY));
});

test("a card dropped before the first card lands at the start", async ({ page }) => {
  await open(page, [ACURITE, OREGON, THERMO]);
  await edit(page);
  const keys = () => page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));

  const a = await page.locator(`.card[data-key$="${THERMO_KEY}"] .lbl`).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(0, a.y + a.height / 2, { steps: 12 });
  await page.mouse.up();

  expect(await keys()).toEqual(fullKeys(THERMO_KEY, ACURITE_KEY, OREGON_KEY));
});

test("card drag shows only card-level drop zones", async ({ page }) => {
  await open(page, [ACURITE, OREGON, THERMO]);
  await edit(page);
  const box = await page.locator(CARD + " .lbl").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 40, { steps: 5 });

  await expect(page.locator(".drop-layer")).toHaveCount(1);
  const zones = await activeZones(page);
  expect(zones.card).toBe(1);
  expect(zones.value).toBe(0);
  await expect(page.locator(".ghostcard.card-ghost")).toHaveCount(1);
  await expect(page.locator(".ghostcard.value-ghost")).toHaveCount(0);
  await expect(page.locator(".ghostcard.card-ghost .lbl")).toHaveCount(1);
  await expect(page.locator(".ghostcard.card-ghost .fv").first()).toHaveCount(1);

  await page.mouse.up();
  await expect(page.locator(".drop-layer")).toHaveCount(0);
});

test("value drag shows only value-level drop zones in the source card", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  const from = await page.locator(CARD + ' .val[data-f="temperature_F"]').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 20, { steps: 5 });

  await expect(page.locator(".drop-layer")).toHaveCount(1);
  const zones = await activeZones(page);
  expect(zones.card).toBe(0);
  expect(zones.value).toBe(1);
  await expect(page.locator(".ghostcard.value-ghost")).toHaveCount(1);
  await expect(page.locator(".ghostcard.card-ghost")).toHaveCount(0);
  await expect(page.locator(".ghostcard.value-ghost .fv")).toHaveCount(1);

  await page.mouse.up();
  await expect(page.locator(".drop-layer")).toHaveCount(0);
});

test("dragging a value reorders within its card only", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  const OTHER = `.card[data-key$="${OREGON_KEY}"]`;
  const fields = sel => page.locator(sel + " .val").evaluateAll(n => n.map(v => v.dataset.f));
  const before = await fields(CARD);
  const otherBefore = await fields(OTHER);
  expect(otherBefore.length).toBeGreaterThan(0);
  const otherOrder = await page.evaluate(
    k => cardState.cards[k].valueOrder.slice(), storeKey(server, OREGON_KEY));

  await dragTo(page, CARD + ' .val[data-f="temperature_F"]', CARD + ' .val[data-f="wind_avg_mi_h"]');
  const after = await fields(CARD);
  expect(after).not.toEqual(before);
  expect(after.slice().sort()).toEqual(before.slice().sort());

  expect(await fields(OTHER)).toEqual(otherBefore);
  const stored = (await cardState(page)).cards;
  expect(stored[storeKey(server, OREGON_KEY)].valueOrder).toEqual(otherOrder);
  expect(stored[storeKey(server, ACURITE_KEY)].bottomValues).toEqual(["battery_ok"]);
});

test("cards are inert outside edit mode", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await dragTo(page, CARD + " .lbl", `.card[data-key$="${OREGON_KEY}"]`);
  const keys = await page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));
  expect(keys).toEqual(fullKeys(ACURITE_KEY, OREGON_KEY));
});

test("edit mode blocks text selection", async ({ page }) => {
  await open(page, [ACURITE]);
  const sel = () => page.evaluate(() => ({
    view: getComputedStyle(document.getElementById("view-cards")).userSelect,
    card: getComputedStyle(document.querySelector("#view-cards .card")).userSelect,
  }));
  expect((await sel()).view).toBe("auto");
  await edit(page);
  expect((await sel()).view).toBe("none");
  expect((await sel()).card).toBe("none");
});

test("native drag is suppressed only in edit mode", async ({ page }) => {
  await open(page, [ACURITE]);
  const blocked = () => page.evaluate(() => {
    const card = document.querySelector("#view-cards .card");
    const ev = new DragEvent("dragstart", { bubbles: true, cancelable: true });
    card.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(await blocked()).toBe(false);
  await edit(page);
  expect(await blocked()).toBe(true);
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
  await expect(page.locator(`.card[data-key$="${OREGON_KEY}"]`)).toHaveCount(1);
});

test("a card dropped in the slot between two cards lands between them", async ({ page }) => {
  await open(page, [ACURITE, OREGON, THERMO]);
  await edit(page);
  const keys = () => page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));

  const a = await page.locator(CARD + " .lbl").boundingBox();
  const b = await page.locator(`.card[data-key$="${OREGON_KEY}"]`).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.85, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();

  expect(await keys()).toEqual(fullKeys(OREGON_KEY, ACURITE_KEY, THERMO_KEY));
});

test("a card dropped past the last card lands at the end", async ({ page }) => {
  await open(page, [ACURITE, OREGON, THERMO]);
  await edit(page);
  const keys = () => page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));

  const a = await page.locator(CARD + " .lbl").boundingBox();
  const b = await page.locator(`.card[data-key$="${THERMO_KEY}"]`).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 30, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();

  expect(await keys()).toEqual(fullKeys(OREGON_KEY, THERMO_KEY, ACURITE_KEY));
});

test("a card dropped in the slot before itself stays put", async ({ page }) => {
  await open(page, [ACURITE, OREGON, THERMO]);
  await edit(page);
  const keys = () => page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));

  const oregon = await page.locator(`.card[data-key$="${OREGON_KEY}"]`).boundingBox();
  const from = await page.locator(`.card[data-key$="${OREGON_KEY}"] .lbl`).boundingBox();
  const acurite = await page.locator(CARD).boundingBox();
  const slotX = (acurite.x + acurite.width + oregon.x) / 2;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(slotX, oregon.y + oregon.height / 2, { steps: 12 });
  await page.mouse.up();

  expect(await keys()).toEqual(fullKeys(ACURITE_KEY, OREGON_KEY, THERMO_KEY));
});

test("a drop beside a tall last card's right edge goes to the end, not the row gap", async ({ page }) => {
  await open(page, [ACURITE, THERMO, OREGON, RECEIVER, LONGNAME]);
  await edit(page);
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#cards .card")];
    setCardSize(cards[0].dataset.key, 2, 2);
    setCardSize(cards[1].dataset.key, 2, 1);
    setCardSize(cards[2].dataset.key, 2, 1);
    setCardSize(cards[3].dataset.key, 2, 2);
    setCardSize(cards[4].dataset.key, 3, 3);
  });
  const keys = () => page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));

  const big = await page.locator(`.card[data-key$="${LONG_KEY}"]`).boundingBox();
  const from = await page.locator(CARD + " .lbl").boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(big.x + big.width + 20, big.y + 30, { steps: 12 });
  await page.mouse.up();

  expect(await keys()).toEqual(fullKeys(THERMO_KEY, OREGON_KEY, RECEIVER_KEY, LONG_KEY, ACURITE_KEY));
});

test("a card dropped into the empty bottom row beside a tall card moves there", async ({ page }) => {
  await open(page, [ACURITE, OREGON, RECEIVER, LONGNAME]);
  await setGrid(page, 6, 2);
  await setSize(page, ACURITE_KEY, 2, 1);
  await setSize(page, OREGON_KEY, 2, 1);
  await setSize(page, RECEIVER_KEY, 1, 1);
  await setSize(page, LONG_KEY, 3, 2);
  await page.evaluate(k => {
    cardState.cards[k].hiddenValues = ["radio_C", "noise_dBm", "heap_kB"];
    saveCardState();
  }, storeKey(server, RECEIVER_KEY));
  await edit(page);

  const REC = `.card:not(.ghostcard)[data-key$="${RECEIVER_KEY}"]`;
  const from = await page.locator(REC + " .lbl").boundingBox();
  const before = await page.locator(REC).boundingBox();
  const tall = await page.locator(LONG_CARD).boundingBox();
  const grid = await page.locator("#cards").boundingBox();

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // The empty bottom-right cell, beyond the tall card's right edge.
  await page.mouse.move(grid.x + grid.width - 10, tall.y + tall.height / 2, { steps: 12 });
  await page.mouse.up();

  const after = await page.locator(REC).boundingBox();
  // Dense packing would backfill the card into its old top-row cell and the
  // reorder would look like nothing happened; sparse flow moves it to the
  // bottom row the drop targeted.
  expect(after.y).toBeGreaterThan(before.y + before.height / 2);
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

test("the label straddling the top border is not clipped by the card", async ({ page }) => {
  await open(page, [ACURITE]);

  const painted = await page.locator(`${CARD} .nm`).evaluate(n => {
    const r = n.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 1);
    return hit === n || n.contains(hit);
  });
  expect(painted).toBe(true);
});

test("a long device name ellipsizes instead of clipping, and rssi stays whole", async ({ page }) => {
  await open(page, [LONGNAME]);
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
});

test("no card overflows its box at any size or value count", async ({ page }) => {
  await open(page, [LONGNAME, ACURITE, OREGON]);
  await page.click("#tab-cards");
  await setGrid(page, 6, 4);

  const overflow = sel => page.locator(sel).evaluate(n => ({
    w: n.scrollWidth - n.clientWidth, h: n.scrollHeight - n.clientHeight,
  }));

  for (const [key, sel] of [[LONG_KEY, LONG_CARD], [ACURITE_KEY, CARD],
                            [OREGON_KEY, `.card[data-key$="${OREGON_KEY}"]`]]) {
    for (const [w, h] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 2], [3, 3], [6, 4]]) {
      await setSize(page, key, w, h);
      const card = await overflow(sel);
      expect(card.w, `${key} ${w}x${h} card width`).toBeLessThanOrEqual(0);
      expect(card.h, `${key} ${w}x${h} card height`).toBeLessThanOrEqual(0);
      const body = await overflow(sel + " .body");
      expect(body.w, `${key} ${w}x${h} body width`).toBeLessThanOrEqual(0);
      expect(body.h, `${key} ${w}x${h} body height`).toBeLessThanOrEqual(0);
    }
  }
});

test("displayed values are rounded and trimmed, without touching stored data", async ({ page }) => {
  await open(page, [LONGNAME]);

  const card = page.locator(LONG_CARD);
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toHaveText("71.2°F");
  await expect(card.locator('.val[data-f="wind_avg_mi_h"] .fv')).toHaveText("4.6mi/h");
  await expect(card.locator('.val[data-f="rain_mm"] .fv')).toHaveText("0.03mm");
  await expect(card.locator('.val[data-f="pressure_hPa"] .fv')).toHaveText("1013.3hPa");
  await expect(card.locator('.val[data-f="humidity"] .fv')).toHaveText("38%");

  const stored = await page.evaluate(
    k => devices.get(k).merged.temperature_F, storeKey(server, LONG_KEY));
  expect(stored).toBeCloseTo(71.23456789, 6);
});

test("fmtValue rounds to fixed decimals and trims trailing zeros", async ({ page }) => {
  await open(page, [ACURITE]);
  const out = await page.evaluate(() => [
    fmtValue(71.234, 1), fmtValue(4.6, 2), fmtValue(0.0300, 3), fmtValue(1013.25, 1),
    fmtValue(38, 0), fmtValue("CHECKSUM", 2), fmtValue(true, 2),
    fmtValue(-12.345, 1), fmtValue(-4.5678, 2), fmtValue(-0.004, 1), fmtValue(-1013.25, 1),
  ]);
  expect(out).toEqual(["71.2", "4.6", "0.03", "1013.3", "38", "CHECKSUM", "true",
                      "-12.3", "-4.57", "0", "-1013.3"]);
});

test("a below-zero reading renders with its sign and unit", async ({ page }) => {
  await open(page, [FREEZER]);
  const card = page.locator(`.card[data-key$="${FREEZER_KEY}"]`);
  await expect(card.locator('.val[data-f="temperature_C"] .fv')).toHaveText("-12.3°C");
  await expect(card.locator('.val[data-f="temperature_F"] .fv')).toHaveText("-4.57°F");
});

test("the grid inputs are hidden until edit mode and set the tracks", async ({ page }) => {
  await open(page, [ACURITE]);
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

async function dragHandle(page, sel, dx, dy) {
  const box = await page.locator(sel + " .rz").boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

test("the resize handle only appears in edit mode", async ({ page }) => {
  await open(page, [ACURITE]);
  await expect(page.locator(CARD + " .rz")).toBeHidden();
  await page.click("#edit-cards");
  await expect(page.locator(CARD + " .rz")).toBeVisible();
});

test("a tap on the resize handle with no movement leaves the stored size untouched", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await setGrid(page, 3, 3);
  await setSize(page, ACURITE_KEY, 6, 4);
  await page.evaluate(() => saveCardState());
  expect(await spans(page, CARD)).toEqual({ col: "span 3 auto", row: "span 3 auto" });

  const box = await page.locator(CARD + " .rz").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  const c = (await cardState(page)).cards[storeKey(server, ACURITE_KEY)];
  expect([c.w, c.h]).toEqual([6, 4]);
});

test("a resize starting from a clamped render moves relative to the stored size", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await setGrid(page, 3, 3);
  await setSize(page, ACURITE_KEY, 6, 4);
  await page.evaluate(() => saveCardState());
  const cell = await page.evaluate(() => cellSide);

  // Drawn width is clamped to 3; dragging left by one cell from a baseline of
  // the stored 6 still clamps at the grid's 3 columns, not below it.
  await dragHandle(page, CARD, -cell, 0);

  const c = (await cardState(page)).cards[storeKey(server, ACURITE_KEY)];
  expect(c.w).toBe(3);
  expect(await spans(page, CARD)).toEqual({ col: "span 3 auto", row: "span " + c.h + " auto" });
});

test("dragging the corner snaps to whole cells and persists", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  const cell = await page.evaluate(() => cellSide);

  await dragHandle(page, CARD, cell, cell);
  expect(await spans(page, CARD)).toEqual({ col: "span 3 auto", row: "span 3 auto" });
  const c = (await cardState(page)).cards[storeKey(server, ACURITE_KEY)];
  expect([c.w, c.h]).toEqual([3, 3]);

  await page.reload();
  await page.click("#tab-cards");
  expect(await spans(page, CARD)).toEqual({ col: "span 3 auto", row: "span 3 auto" });
});

test("a resize clamps at one cell and at the grid's own dimensions", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  await setGrid(page, 6, 4);

  await dragHandle(page, CARD, -4000, -4000);
  let c = (await cardState(page)).cards[storeKey(server, ACURITE_KEY)];
  expect([c.w, c.h]).toEqual([1, 1]);

  await dragHandle(page, CARD, 4000, 4000);
  c = (await cardState(page)).cards[storeKey(server, ACURITE_KEY)];
  expect([c.w, c.h]).toEqual([6, 4]);
});

test("a drag on the handle moves neither the card nor a value", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);
  const cell = await page.evaluate(() => cellSide);
  const fieldsBefore = await page.locator(CARD + " .val").evaluateAll(n => n.map(v => v.dataset.f));

  await dragHandle(page, CARD, cell, 0);

  const keys = await page.locator("#cards .card").evaluateAll(n => n.map(c => c.dataset.key));
  expect(keys).toEqual(fullKeys(ACURITE_KEY, OREGON_KEY));
  expect(await page.locator(CARD + " .val").evaluateAll(n => n.map(v => v.dataset.f))).toEqual(fieldsBefore);
  await expect(page.locator(".ghostcard")).toHaveCount(0);

  const c = (await cardState(page)).cards[storeKey(server, ACURITE_KEY)];
  expect(c.w).toBeGreaterThan(2);
  expect(await spans(page, CARD)).toEqual({ col: "span 3 auto", row: "span 2 auto" });
});

test("a card resized larger renders larger type", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);
  const cell = await page.evaluate(() => cellSide);
  const font = () => page.locator(CARD + ' .val[data-f="temperature_F"] .fv')
    .evaluate(n => parseFloat(n.style.fontSize));

  await dragHandle(page, CARD, -4000, -4000);
  expect(await spans(page, CARD)).toEqual({ col: "span 1 auto", row: "span 1 auto" });
  const small = await font();

  await dragHandle(page, CARD, 3 * cell, 3 * cell);
  expect(await spans(page, CARD)).toEqual({ col: "span 4 auto", row: "span 4 auto" });
  expect(await font()).toBeGreaterThan(small);
});

test("a value shrinks to fit its box instead of ellipsizing", async ({ page }) => {
  await open(page, [ACURITE, OREGON, LONGNAME]);
  await page.click("#tab-cards");

  const clipped = () => page.evaluate(() =>
    [...document.querySelectorAll("#cards .fv")]
      .filter(fv => fv.scrollWidth > fv.clientWidth)
      .map(fv => fv.textContent + " @" + fv.style.fontSize));

  expect(await clipped()).toEqual([]);

  for (const [w, h] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 3]]) {
    await setSize(page, LONG_KEY, w, h);
    expect(await clipped(), `${w}x${h}`).toEqual([]);
  }
});

test("every value in a card shares the size its widest reading needs", async ({ page }) => {
  await open(page, [LONGNAME]);

  const sizes = await page.locator(LONG_CARD + " .fv").evaluateAll(n => n.map(f => f.style.fontSize));
  expect(sizes.length).toBeGreaterThan(3);
  expect([...new Set(sizes)]).toHaveLength(1);

  // "1013.3hPa" is the widest reading, so it is the one the shared size fits.
  const cut = await page.locator(LONG_CARD + ' .val[data-f="pressure_hPa"] .fv')
    .evaluate(n => n.scrollWidth - n.clientWidth);
  expect(cut).toBeLessThanOrEqual(0);
});

test("a card of short readings keeps larger type than one with a long reading", async ({ page }) => {
  await open(page, [ACURITE, LONGNAME]);
  await page.click("#tab-cards");
  await setSize(page, ACURITE_KEY, 2, 2);
  await setSize(page, LONG_KEY, 2, 2);
  const size = sel => page.locator(sel + " .fv").first().evaluate(n => parseFloat(n.style.fontSize));

  expect(await size(LONG_CARD)).toBeLessThan(await size(CARD));
});

test("the width fit only shrinks, never grows past the height fit", async ({ page }) => {
  await open(page, [ACURITE]);
  const fits = await page.evaluate(() => {
    const rows = [];
    for (const fv of document.querySelectorAll("#cards .fv")) {
      const card = fv.closest(".card");
      const h = cardState.cards[card.dataset.key].h;
      const rows_ = Math.max(h, Math.ceil(card.querySelectorAll(".val").length / 2));
      rows.push({ got: parseFloat(fv.style.fontSize),
                  ceiling: parseFloat(valueFont(h, cellSide, rows_)) });
    }
    return rows;
  });
  expect(fits.length).toBeGreaterThan(0);
  for (const f of fits) expect(f.got).toBeLessThanOrEqual(f.ceiling);
});
