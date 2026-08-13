#pragma once

#include <Arduino.h>

static const char CARDS_HTML[] PROGMEM = R"rawliteral(
<section id="view-cards" hidden>
  <div id="cards"></div>
</section>
<style>
#cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr));
         grid-auto-rows:150px; grid-auto-flow:dense; gap:1.4rem 1rem; padding:1.6rem 1rem 1rem; }
</style>
<script>
const CARDS_KEY = "rtl433.cards.v1";

// rtl_433 flags rather than readings: useful, but not what a card is for.
const STATUS_FIELDS = new Set(["battery_ok", "battery", "battery_low", "test", "tamper",
                               "status", "integrity", "alarm", "learn", "unknown"]);

let cardState = { order: [], hidden: [], cards: {} };
let storageBroken = false;

function blankState() { return { order: [], hidden: [], cards: {} }; }

function loadCardState() {
  cardState = blankState();
  let raw;
  try { raw = localStorage.getItem(CARDS_KEY); } catch (e) { storageBroken = true; return; }
  if (!raw) return;
  let s;
  try { s = JSON.parse(raw); } catch (e) { return; }
  if (!s || typeof s !== "object") return;
  cardState = {
    order: Array.isArray(s.order) ? s.order.filter(k => typeof k === "string") : [],
    hidden: Array.isArray(s.hidden) ? s.hidden.filter(k => typeof k === "string") : [],
    cards: {},
  };
  const cards = s.cards && typeof s.cards === "object" ? s.cards : {};
  for (const k of Object.keys(cards)) {
    const c = cards[k];
    if (!c || typeof c !== "object") continue;
    cardState.cards[k] = {
      name: typeof c.name === "string" ? c.name : undefined,
      aspect: c.aspect === "h" || c.aspect === "v" ? c.aspect : "sq",
      valueOrder: Array.isArray(c.valueOrder) ? c.valueOrder.filter(f => typeof f === "string") : [],
      hiddenValues: Array.isArray(c.hiddenValues) ? c.hiddenValues.filter(f => typeof f === "string") : [],
    };
  }
}

function saveCardState() {
  if (storageBroken) return;
  try { localStorage.setItem(CARDS_KEY, JSON.stringify(cardState)); }
  catch (e) { storageBroken = true; }
}

function ensureCard(key, merged) {
  let c = cardState.cards[key];
  const fields = Object.keys(merged || {});
  if (!c) {
    const visible = fields.filter(f => !STATUS_FIELDS.has(f));
    c = {
      aspect: visible.length > 3 ? "h" : "sq",
      valueOrder: fields.slice(),
      hiddenValues: fields.filter(f => STATUS_FIELDS.has(f)),
    };
    cardState.cards[key] = c;
  } else {
    for (const f of fields) {
      if (c.valueOrder.indexOf(f) >= 0) continue;
      c.valueOrder.push(f);
      if (STATUS_FIELDS.has(f)) c.hiddenValues.push(f);
    }
  }
  if (cardState.order.indexOf(key) < 0) cardState.order.push(key);
  return c;
}

function visibleValues(key, merged) {
  const c = cardState.cards[key];
  if (!c) return [];
  return c.valueOrder.filter(f => merged[f] !== undefined && c.hiddenValues.indexOf(f) < 0);
}

function cardHidden(key) { return cardState.hidden.indexOf(key) >= 0; }

function orderedKeys() { return cardState.order.filter(k => devices.has(k)); }

loadCardState();
</script>
</body>
</html>
)rawliteral";
