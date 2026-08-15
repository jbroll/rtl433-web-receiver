import { test, expect } from "@playwright/test";
import { startServer, startPage } from "./harness.js";
import { ACURITE } from "./fixtures.js";

let servers = [];

test.afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

async function open(page, url) {
  await page.goto(url);
  await page.click("#sources-toggle");
}

test("the settings panel lists nothing until a source is added", async ({ page }) => {
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
  const base = src.url.replace(/\/$/, "");
  await open(page, host.url);
  await page.fill("#source-url", base);
  await page.click("#source-add");
  await expect(page.locator("#source-list li")).toHaveCount(1);
  await expect(page.locator("#source-list li .url")).toHaveText(base);
  await expect(page.locator("#source-list li .dot")).toHaveAttribute("data-state", "live");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("rtl433.sources.v1"))))
    .toEqual([base]);
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
  const base = src.url.replace(/\/$/, "");
  await open(page, host.url);
  await page.fill("#source-url", base);
  await page.click("#source-add");
  await page.click("#source-list li button.rm");
  await expect(page.locator("#source-list li")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("rtl433.sources.v1"))))
    .toEqual([]);
});
