import { test, expect } from "@playwright/test";
import { startServer, startPage } from "./harness.js";
import { ACURITE, OREGON, topicOf } from "./fixtures.js";

let servers = [];

test.afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

function base(server) { return server.url.replace(/\/$/, ""); }

async function withSources(page, host, bases) {
  await page.addInitScript((list) => {
    localStorage.setItem("rtl433.sources.v1", JSON.stringify(list));
  }, bases);
  await page.goto(host.url);
}

test("two sources both stream into one device table", async ({ page }) => {
  const host = await startPage();
  const a = await startServer({ devices: [ACURITE], source: "srcA" });
  const b = await startServer({ devices: [OREGON], source: "srcB" });
  servers.push(host, a, b);
  await withSources(page, host, [base(a), base(b)]);
  await page.click("#tab-devices");
  await expect(page.locator("#devices tr[data-key]:not(.vrow)")).toHaveCount(2);
  await expect(page.locator(`#devices tr[data-key="${base(a)} ${topicOf(ACURITE, "srcA")}"]:not(.vrow)`))
    .toHaveCount(1);
  await expect(page.locator(`#devices tr[data-key="${base(b)} ${topicOf(OREGON, "srcB")}"]:not(.vrow)`))
    .toHaveCount(1);
});

test("the same topic on two sources stays two devices with two cards", async ({ page }) => {
  const host = await startPage();
  const a = await startServer({ devices: [ACURITE], source: "shared" });
  const b = await startServer({ devices: [ACURITE], source: "shared" });
  servers.push(host, a, b);
  await withSources(page, host, [base(a), base(b)]);
  await page.click("#tab-devices");
  await expect(page.locator("#devices tr[data-key]:not(.vrow)")).toHaveCount(2);
  for (const s of [a, b]) {
    await page.locator(`#devices tr[data-key="${base(s)} ${topicOf(ACURITE, "shared")}"] input[type=checkbox]`)
      .check();
  }
  await page.click("#tab-cards");
  await expect(page.locator("#cards .card")).toHaveCount(2);
});

test("one source down does not stop another", async ({ page }) => {
  const host = await startPage();
  const a = await startServer({ devices: [ACURITE], source: "srcA" });
  servers.push(host, a);
  const dead = "http://127.0.0.1:1";
  await withSources(page, host, [base(a), dead]);
  await page.click("#tab-devices");
  await expect(page.locator("#devices tr[data-key]:not(.vrow)")).toHaveCount(1);
  await page.click("#tab-sources");
  await expect(page.locator(`#source-list li .dot[data-state="live"]`)).toHaveCount(1);
  await expect(page.locator(`#source-list li .dot:not([data-state="live"])`)).toHaveCount(1);
});

test("removing a source drops its devices and its cards", async ({ page }) => {
  const host = await startPage();
  const a = await startServer({ devices: [ACURITE], source: "srcA" });
  const b = await startServer({ devices: [OREGON], source: "srcB" });
  servers.push(host, a, b);
  await withSources(page, host, [base(a), base(b)]);
  await page.click("#tab-devices");
  await expect(page.locator("#devices tr[data-key]:not(.vrow)")).toHaveCount(2);
  await page.click("#tab-sources");
  await page.locator(`#source-list li:has-text("${base(b)}") button.rm`).click();
  await page.click("#tab-devices");
  await expect(page.locator("#devices tr[data-key]:not(.vrow)")).toHaveCount(1);
  await expect(page.locator(`#devices tr[data-key="${base(a)} ${topicOf(ACURITE, "srcA")}"]:not(.vrow)`))
    .toHaveCount(1);
});

test("removing a source updates the status line to match what remains", async ({ page }) => {
  const host = await startPage();
  const a = await startServer({ devices: [ACURITE], source: "srcA" });
  const b = await startServer({ devices: [OREGON], source: "srcB" });
  servers.push(host, a, b);
  await withSources(page, host, [base(a), base(b)]);
  await expect(page.locator("#status")).toHaveText("live");
  await page.click("#tab-sources");
  await page.locator(`#source-list li:has-text("${base(b)}") button.rm`).click();
  await expect(page.locator("#status")).toHaveText("live");
});

test("a rename on a broker-served page keeps the alias local and does not post to sources", async ({ page }) => {
  const host = await startPage();
  const a = await startServer({ devices: [ACURITE], source: "srcA" });
  const b = await startServer({ devices: [OREGON], source: "srcB" });
  servers.push(host, a, b);
  await withSources(page, host, [base(a), base(b)]);
  await page.click("#tab-devices");
  const row = `#devices tr[data-key="${base(b)} ${topicOf(OREGON, "srcB")}"]`;
  await page.locator(`${row} input[type=text]`).fill("Shed");
  await page.locator(`${row} input[type=text]`).press("Enter");

  // The dashboard is served by a separate host, so aliases are local only.
  expect((await b.get(topicOf(OREGON, "srcB") + "/$alias")).status).toBe(404);
  expect((await a.get(topicOf(ACURITE, "srcA") + "/$alias")).status).toBe(404);

  await page.reload();
  await expect(page.locator("#status")).toHaveText("live");
  await page.click("#tab-devices");
  await expect(page.locator(`${row} input[type=text]`)).toHaveValue("Shed");
});

test("an alias for an external source survives a reload from local storage", async ({ page }) => {
  const host = await startPage();
  const a = await startServer({ devices: [ACURITE], source: "srcA" });
  servers.push(host, a);
  await withSources(page, host, [base(a)]);
  await expect(page.locator("#status")).toHaveText("live");

  await page.evaluate(() => {
    hideNewCards = false;
    cardState.hidden.length = 0;
    saveCardState();
    renderCards();
  });

  const deviceKey = `${base(a)} ${topicOf(ACURITE, "srcA")}`;
  const cardSel = `.card[data-key="${deviceKey}"]`;
  await page.click("#edit-cards");
  await page.dblclick(`${cardSel} .lbl`);
  await page.fill(`${cardSel} .lbl input`, "Back fence");
  await page.press(`${cardSel} .lbl input`, "Enter");
  await expect(page.locator(`${cardSel} .nm`)).toHaveText("Back fence");

  // The source is not the serving origin, so the rename must not have posted.
  expect((await a.get(topicOf(ACURITE, "srcA") + "/$alias")).status).toBe(404);

  await page.reload();
  await expect(page.locator("#status")).toHaveText("live");
  await page.evaluate(() => {
    hideNewCards = false;
    cardState.hidden.length = 0;
    renderCards();
  });
  await expect(page.locator(`${cardSel} .nm`)).toHaveText("Back fence");
});

test("same-origin alias written in one browser replays in a fresh browser", async ({ browser }) => {
  const server = await startServer({ devices: [ACURITE] });
  servers.push(server);
  const topic = topicOf(ACURITE, server.source);
  const key = `${base(server)} ${topic}`;

  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await pageA.goto(server.url);
  await pageA.click("#tab-devices");
  await pageA.locator(`#devices tr[data-key="${key}"] input[type=text]`).fill("Back fence");
  await pageA.locator(`#devices tr[data-key="${key}"] input[type=text]`).press("Enter");

  // The POST landed and was retained.
  const posted = await server.get(topic + "/$alias");
  expect(posted.status).toBe(200);
  expect(JSON.parse(posted.body)).toBe("Back fence");

  // A fresh browser with no localStorage sees the alias replayed from the server.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto(server.url);
  await pageB.click("#tab-devices");
  await expect(pageB.locator(`#devices tr[data-key="${key}"] input[type=text]`)).toHaveValue("Back fence");

  await contextA.close();
  await contextB.close();
});
