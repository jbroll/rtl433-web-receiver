import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { ACURITE, OREGON, THERMO, LONGNAME, FREEZER, RECEIVER } from "./fixtures.js";

function slotTargets() {
  const grid = document.getElementById("cards");
  const gridRect = grid.getBoundingClientRect();
  const cards = [...document.querySelectorAll("#cards .card")].map(card => ({
    card,
    r: card.getBoundingClientRect(),
  }));
  const rows = [];
  for (const c of cards) {
    const row = rows.find(r => Math.abs(r.top - c.r.top) < 5);
    if (row) row.cards.push(c);
    else rows.push({ top: c.r.top, cards: [c] });
  }
  rows.sort((a, b) => a.top - b.top);
  for (const row of rows) row.cards.sort((a, b) => a.r.left - b.r.left);

  const slots = [];
  const first = rows[0].cards[0];
  slots.push({
    name: "before-first",
    before: first.card.dataset.key,
    x: gridRect.left + 5,
    y: first.r.top + first.r.height / 2,
  });
  const lastRow = rows[rows.length - 1];
  const last = lastRow.cards[lastRow.cards.length - 1];
  slots.push({
    name: "after-last",
    before: "",
    x: gridRect.right - 5,
    y: last.r.top + last.r.height / 2,
  });
  for (const row of rows) {
    const h = Math.max(...row.cards.map(c => c.r.height));
    for (let i = 0; i < row.cards.length - 1; i++) {
      const a = row.cards[i], b = row.cards[i + 1];
      slots.push({
        name: `between[${i}]`,
        before: b.card.dataset.key,
        x: (a.r.right + b.r.left) / 2,
        y: a.r.top + h / 2,
      });
    }
  }
  return { order: cards.map(c => c.card.dataset.key), slots };
}

let server;
test.afterEach(async () => { if (server) await server.close(); server = null; });

test("sweep every card to every slot, fresh geometry per drag", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 2400 });
  server = await startServer({ devices: [ACURITE, OREGON, THERMO, LONGNAME, FREEZER, RECEIVER] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  await page.waitForSelector("#cards .card", { timeout: 10000 });
  await page.click("#edit-cards");
  await page.waitForSelector("#view-cards.editing");

  const orderKeys = () => page.evaluate(() => [...document.querySelectorAll("#cards .card")].map(c => c.dataset.key));
  let firstRun = true;
  for (const src of await orderKeys()) {
    const state = await orderKeys();
    const info = await page.evaluate(slotTargets);
    if (firstRun) {
      console.log("ORDER", JSON.stringify(info.order));
      for (const s of info.slots) console.log("SLOT", s.name, "before=" + (s.before || "(end)"), "at", s.x.toFixed(1), s.y.toFixed(1));
      firstRun = false;
    }
    for (const s of info.slots) {
      const before = await orderKeys();
      const seq = await page.locator(`.card[data-key="${src}"] .lbl`).boundingBox();
      if (!seq) { console.log("DRAG", src, "->", s.name, "NO LABEL"); break; }
      await page.mouse.move(seq.x + seq.width / 2, seq.y + seq.height / 2);
      await page.mouse.down();
      await page.mouse.move(s.x, s.y, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      const after = await orderKeys();
      // Correct result: src is immediately before its target (or at the end).
      const pos = after.indexOf(src);
      let ok;
      if (s.before === "") ok = pos === after.length - 1;
      else ok = after[pos + 1] === s.before && before.indexOf(src) !== pos;
      console.log(`DRAG ${short(src)} -> ${s.name}: [${short(before).join(",")}] -> [${short(after).join(",")}] ${ok ? "OK" : "WRONG"}`);
    }
  }
});

const short = a => (Array.isArray(a) ? a : [a]).map(k => k.split("/").pop().split(" ")[0]);