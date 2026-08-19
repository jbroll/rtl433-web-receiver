# Split receiver docs to match the bridge

## Goal

`receiver/README.md` carries install and development material the bridge splits
into `docs/install.md` and `docs/development.md`. The receiver should match:
give the receiver its own `install.md` and `development.md`, and shrink the
README to an introduction plus a links list.

## Changes

### `receiver/docs/install.md` — new

`# Install` with `## Requirements`, `## Wiring`, `## Configure`,
`## Build and flash`, each moved verbatim from `receiver/README.md`.

### `receiver/docs/development.md` — new

`# Development` with:

- `## Layout` — new short prose describing the `receiver/` tree: `src/`,
  `test/`, `platformio.ini`, `monitor.py`, and `docs/`.
- `## Serial monitor` — moved verbatim from the README.
- `## Testing without a radio` — moved verbatim from the README.

### `receiver/README.md` — rewritten

Keep the intro prose (the first two paragraphs). Replace every other section
with a links list mirroring the bridge README's:

- `docs/install.md` — wiring, `.env`, build and flash
- `docs/user-manual.md` — every route, status, topic, and limit
- `docs/architecture.md` — module boundaries and the tradeoffs
- `docs/development.md` — repo layout, the serial monitor, and testing without
  a radio

### `receiver/docs/user-manual.md` — edited

- `## Use`, new section before `## Routes`: the mDNS naming paragraph (prefix
  plus low three MAC bytes, no collision between boards) and the
  WiFi-not-required paragraph, moved verbatim from the README.
- `## Topics`: prepend the sentence framing the receiver as the source-only
  subset of the HTTP binding for MQTT, with the alias-at-every-level note.
  Add the note that every stored message carries `time` (ISO 8601 UTC from
  SNTP), `rssi`, and `count`, stamped by the receiver, and that until the clock
  is set `time` is absent.
- `## The page`: add the link to `receiver/docs/architecture.md` for the
  receiver's own card and its telemetry fields, and the paragraph describing
  the `build` field on the telemetry message and the page's self-reload when it
  changes.
- `## Limits`, new section after `## The page`: the five limit bullets moved
  verbatim from the README.

The README's abbreviated route table is not copied anywhere; the user-manual's
`## Routes` table already covers the routes and their statuses.

### `docs/backlog.md`

Delete the "The receiver has no `install.md` or `development.md`" section.

### `ROADMAP.md`

- Remove the line 32 cross-cutting-debt bullet that says `receiver/README.md`
  carries material the bridge splits.
- Remove the Goal 1 action "split `receiver/README.md` into
  `receiver/docs/install.md` and `receiver/docs/development.md` to match the
  bridge."

## Out of scope

- No content rewrite of moved sections.
- No `quickstart.md`; the Goal 1 quickstart actions stay in the roadmap.
- No change to `receiver/docs/binding.md` (none exists) or the bridge's docs.
- No link changes outside the files listed: everything that references
  `receiver/README.md` still resolves because the README remains.

## Verification

- All moved sections match their README source verbatim, byte for byte, except
  heading level and the new `# Install` / `# Development` titles.
- `receiver/docs/user-manual.md` renders with the new sections in place.
- `grep` for each moved heading confirms it appears in exactly one file.
- No file references a missing `receiver/docs/install.md` or
  `receiver/docs/development.md`.