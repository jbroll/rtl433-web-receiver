import { test, expect } from "@playwright/test";

test("debug device values", async ({ page }) => {
  await page.goto('http://192.168.1.171/');
  await expect(page.locator("#status")).toHaveText(/live/);
  
  await page.waitForTimeout(3000);
  
  // Show all cards
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState.value = { ...cardState.value, hidden: [] };
    saveCardState();
  });
  
  await page.waitForTimeout(1000);
  
  // Check all .fv elements
  const fvData = await page.locator('.fv').evaluateAll(nodes => 
    nodes.map(n => ({
      text: n.textContent,
      fontSize: n.style.fontSize,
      clientWidth: n.clientWidth,
      scrollWidth: n.scrollWidth,
      hasEllipsis: n.scrollWidth > n.clientWidth,
      style: n.style.cssText
    }))
  );
  console.log('FV data:', JSON.stringify(fvData, null, 2));
  
  // Check card count
  const cardCount = await page.locator('.card').count();
  console.log('Card count:', cardCount);
});
