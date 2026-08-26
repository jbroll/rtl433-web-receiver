import { test as base, expect } from "@playwright/test";

// Playwright matches the most recently registered route first, so a spec's
// own routeWeather()/routeTiles() (registered after this fixture runs) still
// wins over the abort below.
function guard(route) {
  const h = new URL(route.request().url()).hostname
  return h === "127.0.0.1" || h === "localhost" ? route.continue() : route.abort()
}

export async function guardContext(context) {
  await context.route("**/*", guard);
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route("**/*", guard);
    await use(page);
  },
});

export { expect };
