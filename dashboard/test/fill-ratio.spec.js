import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { LONGNAME, ACURITE } from "./fixtures.js";
import { topicOf } from "./fixtures.js";

const LONG_KEY = topicOf(LONGNAME);
const ACURITE_KEY = topicOf(ACURITE);

test("value fill ratio should be high", async ({ page }) => {
  const server = await startServer({ devices: [LONGNAME] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/live/);
  
  // Show all cards
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState.hidden.length = 0;
    saveCardState();
  });
  
  await page.click("#tab-cards");
  
  // Check fill ratio at various sizes
  for (const [w, h] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 3]]) {
    await page.evaluate(([c, r]) => { setGrid('cols', c); setGrid('rows', r); }, [w, h]);
    await page.waitForTimeout(100);
    
    const ratios = await page.locator('.val').evaluateAll(nodes => 
      nodes.map(n => {
        const fv = n.querySelector('.fv');
        if (!fv) return null;
        return fv.scrollWidth / fv.clientWidth;
      }).filter(r => r !== null)
    );
    
    console.log(`${w}x${h} fill ratios:`, ratios);
    const minRatio = Math.min(...ratios);
    expect(minRatio).toBeGreaterThan(0.8); // Should fill at least 80%
  }
  
  await server.close();
});
