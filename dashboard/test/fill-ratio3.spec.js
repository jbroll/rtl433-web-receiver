import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { LONGNAME } from "./fixtures.js";
import { topicOf } from "./fixtures.js";

const LONG_KEY = topicOf(LONGNAME);

test("check timing of fitValues", async ({ page }) => {
  const server = await startServer({ devices: [LONGNAME] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/live/);
  
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState.hidden.length = 0;
    saveCardState();
  });
  
  await page.click("#tab-cards");
  
  await page.evaluate(([c, r]) => { setGrid('cols', c); setGrid('rows', r); }, [3, 3]);
  
  // Check ratios at different time intervals
  for (const wait of [50, 100, 200, 300, 500]) {
    await page.waitForTimeout(wait);
    const ratios = await page.locator('.val').evaluateAll(nodes => 
      nodes.map(n => {
        const fv = n.querySelector('.fv');
        if (!fv) return null;
        return fv.scrollWidth / fv.clientWidth;
      }).filter(r => r !== null)
    );
    const maxRatio = Math.max(...ratios);
    console.log(`After ${wait}ms: max ratio = ${maxRatio}, ratios = ${JSON.stringify(ratios)}`);
  }
  
  await server.close();
});
