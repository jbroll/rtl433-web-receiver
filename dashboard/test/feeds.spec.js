import { test, expect } from "./pw.js";
import { startServer, routeWeather } from "./harness.js";
import { ACURITE } from "./fixtures.js";

const CLOCK = '.card:not(.ghostcard)[data-key="local feed/Clock"]';

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

async function open(page) {
  await routeWeather(page);
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await expect(page.locator("#status")).toHaveText(/^live/);
}

async function setPlace(page, lat, lon, zone) {
  await page.evaluate(([la, lo, z]) => setLocation({ lat: la, lon: lo, zone: z }), [lat, lon, zone]);
}

test("no feed card exists until a location is set", async ({ page }) => {
  await open(page);
  await expect(page.locator(CLOCK)).toHaveCount(0);

  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();
});

test("the clock card appears without being unhidden", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");

  await expect(page.locator(CLOCK)).toBeVisible();
  expect(await page.evaluate(() => cardState.hidden)).not.toContain("local feed/Clock");
});

test("the clock reads in the chosen zone and shows its offset", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();

  const shown = await page.locator(`${CLOCK} .val[data-f="local_time_12"] .big`).textContent();
  const expected = await page.evaluate(() => {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hour12: true }).formatToParts(new Date());
    return parts.filter(p => p.type === "hour" || p.type === "literal" || p.type === "minute").map(p => p.value).join("");
  });
  expect(shown).toBe(expected);

  await expect(page.locator(`${CLOCK} .val[data-f="utc_offset"] .fv`)).toHaveText(/^[-+]0[67]:00$/);
  await expect(page.locator(`${CLOCK} .val[data-f="time_zone"] .fv`)).toHaveText("America/Denver");
});

test("the 12-hour clock shows a three-letter zone abbreviation and AM/PM", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();

  await expect(page.locator(`${CLOCK} .val[data-f="local_time_12"]`)).toBeVisible();
  await expect(page.locator(`${CLOCK} .val[data-f="local_time_24"]`)).toHaveCount(0);

  const cfn = await page.locator(`${CLOCK} .val[data-f="local_time_12"] .cfn`).textContent();
  expect(cfn).toMatch(/^[A-Z]{3}\s*(AM|PM)$/);

  const big = await page.locator(`${CLOCK} .val[data-f="local_time_12"] .big`).textContent();
  expect(big).toMatch(/^\d{1,2}:\d{2}\s*$/);
  expect(big).not.toMatch(/[AP]M/);
});

test("the 24-hour clock shows no AM/PM and uses two-digit hour", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();

  await page.evaluate(() => {
    setValueMode("local feed/Clock", "local_time_24", "shown");
    saveCardState();
  });

  await expect(page.locator(`${CLOCK} .val[data-f="local_time_24"]`)).toBeVisible();

  const cfn = await page.locator(`${CLOCK} .val[data-f="local_time_24"] .cfn`).textContent();
  expect(cfn).toMatch(/^[A-Z]{3}$/);
  expect(cfn).not.toMatch(/[AP]M/);

  const big = await page.locator(`${CLOCK} .val[data-f="local_time_24"] .big`).textContent();
  expect(big).toMatch(/^\d{2}:\d{2}$/);
  expect(big).not.toMatch(/[AP]M/);
});

test("changing the zone moves the clock", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();
  const denver = await page.locator(`${CLOCK} .val[data-f="local_time_12"] .big`).textContent();

  await setPlace(page, 35.68, 139.69, "Asia/Tokyo");
  await expect(page.locator(`${CLOCK} .val[data-f="time_zone"] .fv`)).toHaveText("Asia/Tokyo");
  expect(await page.locator(`${CLOCK} .val[data-f="local_time_12"] .big`).textContent()).not.toBe(denver);
});

test("the clock survives a reload without waiting on anything", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();

  await page.reload();
  await expect(page.locator("#status")).toHaveText(/^live/);
  await expect(page.locator(CLOCK)).toBeVisible();
});

test("a feed card carries no age and no rssi", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();

  await expect(page.locator(`${CLOCK} .age`)).toHaveCount(0);
  await expect(page.locator(`${CLOCK} .lbl .nm`)).toHaveText("Clock");
});

test("hiding one value on a feed card leaves the rest", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();
  const before = await page.locator(`${CLOCK} .val`).count();

  await page.evaluate(() => {
    setValueMode("local feed/Clock", "dst", "hidden");
  });

  await expect(page.locator(`${CLOCK} .val`)).toHaveCount(before - 1);
  await expect(page.locator(`${CLOCK} .val[data-f="dst"]`)).toHaveCount(0);
});

const SUN = '.card:not(.ghostcard)[data-key="local feed/Sun"]';
const MOON = '.card:not(.ghostcard)[data-key="local feed/Moon"]';
const WEATHER = '.card:not(.ghostcard)[data-key="local feed/Weather"]';

