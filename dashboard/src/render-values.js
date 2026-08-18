// A merged field's value is normally a scalar. A feed may instead supply an
// object tagged with $r, naming a component that draws the whole cell.
//
// Such a cell keeps the .val class and data-f so grid.js reorders it like any
// other value, but it never emits .fv and never calls trackFit, so it cannot
// enter the page-wide uniform font fit. That exclusion is structural: adding
// a .fv inside a renderer would silently shrink every card on the page.

const REGISTRY = new Map()

export function registerValue(name, Component) { REGISTRY.set(name, Component) }

export function isRich(raw) { return !!raw && typeof raw === 'object' }

export function rendererFor(raw) {
  return isRich(raw) ? REGISTRY.get(raw.$r) || null : null
}

// The one-line form, for the bottom strip and the devices table. A rich value
// with no brief is omitted there rather than stringified.
export function briefOf(raw) {
  return isRich(raw) && typeof raw.brief === 'string' ? raw.brief : ''
}

export function labelOf(raw, field) {
  return isRich(raw) && typeof raw.label === 'string' ? raw.label : field
}
