import { test, expect } from "@playwright/test";

test("debug shownKeys", async ({ page }) => {
  await page.goto('http://192.168.1.171/');
  await expect(page.locator("#status")).toHaveText(/live/);
  
  await page.waitForTimeout(3000);
  
  // Check shownKeys before
  const shown1 = await page.evaluate(() => shownKeys.value);
  console.log('Initial shownKeys:', shown1);
  
  // Show all cards
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState.value = { ...cardState.value, hidden: [] };
    saveCardState();
  });
  
  await page.waitForTimeout(1000);
  
  const shown2 = await page.evaluate(() => shownKeys.value);
  console.log('After show:', shown2);
  
  // Check card count
  const cardCount = await page.locator('.card').count();
  console.log('Card count:', cardCount);
});
