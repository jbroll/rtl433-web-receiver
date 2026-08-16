import { test, expect } from "@playwright/test";

test("debug device values with all cards", async ({ page }) => {
  await page.goto('http://192.168.1.171/');
  await expect(page.locator("#status")).toHaveText(/live/);
  
  await page.waitForTimeout(3000);
  
  // Check cardState directly
  const state = await page.evaluate(() => cardState);
  console.log('Initial cardState:', JSON.stringify(state, null, 2));
  
  // Show all cards
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState.value = { ...cardState.value, hidden: [] };
    saveCardState();
  });
  
  await page.waitForTimeout(1000);
  
  const state2 = await page.evaluate(() => cardState);
  console.log('After show:', JSON.stringify(state2, null, 2));
  
  // Check card count
  const cardCount = await page.locator('.card').count();
  console.log('Card count:', cardCount);
});
