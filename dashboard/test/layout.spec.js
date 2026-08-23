import { test, expect } from "@playwright/test";
import { startServer, startPage } from "./harness.js";
import { ACURITE, OREGON, topicOf } from "./fixtures.js";

const ACURITE_KEY = topicOf(ACURITE);

const TEMPLATE = {
  grid: { cols: 8, rows: 5 },
  order: ["Acurite-5n1/396"],
  models: {
    "Acurite-5n1/396": {
      w: 2, h: 2,
      valueOrder: ["humidity", "temperature_C"],
      hiddenValues: [],
      bottomValues: [],
    },
  },
};

let servers = [];

test.afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

async function open(page, devices) {
  const server = await startServer({ devices: devices || [] });
  servers.push(server);
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  return server;
}

test("a $layout retained before connect auto-applies when nothing is stored locally", async ({ page }) => {
  const server = await startServer({ devices: [ACURITE] });
  servers.push(server);
  server.emitLayout(TEMPLATE);
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await expect(page.locator("#grid-cols")).toHaveValue("8");
  await expect(page.locator("#grid-rows")).toHaveValue("5");
  // hideNewCards hides a fresh device's card by default; auto-apply must
  // un-hide it since the template's model entry carries no hidden: true.
  await expect(page.locator(`.card[data-key$="${ACURITE_KEY}"]`)).toBeVisible();
});

test("a card the site default names is placed when it turns up after the $layout frame", async ({ page }) => {
  // The receiver replays $layout ahead of $location, and a feed card cannot
  // exist until a location resolves, so the first frame never names every
  // card the default covers. A late arrival gets the template, not defaults.
  const template = {
    grid: { cols: 8, rows: 5 },
    order: ["Acurite-5n1/396", "Oregon-THN132N/23"],
    models: {
      ...TEMPLATE.models,
      "Oregon-THN132N/23": {
        w: 4, h: 3, valueOrder: ["temperature_C"], hiddenValues: [], bottomValues: [],
      },
    },
  };
  const server = await startServer({ devices: [ACURITE] });
  servers.push(server);
  server.emitLayout(template);
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await expect(page.locator("#grid-cols")).toHaveValue("8");

  await server.emit(OREGON);
  const key = topicOf(OREGON);
  await expect(page.locator(`.card[data-key$="${key}"]`)).toBeVisible();
  await expect.poll(async () => page.evaluate(
    k => { const c = window.cardState.cards[Object.keys(window.cardState.cards).find(x => x.endsWith(k))]; return c && `${c.w}x${c.h}`; },
    key,
  )).toBe("4x3");
});

test("a $layout frame does not auto-apply once a local layout already exists", async ({ page }) => {
  // The auto-apply guard snapshots cardState.order at page load, before any
  // source connects, so "a local layout already exists" has to mean
  // localStorage held one before navigation -- setting it after connect (via
  // cardState/saveCardState) wouldn't touch that startup snapshot.
  const server = await startServer({ devices: [ACURITE] });
  servers.push(server);
  await page.addInitScript(() => {
    localStorage.setItem("rtl433.dashboard.v1", JSON.stringify({
      grid: { cols: 6, rows: 4 }, order: ["seed"], hidden: [], cards: {},
    }));
  });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  server.emitLayout(TEMPLATE);
  await page.waitForTimeout(200);
  await expect(page.locator("#grid-cols")).not.toHaveValue("8");
});

test("a $layout frame does not auto-apply after an explicit Forget layouts, even if nothing was stored at boot", async ({ page }) => {
  // Auto-apply eligibility is true at boot (nothing stored locally), but a
  // user hitting Forget layouts before the $layout frame arrives must still
  // block the auto-apply that would otherwise silently undo their reset.
  const server = await open(page, [ACURITE]);
  await page.click("#edit-cards");
  page.once("dialog", d => d.accept());
  await page.click("#forget-cards");
  server.emitLayout(TEMPLATE);
  await page.waitForTimeout(200);
  await expect(page.locator("#grid-cols")).not.toHaveValue("8");
});

test("Load default layout is offered once a $layout frame arrives, and applies on confirm", async ({ page }) => {
  const server = await open(page, [ACURITE]);
  await expect(page.locator("#load-layout")).toHaveCount(0);
  server.emitLayout(TEMPLATE);
  await page.click("#edit-cards");
  await expect(page.locator("#load-layout")).toBeVisible();
  page.once("dialog", d => d.accept());
  await page.click("#load-layout");
  await expect(page.locator("#grid-cols")).toHaveValue("8");
  await expect(page.locator("#grid-rows")).toHaveValue("5");
});

