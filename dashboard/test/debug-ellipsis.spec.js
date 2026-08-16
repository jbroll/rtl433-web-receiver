import { test, expect } from "@playwright/test";

test("check ellipsis on device", async ({ page }) => {
  await page.goto('http://192.168.1.171/');
  await expect(page.locator("#status")).toHaveText(/live/);
  
  await page.waitForTimeout(3000);
  
  // Show all cards
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState.value = { ...cardState.value, hidden: [] };
    saveCardState();
  });
  
  await page.waitForTimeout(2000);
  
  // Check all .fv elements
  const fvData = await page.locator('.fv').evaluateAll(nodes => 
    nodes.map(n => ({
      text: n.textContent,
      fontSize: n.style.fontSize,
      clientWidth: n.clientWidth,
      scrollWidth: n.scrollWidth,
      hasEllipsis: n.scrollWidth > n.clientWidth,
    }))
  );
  
  console.log('Total FV:', fvData.length);
  const withEllipsis = fvData.filter(d => d.hasEllipsis);
  console.log('With ellipsis:', withEllipsis.length, 'out of', fvData.length);
  if (withEllipsis.length > 0) {
    console.log('Ellipsis details:', withEllipsis.map(d => ({ text: d.text, fontSize: d.fontSize, clientWidth: d.clientWidth, scrollWidth: d.scrollWidth })));
  }
  
  // Also check card count
  const cardCount = await page.locator('.card').count();
  console.log('Card count:', cardCount);
});
