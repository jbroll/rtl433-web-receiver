import { test, expect } from "./pw.js";
import { startServer, openSettings } from "./harness.js";
import { ACURITE, OREGON, THERMO } from "./fixtures.js";

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

const ROWS = "#devices tr:not(.vrow)";

async function open(page, devices) {
  server = await startServer({ devices });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/live/);
  await openSettings(page);
  await expect(page.locator(ROWS)).toHaveCount(devices.length);
}

// The three fixtures in alphabetical order are Acurite, Fineoffset, Oregon,
// which is neither the order they arrive in nor their last-seen order.
const THREE = [OREGON, ACURITE, THERMO];

function models(page) {
  return page.locator(`${ROWS} td:first-child`).allTextContents();
}

test("the table opens alphabetical rather than by last seen", async ({ page }) => {
  await open(page, THREE);
  expect(await models(page)).toEqual(
    ["Acurite-5n1", "Fineoffset-WH2", "Oregon-THN132N"]);
  await expect(page.locator('th[data-sort="name"]')).toHaveAttribute("aria-sort", "ascending");
});

test("clicking a header sorts by it, clicking again reverses", async ({ page }) => {
  await open(page, THREE);
  await page.click('th[data-sort="name"]');
  expect(await models(page)).toEqual(
    ["Oregon-THN132N", "Fineoffset-WH2", "Acurite-5n1"]);
  await expect(page.locator('th[data-sort="name"]')).toHaveAttribute("aria-sort", "descending");

  await page.click('th[data-sort="rssi"]');
  await expect(page.locator('th[data-sort="rssi"]')).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator('th[data-sort="name"]')).toHaveAttribute("aria-sort", "none");
});

test("a value row stays under its own device when the order changes", async ({ page }) => {
  await open(page, THREE);
  await page.click('th[data-sort="name"]');
  const keys = await page.locator("#devices tr").evaluateAll(
    rows => rows.map(r => (r.classList.contains("vrow") ? "v" : "d") + ":" + r.dataset.key));
  // Every run of value rows belongs to the device row immediately above it.
  let owner = null;
  for (const entry of keys) {
    const [kind, key] = [entry.slice(0, 1), entry.slice(2)];
    if (kind === "d") owner = key;
    else expect(key).toBe(owner);
  }
  expect(owner).not.toBeNull();
});

test("the sort survives a reload", async ({ page }) => {
  await open(page, THREE);
  await page.click('th[data-sort="count"]');
  const before = await models(page);

  await page.reload();
  await expect(page.locator("#status")).toHaveText(/live/);
  await openSettings(page);
  await expect(page.locator(ROWS)).toHaveCount(3);
  await expect(page.locator('th[data-sort="count"]')).toHaveAttribute("aria-sort", "ascending");
  expect(await models(page)).toEqual(before);
});

test("a header sorts from the keyboard as well as the mouse", async ({ page }) => {
  await open(page, THREE);
  const head = page.locator('th[data-sort="name"]');
  const button = head.locator("button");
  await button.focus();
  await button.press("Enter");
  await expect(head).toHaveAttribute("aria-sort", "descending");
  await button.press(" ");
  await expect(head).toHaveAttribute("aria-sort", "ascending");
});

test("Reading and Card are not sortable", async ({ page }) => {
  await open(page, THREE);
  const heads = await page.locator("#view-devices th").evaluateAll(
    ths => ths.map(t => [t.textContent.trim(), t.dataset.sort || null]));
  expect(heads.find(h => h[0] === "Reading")[1]).toBeNull();
  expect(heads.find(h => h[0] === "Card")[1]).toBeNull();
});

test("a live update does not reorder an alphabetical table", async ({ page }) => {
  await open(page, THREE);
  const before = await models(page);
  server.emit(THERMO);
  await page.waitForTimeout(300);
  expect(await models(page)).toEqual(before);
});
