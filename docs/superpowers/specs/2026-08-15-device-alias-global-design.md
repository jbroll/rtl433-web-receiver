# Device Alias Global Write-Back Design

## Scope

Fix the same-origin receiver path so an alias entered on the Devices tab is
written back to the receiver and appears in a fresh browser context that loads
the same receiver. The cross-origin case (dashboard served separately from the
source) remains local-only, matching the current design in `alias.js:60-63`.

## Background

The global aliasing mechanism already exists for the same-origin receiver case:

- Dashboard `postAlias` saves to `localStorage` and POSTs to
  `${origin}/${topic}/$alias` when `sourceOf(key) === location.origin`.
- Receiver `handleAliasPost` stores aliases in NVS via `alias_store::set`,
  broadcasts them to SSE clients with `broadcastAlias`, and replays them from
  `alias_store` on new SSE connections with `drainReplay`.
- The dashboard rebuilds device rows each render, re-reading `aliasOf(r.key)`.

However, the exact composition has no test: write an alias in browser A through
the Devices tab, then open a fresh browser B with no `localStorage` and see the
alias arrive via SSE replay. Existing tests cover only pieces:

| Piece | Test |
| --- | --- |
| Dashboard applies a replayed alias | `alias.test.js` |
| UI rename POSTs an alias | `cards.spec.js:213` |
| Model stores and replays aliases on fresh SSE | `binding.spec.js:150,162` |
| Cross-origin alias stays local | `multi.spec.js:92,113` |
| Same-origin two-browser replay | **missing** |

`postAlias` also swallows POST failures with `.catch(() => {})` and never checks
`res.ok`, so a 400/405/503 from the receiver is indistinguishable from a 204 in
the UI. The same-browser reload persistence that currently masks the bug comes
entirely from `localStorage`.

## Approach

### Phase A — Reproduce against the binding model

Add a same-origin two-browser Playwright test in `dashboard/test/multi.spec.js`.
Use `startServer` so the page and the SSE source share one origin; create a
second browser context with `browser.newContext()` for the fresh browser:

- Browser A loads the receiver-served page, opens the Devices tab, types an
  alias, and presses Enter.
- Assert `server.get(topic + "/$alias")` returns the alias (POST landed).
- Browser B loads the same page with empty storage, opens the Devices tab, and
  asserts the alias input shows the same value.

If this passes, the dashboard + binding model wiring is proven and the bug is
isolated to the real firmware. If it fails, the bug is in the dashboard and the
test becomes the regression guard.

### Phase B — Surface POST failures

Replace `postAlias`'s `.catch(() => {})` with logging that reports the actual
status or exception. The goal is visibility: future receiver rejections should
appear in the browser console instead of being silent. Keep the user-facing
behavior unchanged on success.

### Phase C — Hardware diagnostics

Run a standalone HTTP/SSE probe against the physical receiver plus its serial
monitor (`receiver/monitor.py`) to identify which boundary fails:

| Step | Check | Failing result points to |
| --- | --- | --- |
| 1 | `POST /<source>/<model>/<id>/$alias` status | `handleAliasPost` rejection |
| 2 | `GET /<source>/<model>/<id>/$alias` body | `alias_store` persistence |
| 3 | Fresh `GET /events` stream; wait for alias frame | `broadcastAlias` / `drainReplay` |
| 4 | Serial log during the POST | WebServer / body parsing layer |

### Phase D — Fix at the identified root cause

Implement one fix based on the diagnostic evidence, TDD-style:

- POST rejected: fix `web_ui.cpp` `handleAliasPost` or the source/topic
  alignment.
- Stored but GET empty: fix `alias_store.cpp` `set` / `persist` / NVS handling.
- Stored and GET ok but no SSE frame: fix `web_ui.cpp` `broadcastAlias` /
  `drainReplay`.
- All firmware paths succeed but dashboard still blank: fix the dashboard
  `applyAliasFrame` / render path (unlikely after Phase A).

Add or extend the matching test in `receiver/test/binding-server.js` and
`binding.spec.js` so the model and firmware stay aligned.

### Phase E — Verify on hardware

Re-flash the receiver, open the page in two real browsers, write an alias in one
and confirm it appears in the other. Re-run `npm test` in `dashboard/` and the
receiver host tests.

## Testing

- New `dashboard/test/multi.spec.js` case: same-origin two-browser alias replay.
- New or updated `dashboard/test/alias.test.js` case: `postAlias` logs a failed
  POST without throwing.
- Existing `binding.spec.js` cases continue to cover model-level alias store and
  replay.
- Receiver host tests for any firmware layer that is host-compilable.

## Documentation

Update `docs/backlog.md` to remove the completed item once the fix is verified.
`docs/architecture.md` already describes alias storage and cross-origin behavior;
no change is needed unless the diagnostic reveals a design mismatch.
