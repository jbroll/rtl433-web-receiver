import { cardEntry, visibleValues, bottomFields, cardHidden, setCardHidden, grid } from './store.js'
import { aliasOf, displayName, postAlias } from './alias.js'
import { el, splitUnit, fmtValue, ageText } from './units.js'
import { valueFont, textWidthEm, trackFit, beginDrag, beginResize, editing, setRenaming,
         currentDrag, currentResize, cancelDrag } from './grid.js'
import { requestRender } from './render.js'

export function buildCard(rec) {
  const key = rec.key;
  const c = cardEntry(key);
  const vis = visibleValues(key, rec.merged);
  const g = grid();
  const w = Math.max(1, Math.min(c.w, g.cols));
  const h = Math.max(1, Math.min(c.h, g.rows));

  const card = el("div", "card");
  card.style.gridColumn = "span " + w;
  card.style.gridRow = "span " + h;
  card.dataset.key = key;
  if (rec.flashUntil > Date.now()) card.classList.add("flash");

  const lbl = el("div", "lbl");
  lbl.append(el("span", "nm", displayName(key)), el("span", "rs", rec.rssi === undefined ? "" : String(rec.rssi)));

  const body = el("div", "body");
  const bottom = bottomFields(key, rec.merged);
  const valueRows = Math.max(h, Math.ceil(vis.length / w));
  body.style.gridTemplateColumns = "repeat(" + w + ",minmax(0,1fr))";
  body.style.gridTemplateRows = "repeat(" + valueRows + ",minmax(0,1fr))";
  const font = valueFont(h, valueRows);
  for (const f of vis) {
    const v = el("div", "val");
    v.dataset.f = f;
    const parts = splitUnit(f);
    v.append(el("div", "fn", parts.name));
    const num = fmtValue(rec.merged[f]);
    const fv = el("div", "fv", num);
    fv.style.fontSize = font;
    trackFit(fv, card, textWidthEm(num, parts.unit));
    if (parts.unit) fv.append(el("span", "u", parts.unit));
    v.append(fv);
    body.append(v);
  }

  if (cardHidden(key)) card.classList.add("ghost");

  const cx = el("button", "cx", "✕");
  cx.onclick = ev => { ev.stopPropagation(); setCardHidden(key, !cardHidden(key)); };

  const rz = el("button", "rz", "");
  // Only a second touch can start one gesture during the other, and a drag
  // ending mid-resize would save layout the suppressed renderer has not drawn.
  rz.onpointerdown = ev => {
    if (!editing() || ev.button !== 0 || currentDrag()) return;
    ev.stopPropagation();
    // c.w/c.h, not the clamped w/h this card is drawn at: a resize must move
    // relative to the stored size, not destroy it by starting from a shrunk render.
    beginResize(ev, card, c.w, c.h);
  };

  // dblclick/pointerdown stay wired to lbl for its whole lifetime, and both
  // bubble up from the rename <input> startRename() puts inside it. Without
  // the renaming guard, interacting with the open input (double-clicking a
  // word, a long press to select text) would restart the rename and wipe it.
  lbl.ondblclick = ev => {
    if (!editing() || lbl.dataset.renaming) return;
    ev.stopPropagation();
    startRename(key, lbl);
  };
  let pressTimer = 0;
  // A drag takes pointer capture, after which lbl never sees the pointerup that
  // would clear this timer, so the drag clears it instead.
  card.cancelPress = () => { clearTimeout(pressTimer); pressTimer = 0; };
  lbl.onpointerdown = () => {
    if (!editing() || lbl.dataset.renaming || pressTimer) return;
    pressTimer = setTimeout(() => {
      pressTimer = 0;
      if (!editing() || lbl.dataset.renaming) return;
      // A press held still this long is a rename, so drop the drag it started.
      cancelDrag(key);
      startRename(key, lbl);
    }, 600);
  };
  lbl.onpointerup = lbl.onpointercancel = card.cancelPress;

  card.onpointerdown = ev => {
    if (!editing() || ev.button !== 0 || currentResize()) return;
    if (ev.target.closest("button") || ev.target.closest("input")) return;
    beginDrag(ev, card, ev.target.closest(".val"));
  };

  const strip = el("div", "btm");
  for (const f of bottom) {
    const parts = splitUnit(f);
    const item = el("span");
    item.append(el("span", "bn", parts.name),
                el("span", "bv", fmtValue(rec.merged[f]) + parts.unit));
    strip.append(item);
  }

  card.append(lbl, body, strip, el("div", "age", ageText(Date.now() - rec.seenAt)), cx, rz);
  return card;
}

function startRename(key, lbl) {
  lbl.dataset.renaming = "1";
  setRenaming(true);
  const input = document.createElement("input");
  input.value = aliasOf(key);
  lbl.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = commit => {
    if (done) return;
    done = true;
    delete lbl.dataset.renaming;
    setRenaming(false);
    if (commit) postAlias(key, input.value); else requestRender();
  };
  input.onkeydown = ev => {
    if (ev.key === "Enter") finish(true);
    else if (ev.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}
