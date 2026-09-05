import { test, expect } from "./pw.js";
import { startServer, startPage, routeTiles, openSettings } from "./harness.js";
import { ACURITE, OREGON, topicOf } from "./fixtures.js";

let servers = [];

test.afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

test.beforeEach(async ({ page }) => {
  await routeTiles(page);
});

function base(server) { return server.url.replace(/\/$/, ""); }

function storedSources(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("rtl433.sources.v1")));
}

// Sources now lives inside the Settings disclosure behind the gear
// button (#tab-devices), not its own tab.
async function open(page, url) {
  await page.goto(url);
  await openSettings(page);
  await page.click("#subtab-settings");
}

test("the scan button is absent outside a native shell", async ({ page }) => {
  const host = await startPage();
  servers.push(host);
  await open(page, host.url);
  await expect(page.locator("#mdns-scan")).toHaveCount(0);
  await expect(page.locator("#source-form")).toBeVisible();
});

test("the sources panel lists nothing until a source is added", async ({ page }) => {
  const host = await startPage();
  servers.push(host);
  await open(page, host.url);
  await expect(page.locator("#source-list li")).toHaveCount(0);
  await expect(page.locator("#source-url")).toBeVisible();
});

test("adding a source stores it and connects it", async ({ page }) => {
  const host = await startPage();
  const src = await startServer({ devices: [ACURITE] });
  servers.push(host, src);
  await open(page, host.url);
  await page.fill("#source-url", base(src));
  await page.click("#source-add");
  await expect(page.locator("#source-list li")).toHaveCount(1);
  await expect(page.locator("#source-list li .url")).toHaveText(base(src));
  await expect(page.locator("#source-list li .dot")).toHaveAttribute("data-state", "live");
  expect(await storedSources(page)).toEqual([base(src)]);
});

test("a URL that is not http is refused and nothing is stored", async ({ page }) => {
  const host = await startPage();
  servers.push(host);
  await open(page, host.url);
  await page.fill("#source-url", "ws://nope");
  await page.click("#source-add");
  await expect(page.locator("#source-list li")).toHaveCount(0);
  await expect(page.locator("#source-url")).toHaveAttribute("aria-invalid", "true");
  await page.fill("#source-url", "ws://still-typing");
  await expect(page.locator("#source-url")).not.toHaveAttribute("aria-invalid", "true");
});

test("removing a source takes it out of the panel and out of storage", async ({ page }) => {
  const host = await startPage();
  const src = await startServer({ devices: [ACURITE] });
  servers.push(host, src);
  await open(page, host.url);
  await page.fill("#source-url", base(src));
  await page.click("#source-add");
  await page.click("#source-list li button.rm");
  await expect(page.locator("#source-list li")).toHaveCount(0);
  expect(await storedSources(page)).toEqual([]);
});

test("the status line reports no sources rather than live when none are configured", async ({ page }) => {
  const host = await startPage();
  servers.push(host);
  await page.goto(host.url);
  await expect(page.locator("#status")).toHaveText("no sources");
  await expect(page.locator("#status")).toBeVisible();
});

test("an empty configuration lands on Devices/Settings and stores nothing", async ({ page }) => {
  const host = await startPage();
  servers.push(host);
  await page.goto(host.url);
  await expect(page.locator("#view-devices")).toBeVisible();
  await expect(page.locator("#source-list li")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("rtl433.sources.v1"))).toBeNull();
  await expect(page.locator("#devices tr[data-key]")).toHaveCount(0);
});

test("a binding origin is adopted, listed, and removable", async ({ page }) => {
  const src = await startServer({ devices: [ACURITE] });
  servers.push(src);
  await page.goto(src.url);
  await expect(page.locator("#view-cards")).toBeVisible();
  await expect(page.locator("#status")).toBeHidden();
  expect(await storedSources(page)).toEqual([base(src)]);
  await openSettings(page);
  await expect(page.locator(`#devices tr[data-key="${base(src)} ${topicOf(ACURITE)}"]:not(.vrow)`))
    .toHaveCount(1);
  await page.click("#subtab-settings");
  await expect(page.locator("#source-list li")).toHaveCount(1);
  await expect(page.locator("#source-list li .url")).toHaveText(base(src));
  await expect(page.locator("#source-list li .dot")).toHaveAttribute("data-state", "live");
  await page.click("#source-list li button.rm");
  await expect(page.locator("#source-list li")).toHaveCount(0);
  expect(await storedSources(page)).toEqual([]);
});

test("removing the last source and reloading stays on Devices", async ({ page }) => {
  const src = await startServer({ devices: [ACURITE] });
  servers.push(src);
  await page.goto(src.url);
  await expect(page.locator("#view-cards")).toBeVisible();
  await openSettings(page);
  await page.click("#subtab-settings");
  await page.click("#source-list li button.rm");
  await expect(page.locator("#source-list li")).toHaveCount(0);
  expect(await storedSources(page)).toEqual([]);
  await page.reload();
  await expect(page.locator("#view-devices")).toBeVisible();
  await expect(page.locator("#source-list li")).toHaveCount(0);
  // Outlast the 1500 ms probe window: no probe runs for a stored empty list,
  // so nothing re-adopts the serving origin.
  await page.waitForTimeout(2000);
  expect(await storedSources(page)).toEqual([]);
  await expect(page.locator("#view-devices")).toBeVisible();
});

test("a source whose SSE endpoint stays down backs off, not on a flat 5s timer", async ({ page }) => {
  test.setTimeout(30000);
  const host = await startPage();
  servers.push(host);

  const attempts = [];
  await page.route("**/events", (route) => {
    attempts.push(Date.now());
    route.fulfill({ status: 503, body: "" });
  });

  await open(page, host.url);
  await page.fill("#source-url", "http://source-down.local");
  await page.click("#source-add");

  await expect.poll(() => attempts.length, { timeout: 25000, intervals: [200] }).toBeGreaterThanOrEqual(6);

  const gaps = [];
  for (let i = 1; i < attempts.length; i++) gaps.push(attempts[i] - attempts[i - 1]);
  // gaps[0] is the browser's own immediate retry on the first drop, not ours.
  // n=0's hand-rolled backoff is under 2s; a flat 5s timer never produces that.
  expect(gaps[1]).toBeLessThan(2000);
  // n=3's backoff is 6.4-9.6s -- guaranteed past the old flat 5s retry.
  expect(gaps[gaps.length - 1]).toBeGreaterThan(5000);
});

test("a second source added from a device-served page keeps both", async ({ page }) => {
  const a = await startServer({ devices: [ACURITE], source: "srcA" });
  const b = await startServer({ devices: [OREGON], source: "srcB" });
  servers.push(a, b);
  await page.goto(a.url);
  await expect(page.locator("#view-cards")).toBeVisible();
  await openSettings(page);
  await page.click("#subtab-settings");
  await page.fill("#source-url", base(b));
  await page.click("#source-add");
  await expect(page.locator("#source-list li")).toHaveCount(2);
  expect(await storedSources(page)).toEqual([base(a), base(b)]);
  await expect(page.locator("#source-list li .dot[data-state=live]")).toHaveCount(2);
  await page.click("#subtab-devices");
  await expect(page.locator("#devices tr[data-key]:not(.vrow)")).toHaveCount(2);
  await expect(page.locator(`#devices tr[data-key="${base(a)} ${topicOf(ACURITE, "srcA")}"]:not(.vrow)`))
    .toHaveCount(1);
  await expect(page.locator(`#devices tr[data-key="${base(b)} ${topicOf(OREGON, "srcB")}"]:not(.vrow)`))
    .toHaveCount(1);
});
