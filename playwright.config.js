const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./test",
  timeout: 15000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  workers: 1,
  use: { headless: true },
});
