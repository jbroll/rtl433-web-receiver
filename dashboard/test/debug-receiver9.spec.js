import { test, expect } from "@playwright/test";
import { startServer } from "./harness.js";
import { RECEIVER, ACURITE } from "./fixtures.js";
import { topicOf } from "./fixtures.js";

const RECEIVER_KEY = topicOf(RECEIVER);

test("debug receiver card", async ({ page }) => {
  const server = await startServer({ devices: [ACURITE, RECEIVER] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/live/);
  
  await page.waitForTimeout(1000);
  
  // Check the cardState
  const state = await page.evaluate(() => cardState);
  console.log('cardState:', JSON.stringify(state, null, 2));
  
  // Check if RECEIVER is in order and hidden
  console.log('RECEIVER_KEY:', RECEIVER_KEY);
  
  // Check devices
  const devices = await page.evaluate(() => {
    const result = [];
    window.devices.forEach((v, k) => result.push({ key: k, isSelf: v.isSelf }));
    return result;
  });
  console.log('devices:', devices);
});
