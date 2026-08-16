import { test, expect } from "@playwright/test";

test("debug device values", async ({ page }) => {
  await page.goto('http://192.168.1.171/');
  await expect(page.locator("#status")).toHaveText(/live/);
  
  await page.waitForTimeout(5000);
  
  // Check devices in the store
  const devices = await page.evaluate(() => {
    const result = [];
    window.devices.forEach((v, k) => result.push({ key: k, model: v.obj?.value?.model }));
    return result;
  });
  console.log('Devices:', devices);
  
  // Check cardState
  const cardState = await page.evaluate(() => window.cardState);
  console.log('cardState:', JSON.stringify(cardState, null, 2));
});
