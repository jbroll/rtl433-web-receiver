import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { ACURITE, RECEIVER } from "./fixtures.js";
import { topicOf } from "./fixtures.js";

const RECEIVER_KEY = topicOf(RECEIVER);

test("debug receiver card - check shownKeys", async ({ page }) => {
  const server = await startServer({ devices: [ACURITE, RECEIVER] });
  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/live/);
  
  await page.waitForTimeout(1000);
  
  const logs1 = logs.filter(l => l.includes('[shownKeys]'));
  console.log('Initial shownKeys logs:', logs1);
  
  await page.evaluate(() => {
    setHideNewCards(false);
    cardState.value = { ...cardState.value, hidden: [] };
    saveCardState();
  });
  
  await page.waitForTimeout(500);
  
  const logs2 = logs.filter(l => l.includes('[shownKeys]'));
  console.log('After showEveryCard shownKeys logs:', logs2);
  
  const cardCount = await page.locator('#cards .card').count();
  console.log('Card count:', cardCount);
  
  await server.close();
});
