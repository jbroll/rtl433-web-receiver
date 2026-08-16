import { test, expect } from "@playwright/test";

test("check wrapping all cards", async ({ page }) => {
  await page.goto('http://192.168.1.171/');
  await expect(page.locator("#status")).toHaveText(/live/);
  
  await page.waitForTimeout(3000);
  
  // Show all cards
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState.value = { ...cardState.value, hidden: [] };
    saveCardState();
  });
  
  await page.waitForTimeout(3000);
  
  // Check all .fv elements
  const fvData = await page.locator('.fv').evaluateAll(nodes => 
    nodes.map(n => ({
      text: n.textContent,
      fontSize: n.style.fontSize,
      clientWidth: n.clientWidth,
      scrollWidth: n.scrollWidth,
      wrap: n.scrollWidth > n.clientWidth,
      style: n.style.cssText
    }))
  );
  
  console.log('Total FV:', fvData.length);
  fvData.forEach(d => {
    console.log(`Text: "${d.text}", Font: ${d.fontSize}, Client: ${d.clientWidth}, Scroll: ${d.scrollWidth}, Wrap: ${d.scrollWidth > d.clientWidth}`);
  });
});
