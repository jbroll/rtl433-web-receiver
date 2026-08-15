import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.spec.js",
  timeout: 15000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  workers: 1,
  use: { headless: true },
});