test("Save as default layout posts the derived template to the source", async ({ page }) => {
  const server = await open(page, [ACURITE]);
  const cols = await page.locator("#grid-cols").inputValue();
  const rows = await page.locator("#grid-rows").inputValue();
  await page.click("#edit-cards");
  await expect(page.locator("#save-layout")).toBeVisible();
  await page.click("#save-layout");
  await expect.poll(async () => {
    const res = await server.get(server.source + "/$layout");
    return res.status;
  }).toBe(200);
  const res = await server.get(server.source + "/$layout");
  const posted = JSON.parse(res.body);
  expect(posted.grid).toEqual({ cols: Number(cols), rows: Number(rows) });
  expect(posted.order).toContain("Acurite-5n1/396");
});

test("multiple sensors of the same model each keep their own saved size", async ({ page }) => {
  const ACURITE2 = { ...ACURITE, id: 500 };
  const KEY2 = topicOf(ACURITE2);
  const server = await open(page, [ACURITE, ACURITE2]);
  const base = server.url.replace(/\/$/, "");

  await page.click("#tab-devices");
  for (const k of [ACURITE_KEY, KEY2]) {
    await page.locator(`#devices tr[data-key$="${k}"] input[type=checkbox]`).check();
  }
  await page.click("#tab-cards");

  await page.evaluate(([k1, k2]) => {
    window.setCardSize(k1, 3, 1);
    window.setCardSize(k2, 1, 2);
  }, [`${base} ${ACURITE_KEY}`, `${base} ${KEY2}`]);
  await page.waitForTimeout(200);

  await page.click("#edit-cards");
  await page.click("#save-layout");
  await page.waitForTimeout(300);

  page.once("dialog", d => d.accept());
  await page.click("#load-layout");
  await page.waitForTimeout(300);

  const state = await page.evaluate(() => window.cardState);
  expect(state.cards[`${base} ${ACURITE_KEY}`]).toMatchObject({ w: 3, h: 1 });
  expect(state.cards[`${base} ${KEY2}`]).toMatchObject({ w: 1, h: 2 });
});

test("same-model slots key on the reading's own id, not connection order", async ({ page }) => {
  const ACURITE2 = { ...ACURITE, id: 500 };
  const KEY2 = topicOf(ACURITE2);

  const server1 = await open(page, [ACURITE, ACURITE2]);
  const base1 = server1.url.replace(/\/$/, "");
  await page.click("#tab-devices");
  for (const k of [ACURITE_KEY, KEY2]) {
    await page.locator(`#devices tr[data-key$="${k}"] input[type=checkbox]`).check();
  }
  await page.click("#tab-cards");
  await page.evaluate(([k1, k2]) => {
    window.setCardSize(k1, 3, 1);
    window.setCardSize(k2, 1, 2);
  }, [`${base1} ${ACURITE_KEY}`, `${base1} ${KEY2}`]);
  await page.waitForTimeout(200);
  await page.click("#edit-cards");
  await page.click("#save-layout");
  await page.waitForTimeout(300);
  const posted = JSON.parse((await server1.get(server1.source + "/$layout")).body);

  // A different session hears the same two sensors in the opposite order.
  const server2 = await startServer({ devices: [ACURITE2, ACURITE] });
  servers.push(server2);
  await page.goto(server2.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  server2.emitLayout(posted);
  await page.click("#tab-devices");
  for (const k of [ACURITE_KEY, KEY2]) {
    await page.locator(`#devices tr[data-key$="${k}"] input[type=checkbox]`).check();
  }
  await page.click("#tab-cards");
  await page.click("#edit-cards");
  page.once("dialog", d => d.accept());
  await page.click("#load-layout");
  await page.waitForTimeout(300);

  const base2 = server2.url.replace(/\/$/, "");
  const state2 = await page.evaluate(() => window.cardState);
  expect(state2.cards[`${base2} ${ACURITE_KEY}`]).toMatchObject({ w: 3, h: 1 });
  expect(state2.cards[`${base2} ${KEY2}`]).toMatchObject({ w: 1, h: 2 });
});

test("Save as default layout is absent when the serving origin isn't a connected source", async ({ page }) => {
  // Reproduces sources.spec.js's "adding a source stores it and connects it"
  // pattern: a device-less host page with one remote source added, so
  // sources.value never includes location.origin (the host's own origin).
  const host = await startPage();
  const src = await startServer({ devices: [ACURITE] });
  servers.push(host, src);
  await page.goto(host.url);
  await page.click("#tab-devices");
  await page.click("#subtab-settings");
  await page.fill("#source-url", src.url.replace(/\/$/, ""));
  await page.click("#source-add");
  await expect(page.locator("#source-list li .dot")).toHaveAttribute("data-state", "live");
  await page.click("#tab-cards");
  await page.click("#edit-cards");
  await expect(page.locator("#save-layout")).toHaveCount(0);
});