// The dials draw their times inside the SVG, so a string wider than the
// viewBox is clipped by the cell rather than scaled down. These pin the
// longest string each slot can hold.
async function textFits(page, key) {
  return page.evaluate(k => {
    const cell = document.querySelector(`.card[data-key="${k}"] .val.cval`);
    const c = cell.getBoundingClientRect();
    return [...cell.querySelectorAll("text")]
      .filter(t => t.textContent.trim())
      .map(t => {
        const b = t.getBoundingClientRect();
        return { txt: t.textContent.trim(), fits: b.left >= c.left - 0.5 && b.right <= c.right + 0.5 };
      });
  }, key);
}

test("the sun and moon cards appear once a location is set", async ({ page }) => {
  await open(page);
  await expect(page.locator(SUN)).toHaveCount(0);
  await expect(page.locator(MOON)).toHaveCount(0);

  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(SUN)).toBeVisible();
  await expect(page.locator(MOON)).toBeVisible();
});

test("the sun dial and moon disc draw inside their own cell", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(SUN)).toBeVisible();

  await expect(page.locator(`${SUN} .val.cval[data-f="sun"] svg`)).toHaveCount(1);
  await expect(page.locator(`${MOON} .val.cval[data-f="moon"] svg`)).toHaveCount(1);
  await expect(page.locator(`${SUN} .val.cval[data-f="sun"] text`).first())
    .toHaveText(/^\u2191 \d\d:\d\d$/);
  await expect(page.locator(`${SUN} .val[data-f="day_length"] .fv`)).toHaveText(/^\d{1,2}h \d{1,2}m$/);
});

test("neither dial joins the page-wide font fit", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(SUN)).toBeVisible();

  await expect(page.locator(`${SUN} .val.cval .fv`)).toHaveCount(0);
  await expect(page.locator(`${MOON} .val.cval .fv`)).toHaveCount(0);
});

test("a polar location still draws both cards", async ({ page }) => {
  await open(page);
  await setPlace(page, 89.9, 0, "UTC");
  await expect(page.locator(SUN)).toBeVisible();
  await expect(page.locator(MOON)).toBeVisible();

  await expect(page.locator(`${SUN} .val.cval[data-f="sun"] svg`)).toHaveCount(1);
  await expect(page.locator(`${MOON} .val.cval[data-f="moon"] svg`)).toHaveCount(1);

  // With no rise or set to name, the dial says which way round the day is
  // rather than drawing two dashes.
  await expect(page.locator(`${SUN} .val.cval[data-f="sun"] text`).first())
    .toHaveText(/^(up|down) all day$/);
  for (const t of await textFits(page, "local feed/Sun")) {
    expect(t.fits, `"${t.txt}" overflows the cell`).toBe(true);
  }

  // Unhide one and it reads as a value like any other.
  await page.evaluate(() => {
    setValueMode("local feed/Sun", "sunrise", "shown");
    saveCardState();
  });
  await expect(page.locator(`${SUN} .val[data-f="sunrise"] .fv`)).toHaveText("—");
});

test("a location above the Arctic circle on an all-day-sun date shows up all day and no dash arrow", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-06-21T12:00:00Z"));
  await open(page);
  await setPlace(page, 78.22, 15.65, "UTC");
  await expect(page.locator(SUN)).toBeVisible();

  await expect(page.locator(`${SUN} .val.cval[data-f="sun"] text`).first()).toHaveText("up all day");
  for (const t of await textFits(page, "local feed/Sun")) {
    expect(t.txt).not.toContain("—");
  }
});

// Just past 85N in March, the day's window has a rise crossing but no set
// crossing: alwaysUp and alwaysDown are both false, so the dial must not
// fall back to hhmm(null)'s dash for the event that has none.
test("a latitude with only one of a rise or set draws no dash arrow", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-03-29T06:00:00Z"));
  await open(page);
  await setPlace(page, 85.5, 15.65, "UTC");
  await expect(page.locator(SUN)).toBeVisible();

  for (const t of await textFits(page, "local feed/Sun")) {
    expect(t.txt).not.toContain("↓ —");
  }
});

test("the sun dial draws its rise and set times inside the cell", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(SUN)).toBeVisible();

  const texts = await textFits(page, "local feed/Sun");
  expect(texts.map(t => t.txt)).toEqual(
    expect.arrayContaining([expect.stringMatching(/^\u2191 \d\d:\d\d$/),
                            expect.stringMatching(/^\u2193 \d\d:\d\d$/)]));
  for (const t of texts) expect(t.fits, `"${t.txt}" overflows the cell`).toBe(true);
});

test("the moon disc draws its rise, set and phase inside the cell", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(MOON)).toBeVisible();

  const texts = await textFits(page, "local feed/Moon");
  expect(texts).toHaveLength(3);
  for (const t of texts) expect(t.fits, `"${t.txt}" overflows the cell`).toBe(true);
});

