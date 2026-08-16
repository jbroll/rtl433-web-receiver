import { test, expect } from "@playwright/test";

test("debug device values", async ({ page }) => {
  await page.goto('http://192.168.1.171/');
  await expect(page.locator("#status")).toHaveText(/live/);
  
  await page.waitForTimeout(3000);
  
  // Check what tabs are available
  const tabs = await page.locator('nav button').evaluateAll(nodes => 
    nodes.map(n => ({ id: n.id, text: n.textContent, selected: n.getAttribute('aria-selected') }))
  );
  console.log('Tabs:', tabs);
  
  // Click cards tab
  await page.click("#tab-cards");
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
});
