import { test, expect } from "./pw.js";
import { startServer } from "./harness.js";

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function openBridges(page, list) {
  await page.route("**/$mqtt", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(list) });
  });
  server = await startServer({});
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.click("#tab-devices");
  await page.click("#subtab-settings");
  await expect(page.locator("#bridge-form")).toBeVisible();
}

test("adding a bridge succeeds and the new row appears", async ({ page }) => {
  await openBridges(page, []);
  await page.route("**/$mqtt", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    route.fulfill({ status: 204 });
  });
  await page.route("**/$mqtt", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify([{ url: "mqtts://weather.rkroll.com:8883", connected: false }]),
    });
  });

  await page.fill("#bridge-url", "mqtts://weather.rkroll.com:8883");
  await page.click("#bridge-add");

  await expect(page.locator("#bridge-list .url")).toHaveText("mqtts://weather.rkroll.com:8883");
  await expect(page.locator("#bridge-url")).not.toHaveAttribute("aria-invalid", "true");
});

test("adding a bridge that fails marks the field invalid and toasts", async ({ page }) => {
  await openBridges(page, []);
  await page.route("**/$mqtt", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    route.fulfill({ status: 400 });
  });

  await page.fill("#bridge-url", "not a url");
  await page.click("#bridge-add");

  await expect(page.locator("#bridge-url")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#toast")).toBeVisible();
  await expect(page.locator("#bridge-list li")).toHaveCount(0);
});

test("removing a bridge that fails leaves the row in place and toasts", async ({ page }) => {
  await openBridges(page, [{ url: "mqtts://weather.rkroll.com:8883", connected: true }]);
  await page.route("**/$mqtt/remove", (route) => route.fulfill({ status: 500 }));

  await page.click("#bridge-list .rm");

  await expect(page.locator("#toast")).toBeVisible();
  await expect(page.locator("#bridge-list li")).toHaveCount(1);
});

test("removing a bridge the firmware won't drop still answers 204, and the row stays with a toast", async ({ page }) => {
  await openBridges(page, [{ url: "mqtts://weather.rkroll.com:8883", connected: true }]);
  await page.route("**/$mqtt/remove", (route) => route.fulfill({ status: 204 }));
  await page.route("**/$mqtt", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify([{ url: "mqtts://weather.rkroll.com:8883", connected: true }]),
    });
  });

  await page.click("#bridge-list .rm");

  await expect(page.locator("#toast")).toBeVisible();
  await expect(page.locator("#bridge-list li")).toHaveCount(1);
});
