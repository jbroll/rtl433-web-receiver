# Headerless dashboard

Remove the dashboard header. The Cards tab is the only tab, so the tab bar,
the `rtl_433` title, and the header row itself go away. The settings gear
moves to the lower-right corner and toggles settings mode. The connection
status becomes a badge that appears only when something is wrong.

## app.jsx

- Delete the `<header>` element, the `TABS` array, and the tab nav.
- Keep the `tab` signal with values `cards` and `devices`.
- Render the gear as a fixed button outside both sections, in the
  lower-right corner (`right:1rem`, the spot the pencil holds today).
  Clicking it toggles `tab` between `devices` and `cards`. It carries
  `aria-selected={tab.value === 'devices'}` for the highlight. Its id stays
  `tab-devices`.
- The gear is hidden while layout editing is active (`editing.value`), so it
  cannot collide with the wrapped edit-control row under 400px and the view
  cannot change mid-drag.
- The settings section keeps its Settings/Devices/Log subnav unchanged.
- `Status` renders nothing when every source is live and there is at least
  one source. Otherwise it renders a small fixed badge in the lower left
  with the existing text (`no sources`, `reconnecting`, `n/m live`).

## style.css

- Delete the `header`, `h1`, and `header .gear` rules. The old `#status`
  rule is replaced by the fixed-badge styling.
- The pencil (`#edit-cards`) moves to `right:4.2rem`; `#forget-cards`,
  `#grid-size`, `#save-layout`, and `#load-layout` each shift left by the
  same 3.2rem.
- The gear reuses the pencil's round fixed-button styling at `right:1rem`,
  with a selected state while settings is open.
- The under-400px editing media query keeps working; the gear is not part of
  `#edit-controls` and is hidden while editing.

## Tests

Update anything referencing the header, `h1`, `#tab-cards`, or tab-switch
flows to use the gear toggle. The gear now both opens and closes settings.

## Docs

`dashboard/README.md` or user-facing docs that describe the header or tabs
are updated in the same commit.
