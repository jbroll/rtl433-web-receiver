import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { LONGNAME } from "./fixtures.js";
import { topicOf } from "./fixtures.js";

const LONG_KEY = topicOf(LONGNAME);

test("value fill ratio at 3x3 with logging", async ({ page }) => {
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
  await page.waitForTimeout(200);
  
  // Check if fitValues ran
  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  
  await page.waitForTimeout(500);
  
  const ratios = await page.locator('.val').evaluateAll(nodes => 
    nodes.map(n => {
      const fv = n.querySelector('.fv');
      if (!fv) return null;
      return fv.scrollWidth / fv.clientWidth;
    }).filter(r => r !== null)
  );
  
  console.log('3x3 fill ratios after 500ms:', ratios);
  console.log('Console logs:', logs.filter(l => l.includes('fitValues')));
  
  await server.close();
});
