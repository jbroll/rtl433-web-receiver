import { defineConfig } from "@playwright/test";

// A new spec needs one line added here, or it never runs.
const SPECS = [
  "auth.spec.js",
  "cards.spec.js",
  "devices-table.spec.js",
  "devicesort.spec.js",
  "feed-cards.spec.js",
  "feeds.spec.js",
  "fontfit.spec.js",
  "layout.spec.js",
  "location-propagation.spec.js",
  "location.spec.js",
  "mobile-grid.spec.js",
  "multi.spec.js",
  "network-guard.spec.js",
  "rain-today.spec.js",
  "settings.spec.js",
  "sources.spec.js",
  "units.spec.js",
  "weather.spec.js",
  "wind-fit.spec.js",
];

export default defineConfig({
  testDir: "./test",
  testMatch: SPECS,
  timeout: 15000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  workers: 1,
  use: { headless: true },
});