test("the longest phase and time strings still fit", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(MOON)).toBeVisible();

  await page.evaluate(() => {
    const key = "local feed/Moon";
    const merged = {
      moon: { $r: "moon", brief: "x", illumination: 1, phase: 0.5, waxing: true,
              name: "Waning Crescent", pct: 100, riseText: "22:22", setText: "23:59" },
    };
    upsert({ key, merged, seenAt: 0, flashUntil: 0, rssi: undefined, count: 0, obj: null, raw: "" });
  });
  await expect(page.locator(`${MOON} .val.cval text`).last()).toHaveText("Waning Crescent 100%");

  for (const t of await textFits(page, "local feed/Moon")) {
    expect(t.fits, `"${t.txt}" overflows the cell`).toBe(true);
  }
});

test("a composite card opens showing the dial, not the times it already draws", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(SUN)).toBeVisible();

  await expect(page.locator(`${SUN} .val[data-f="sun"]`)).toHaveCount(1);
  await expect(page.locator(`${SUN} .val[data-f="sunrise"]`)).toHaveCount(0);
  await expect(page.locator(`${SUN} .val[data-f="sunset"]`)).toHaveCount(0);
  await expect(page.locator(`${MOON} .val[data-f="moon"]`)).toHaveCount(1);
  await expect(page.locator(`${MOON} .val[data-f="moonrise"]`)).toHaveCount(0);

  // Hidden, not dropped: still listed and still reachable from the table.
  const hidden = await page.evaluate(() => cardState.cards["local feed/Sun"].hiddenValues);
  expect(hidden).toEqual(expect.arrayContaining(["sunrise", "sunset"]));
  expect(await page.evaluate(() => cardState.cards["local feed/Sun"].valueOrder)).toContain("sunrise");
});

// A cached entry outlives the code that wrote it; weather is the only feed
// still cached, so it's the only one that can be missing a field like this.
test("a cache entry written before a field existed still paints", async ({ page }) => {
  await routeWeather(page);
  server = await startServer({ devices: [ACURITE] });
  await page.goto(server.url);
  await page.evaluate(() => {
    localStorage.setItem("rtl433.settings.v1", JSON.stringify({
      units: "metric", decimals: 1, custom: {},
      location: { lat: 40.015, lon: -105.2705, label: "", zone: "America/Denver", zoom: 11 } }));
    // A "now" value missing the field its renderer added after this entry
    // was written: no text, the way a real cached entry could lack one.
    // The temperature (5) is deliberately different from the routed
    // OBSERVATION fixture's (20): if priming ever fell through to a live
    // refetch instead of painting this cached entry, the card would show the
    // fixture's temperature instead and the exact-match assertion below
    // would catch it.
    const stale = { at: Date.now(), ranAt: Date.now(), place: "40.015,-105.2705", meta: null,
      fields: { now: { $r: "now", place: "Boulder, CO", sky: "skc", night: false, temp: 5, unit: "C" } } };
    localStorage.setItem("rtl433.feeds.v2", JSON.stringify({ weather: stale }));
  });
  await page.reload();
  await expect(page.locator("#status")).toHaveText(/^live/);
  await page.evaluate(() => { setHideNewCards(false); cardState = { ...cardState, hidden: [] }; saveCardState(); });

  await expect(page.locator(WEATHER)).toBeVisible();
  await expect(page.locator(`${WEATHER} .val[data-f="now"]`)).not.toContainText("undefined");
  await expect(page.locator(`${WEATHER} .val[data-f="now"] .big`)).toHaveText("5°C");
});

test("a computed feed is never cached, so it cannot paint a stale shape", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(MOON)).toBeVisible();
  await expect(page.locator(SUN)).toBeVisible();
  await expect(page.locator(CLOCK)).toBeVisible();

  const cached = await page.evaluate(() => {
    const raw = localStorage.getItem("rtl433.feeds.v2");
    return raw ? Object.keys(JSON.parse(raw)) : [];
  });
  expect(cached).not.toContain("moon");
  expect(cached).not.toContain("sun");
  expect(cached).not.toContain("clock");
});

test("the clock time fills the width of its cell and is not clipped", async ({ page }) => {
  await open(page);
  await setPlace(page, 40.015, -105.2705, "America/Denver");
  await expect(page.locator(CLOCK)).toBeVisible();
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.evaluate(() => {
    setGrid("cols", 4);
    setGrid("rows", 3);
    setCardSize("local feed/Clock", 2, 2);
    saveCardState();
  });
  await expect.poll(() => page.locator(`${CLOCK} .val[data-f="local_time_12"]`)
    .evaluate(c => c.clientWidth)).toBeGreaterThan(200);

  const fit = await page.locator(`${CLOCK} .val[data-f="local_time_12"]`).evaluate(cell => {
    const big = cell.querySelector(".big");
    const range = document.createRange();
    range.selectNodeContents(big);
    return { used: range.getBoundingClientRect().width / cell.clientWidth,
             clipped: big.scrollWidth - big.clientWidth };
  });

  expect(fit.clipped).toBe(0);
  expect(fit.used).toBeGreaterThan(0.85);
});
