import { test, expect } from "@playwright/test";
import { startServer, startPage } from "./harness.js";
import { ACURITE, topicOf } from "./fixtures.js";

const ACURITE_KEY = topicOf(ACURITE);

const TEMPLATE = {
  grid: { cols: 8, rows: 5 },
  order: ["Acurite-5n1"],
  models: {
    "Acurite-5n1": {
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
  expect(posted.order).toContain("Acurite-5n1");
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
