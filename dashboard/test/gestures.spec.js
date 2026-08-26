import { test, expect } from "./pw.js";
import { startServer } from "./harness.js";
import { ACURITE, OREGON, topicOf } from "./fixtures.js";

const ACURITE_KEY = topicOf(ACURITE);
const OREGON_KEY = topicOf(OREGON);
const CARD_A = `.card[data-key$="${ACURITE_KEY}"]`;
const CARD_B = `.card[data-key$="${OREGON_KEY}"]`;

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page, devices) {
  server = await startServer({ devices: devices || [] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  return server;
}

async function edit(page) {
  await page.click("#tab-cards");
  await page.click("#edit-cards");
  await expect(page.locator("#view-cards")).toHaveClass(/editing/);
}

function storeKey(server, topic) {
  return server.url.replace(/\/$/, "") + " " + topic;
}

test("a second finger cannot start a drag while a corner resize is in flight", async ({ page }) => {
  await open(page, [ACURITE, OREGON]);
  await edit(page);

  const rz = await page.locator(CARD_A + " .rz").boundingBox();
  const lbl = await page.locator(CARD_B + " .lbl").boundingBox();

  const cdp = await page.context().newCDPSession(page);
  const resizePoint = { x: rz.x + rz.width / 2, y: rz.y + rz.height / 2 };
  const dragPoint = { x: lbl.x + lbl.width / 2, y: lbl.y + lbl.height / 2 };

  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: resizePoint.x, y: resizePoint.y, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: resizePoint.x, y: resizePoint.y, id: 1 },
      { x: dragPoint.x, y: dragPoint.y, id: 2 },
    ],
  });

  expect(await page.evaluate(() => dragging)).toBeNull();

  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [{ x: resizePoint.x, y: resizePoint.y, id: 1 }],
  });
});

test("a value-mode change mid-resize does not touch storage", async ({ page }) => {
  await open(page, [ACURITE]);
  await edit(page);

  const box = await page.locator(CARD_A + " .rz").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 20, { steps: 5 });

  expect(await page.evaluate(() => resizing)).not.toBeNull();

  const before = await page.evaluate(() => localStorage.getItem("rtl433.dashboard.v1"));
  await page.evaluate(k => setValueMode(k, "temperature_F", "hidden"), storeKey(server, ACURITE_KEY));
  const after = await page.evaluate(() => localStorage.getItem("rtl433.dashboard.v1"));
  expect(after).toEqual(before);

  await page.mouse.up();
});
