import { devices } from './devices.js'
import { cardFields, cardHidden, setCardHidden, valueMode, setValueMode } from './store.js'
import { aliasOf, postAlias, shortKey } from './alias.js'
import { el, ageText } from './units.js'
import { sortDevices, sortBy, current, sortable } from './devicesort.js'
import { tick } from './tick.js'

const $ = (id) => document.getElementById(id)

function reading(rec) {
  return Object.keys(rec.merged.value).map(k => k + ": " + rec.merged.value[k]).join("  ");
}

export function renderDevices() {
  if ($("view-devices").hidden) return;
  const tbody = $("devices");
  const held = document.activeElement;
  if (tbody.contains(held) && (held.tagName === "SELECT" || held.type === "text")) return;
  const out = [];
  for (const r of sortDevices(devices.value.values())) {
    out.push(deviceRow(r));
    for (const f of cardFields(r.key, r.merged.value)) out.push(valueRow(r.key, f, r.merged.value[f]));
  }
  tbody.replaceChildren(...out);
  markSortedColumn();
}

function markSortedColumn() {
  const { by, dir } = current();
  for (const th of document.querySelectorAll("#view-devices th[data-sort]")) {
    const on = th.dataset.sort === by;
    th.setAttribute("aria-sort", on ? (dir === 1 ? "ascending" : "descending") : "none");
  }
}

export function installSort() {
  for (const th of document.querySelectorAll("#view-devices th[data-sort]")) {
    if (!sortable(th.dataset.sort)) continue;
    th.tabIndex = 0;
    th.onclick = () => { sortBy(th.dataset.sort) };
    th.onkeydown = ev => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      sortBy(th.dataset.sort);
    };
  }
  markSortedColumn();
}

function deviceRow(r) {
  const obj = r.obj.value;
  const name = obj && obj.model ? obj.model : shortKey(r.key);
  const tr = el("tr", r.flashUntil.value > tick.value ? "flash" : "");
  tr.dataset.key = r.key;
  const cells = [
    name,
    obj && obj.id !== undefined ? obj.id : (obj && obj.channel !== undefined ? "ch" + obj.channel : ""),
    reading(r),
    r.rssi.value === undefined ? "" : r.rssi.value,
    r.count.value === undefined ? "" : r.count.value,
    ageText(Date.now() - r.seenAt.value)
  ];
  cells.forEach((v, i) => tr.append(el("td", i >= 3 ? "num" : "", v)));

  const alias = el("input");
  alias.type = "text";
  alias.value = aliasOf(r.key);
  alias.placeholder = name;
  alias.title = "Name shown on this device's card";
  alias.onchange = () => postAlias(r.key, alias.value);

  const show = el("input");
  show.type = "checkbox";
  show.checked = !cardHidden(r.key);
  show.title = "Show a card for this device";
  show.onchange = () => setCardHidden(r.key, !show.checked);

  const aliasTd = el("td"), showTd = el("td");
  aliasTd.append(alias);
  showTd.append(show);
  tr.append(aliasTd, showTd);
  return tr;
}

const MODES = el("select");
for (const m of ["shown", "bottom", "hidden"]) {
  const opt = el("option", "", m);
  opt.value = m;
  MODES.append(opt);
}

function valueRow(key, field, value) {
  const tr = el("tr", "vrow");
  tr.dataset.key = key;
  tr.dataset.f = field;
  const name = el("td", "", field), val = el("td", "num", value), mode = el("td");
  name.colSpan = 3;
  val.colSpan = 3;
  mode.colSpan = 2;
  const pick = MODES.cloneNode(true);
  pick.value = valueMode(key, field);
  pick.onchange = () => setValueMode(key, field, pick.value);
  mode.append(pick);
  tr.append(name, val, mode);
  return tr;
}
