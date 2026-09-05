import { test, expect } from "./pw.js";
import { startServer, routeTiles, openSettings, closeSettings } from "./harness.js";
import { ACURITE, topicOf } from "./fixtures.js";

let servers = [];

test.afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

test.beforeEach(async ({ page }) => {
  await routeTiles(page);
});

function base(server) { return server.url.replace(/\/$/, ""); }

async function openSettingsPane(page) {
  await openSettings(page);
  await page.click("#subtab-settings");
}

// Renaming fires a fetch the UI does not await, so a caller that reads the
// bridge's state right after would race it; wait for the response instead.
async function rename(page, key, name) {
  const input = page.locator(`#devices tr[data-key="${key}"] input[type=text]`);
  await input.fill(name);
  const posted = page.waitForResponse((r) => r.url().includes("$alias"));
  await input.press("Enter");
  return posted;
}

test("a rename against a token-protected bridge is rejected and surfaced as a toast", async ({ page }) => {
  const server = await startServer({ authToken: "secret", devices: [ACURITE] });
  servers.push(server);
  const topic = topicOf(ACURITE, server.source);
  const key = `${base(server)} ${topic}`;

  await page.goto(server.url);
  await openSettingsPane(page);
  await rename(page, key, "Back fence");

  await expect(page.locator("#toast")).toBeVisible();
  await expect(page.locator("#toast")).toContainText(/token/i);
  expect((await server.get(topic + "/$alias")).status).toBe(404);
});

test("setting the access token in Settings lets the write go through", async ({ page }) => {
  const server = await startServer({ authToken: "secret", devices: [ACURITE] });
  servers.push(server);
  const topic = topicOf(ACURITE, server.source);
  const key = `${base(server)} ${topic}`;

  await page.goto(server.url);
  await openSettingsPane(page);
  await page.fill("#settings-token", "secret");
  await page.click("#settings-token-save");
  await page.click("#subtab-devices");
  await rename(page, key, "Back fence");

  const posted = await server.get(topic + "/$alias");
  expect(posted.status).toBe(200);
  expect(JSON.parse(posted.body)).toBe("Back fence");
});

test("a token seeded in localStorage before boot survives a fresh page load", async ({ page }) => {
  const server = await startServer({ authToken: "secret", devices: [ACURITE] });
  servers.push(server);
  const topic = topicOf(ACURITE, server.source);
  const key = `${base(server)} ${topic}`;

  // Seeded for the bridge's own origin before any script runs, so a rename
  // only succeeds if loadTokens() actually restores it at boot -- unlike the
  // test above, no field is ever filled through the UI in this page's life.
  await page.addInitScript((origin) => {
    localStorage.setItem("rtl433.tokens.v1", JSON.stringify({ [origin]: "secret" }));
  }, base(server));
  await page.goto(server.url);
  await openSettingsPane(page);
  await rename(page, key, "Back fence");

  const posted = await server.get(topic + "/$alias");
  expect(posted.status).toBe(200);
  expect(JSON.parse(posted.body)).toBe("Back fence");
});

test("the token field never plays the stored secret back into the page", async ({ page }) => {
  const server = await startServer({ authToken: "secret", devices: [ACURITE] });
  servers.push(server);

  await page.goto(server.url);
  await openSettingsPane(page);
  await page.fill("#settings-token", "secret");
  await page.click("#settings-token-save");

  await expect(page.locator("#settings-token")).toHaveValue("");
  expect(await page.content()).not.toContain("secret");
});

test("saving the default layout against a token-protected bridge is rejected and surfaced as a toast", async ({ page }) => {
  const server = await startServer({ authToken: "secret", devices: [ACURITE] });
  servers.push(server);

  await page.goto(server.url);
  await page.click("#edit-cards");
  const posted = page.waitForResponse((r) => r.url().includes("$layout"));
  await page.click("#save-layout");
  await posted;

  await expect(page.locator("#toast")).toBeVisible();
  await expect(page.locator("#toast")).toContainText(/token/i);
  expect((await server.get(server.source + "/$layout")).status).toBe(404);
});

test("setting the access token in Settings lets a default-layout save go through", async ({ page }) => {
  const server = await startServer({ authToken: "secret", devices: [ACURITE] });
  servers.push(server);

  await page.goto(server.url);
  await openSettingsPane(page);
  await page.fill("#settings-token", "secret");
  await page.click("#settings-token-save");
  await page.click("#subtab-devices");
  await closeSettings(page);
  await page.click("#edit-cards");
  const posted = page.waitForResponse((r) => r.url().includes("$layout"));
  await page.click("#save-layout");
  await posted;

  const res = await server.get(server.source + "/$layout");
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body).order).toContain(`${ACURITE.model}/${ACURITE.id}`);
});

test("a token stored for a different bridge's origin is not sent to this one", async ({ page }) => {
  const a = await startServer({ authToken: "secret-a", devices: [ACURITE], source: "srcA" });
  servers.push(a);
  const topicA = topicOf(ACURITE, "srcA");
  const keyA = `${base(a)} ${topicA}`;
  const foreignOrigin = "http://foreign-bridge.test";

  // Seeded the way a user pointed at two bridges ends up with two entries in
  // rtl433.tokens.v1 -- only the foreign origin has one here. The foreign
  // bridge need not exist: the assertion is that this origin's request never
  // carries it, and nothing in the app ever fetches the foreign origin.
  await page.addInitScript((otherOrigin) => {
    localStorage.setItem("rtl433.tokens.v1", JSON.stringify({ [otherOrigin]: "secret-b" }));
  }, foreignOrigin);
  await page.goto(a.url);

  let authHeader;
  await page.route("**/$alias", (route) => {
    authHeader = route.request().headers()["authorization"];
    route.continue();
  });

  await openSettingsPane(page);
  await rename(page, keyA, "Back fence");
  await expect(page.locator("#toast")).toBeVisible();

  expect(authHeader).toBeUndefined();
  expect((await a.get(topicA + "/$alias")).status).toBe(404);
});
