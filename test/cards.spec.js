const { test, expect } = require("@playwright/test");
const { startServer } = require("./harness");
const { ACURITE, OREGON } = require("./fixtures");

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page, devices) {
  server = await startServer({ devices: devices || [] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText("live");
  return server;
}

test("the served page lists devices and streams live signals", async ({ page }) => {
  await open(page, [ACURITE]);
  await expect(page.locator("#devices tr")).toHaveCount(1);
  await expect(page.locator("#devices tr").first()).toContainText("Acurite-5n1");

  server.emit(OREGON);
  await expect(page.locator("#devices tr")).toHaveCount(2);
});
