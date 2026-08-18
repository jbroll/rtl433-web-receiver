import { test } from "@playwright/test";

const BASE = process.env.BASE || "http://rtl433-435140.local/";

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

test("sweep every card to every slot on the device", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push("PAGEERR: " + e.message.slice(0, 300)));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text().slice(0, 300)); });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => setHideNewCards(false));
  await page.click("#tab-cards");
  await page.waitForSelector("#cards .card", { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.click("#edit-cards");
  await page.waitForSelector("#view-cards.editing");

  const start = await page.evaluate(slotTargets);
  console.log("INITIAL", JSON.stringify(start.order));
  for (const s of start.slots) console.log("SLOT", s.name, "before=" + s.before, "at", s.x.toFixed(1), s.y.toFixed(1));

  const orderKeys = () => page.evaluate(() => [...document.querySelectorAll("#cards .card")].map(c => c.dataset.key));

  for (let si = 0; si < start.order.length; si++) {
    const src = start.order[si];
    for (const s of start.slots) {
      const before = await orderKeys();
      const seq = await page.locator(`.card[data-key="${src}"] .lbl`).boundingBox();
      if (!seq) { console.log("DRAG", src, "->", s.name, "no label after reorder"); break; }
      await page.mouse.move(seq.x + seq.width / 2, seq.y + seq.height / 2);
      await page.mouse.down();
      await page.mouse.move(s.x, s.y, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(120);
      const after = await orderKeys();
      const fromIdx = before.indexOf(src);
      const toIdx = after.indexOf(src);
      const changed = fromIdx !== toIdx;
      const expectedIdx = s.before === "" ? after.length - 1 : after.indexOf(s.before);
      console.log(`DRAG ${src} -> ${s.name}: beforeIdx=${fromIdx} afterIdx=${toIdx} expectedIdx=${expectedIdx} ${changed ? "CHANGED" : "SAME"}`);
    }
  }
  console.log("ERRORS", errors.length ? JSON.stringify(errors) : "none");
});