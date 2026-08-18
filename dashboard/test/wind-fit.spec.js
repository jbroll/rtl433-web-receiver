import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";

const WIND = {
  model: "Acurite-5n1", id: 396, channel: "A", protocol: 40,
  sequence_num: 0, battery_ok: 1,
  temperature_F: 71.2, humidity: 38,
  wind_avg_mi_h: 4.6, wind_dir_deg: 337.5, mic: "CHECKSUM",
};

// A 3-digit wind direction with a fraction is the widest reading in the card;
// its box must fit it, not clip it at the uniform font.
test("a 3-digit wind direction fits its value box", async ({ page }) => {
  const server = await startServer({ devices: [WIND] });
  await page.goto(server.url);
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState = { ...cardState, hidden: [] };
    saveCardState();
  });
  await page.click("#tab-cards");
  await expect(page.locator('.val[data-f="wind_dir_deg"] .fv')).toHaveText("337.5");

  const fv = page.locator('.val[data-f="wind_dir_deg"] .fv');
  await expect.poll(() => fv.evaluate(n =>
    n.clientWidth <= n.closest('.val').clientWidth)).toBe(true);

  await server.close();
});