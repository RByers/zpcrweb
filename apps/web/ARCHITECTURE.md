# Web app architecture

The web app (`@zpcrweb/web`) is a browser UI over [`@zpcrweb/core`](../../packages/core). It
loads one or more `.zpcr` and/or `.pcrd` files, switches between them, and explores each
through three views: Overview, Curves, and Raw files.

## Two formats, one UI

`@zpcrweb/core`'s `parseZpcr`/`parsePcrd` both produce the same `Zpcr` shape (see the root
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#two-input-formats-one-output-shape)), so almost none
of the app is format-aware:

- `OverviewView`, `CurvesView`, and `RawFilesView` all take a plain `Zpcr` — they don't know or
  care whether it came from a `.zpcr` archive or a decoded `.pcrd` document.
- The Raw files view's per-file-type routing (`decodedKind` in `DecodedView.tsx`) matches
  `.pcrd`'s virtual archive entries by the *same names* a `.zpcr` uses (`RunInfo.xml`,
  `ProtocolRunDefinition.txt`, `runlog.xml`, `Read00001.Plateread`, …), so those decoders need
  no format branching either. The one addition is `plate2` — a `.pcrd`'s `plateSetup2.xml`
  entry is already decrypted (the whole document was), so it skips the password flow a real
  `.pltd` entry needs and renders straight through `EmbeddedPlate` → the shared `PlateDetail`
  component (`components/raw/DecodedPlate.tsx`).
- `DecodedPlateread` (the `.Plateread` typed view) shows the WELLDATA/DARKDATA tables from the
  already-decoded `PlateRead` object either way; it only conditionally shows the binary-only
  "descriptor dictionary" section (`decodePlateReadDetail` finds nothing for a `.pcrd`-origin
  read's synthesized XML fragment, which is the signal used to hide that section).

## The `.pcrd` password gate

Unlike a `.zpcr`'s embedded `.pltd` (locked per-file, browsable independently), a whole `.pcrd`
document is encrypted — nothing (metadata, reads, archive) exists until the password succeeds.
`useZpcrStore` reflects this: `LoadedFile` holds only raw `bytes` + `kind`; the actual `Zpcr` is
derived reactively per file (`runs: Map<id, RunResult>`, recomputed whenever the shared
password changes via `usePltdPassword` — see `state/pltdPassword.ts`, which despite the name
now covers `.pltd`/`.prcl`/`.pcrd` alike). `App.tsx` renders the shared `PasswordPrompt`
(`components/PasswordPrompt.tsx`) in place of the view area whenever the active file's `RunResult`
has `needsPassword`/`error` instead of a `zpcr`; `FileBar` shows a lock/warning glyph for
locked/errored files in the list without blocking selection of other files.

## Stack

- **React 18 + Vite + TypeScript** — SPA, no router (view state is per-file, in the store).
- **uPlot** — canvas charting. Chosen because a run can produce ~648 line series
  (6 channels × 108 wells); uPlot renders that volume smoothly with native log scales and a
  fast cursor, where an SVG library would stutter.
- **IndexedDB** (hand-rolled, no dependency) for persistence.

## Core principle: logic lives in the library, not the app

**All non-trivial data logic is in `@zpcrweb/core`, where it is unit-tested.** The app is a
thin presentation + persistence shell. Concretely:

- Curve derivation and the per-cycle stats (mean/std/min/max) come from `zpcr.curves()`.
- ΔRFU baselining is `deltaBaseline()` from the library — the app never subtracts itself.
- The app only owns view state (which channels/wells are selected, view/baseline/scale
  toggles), rendering, and IndexedDB storage.

Consequence for testing: there are **no app-level tests yet** — coverage rides on the
library's suite. If UI bugs prove frequent we can add Playwright e2e later (tracked in the
root `TODO.md`). Any new analytical transform must be added to the library with tests, not
written inline in a component.

## State & persistence

`state/useZpcrStore.ts` is the single store hook. It holds the list of loaded (not yet parsed)
files, the active file id, a per-file settings map, and the derived `runs` map (see "The
`.pcrd` password gate" above). `state/db.ts` is a minimal IndexedDB wrapper with two object
stores:

- `files` — `{ id, name, size, addedAt, bytes, kind }`; **raw bytes** are stored so files
  survive reloads and are re-parsed (`parseZpcr` or `parsePcrd`, by `kind`) on load. `id` is a
  `name:size` key, which also dedupes re-adding the same file. `kind` defaults to `"zpcr"` for
  records written before `.pcrd` support existed.
- `settings` — `{ fileId, view, enabledChannels[], enabledWells[], baseline, scale }`, so
  each file remembers its enabled wells/channels and last view. Writes are debounced.

Deleting a file removes both its `files` and `settings` records and drops it from memory —
exposed as a clear affordance on each file chip.

## Views

- **Overview** — run metadata as stat tiles + the thermal protocol text, read from
  `zpcr.metadata` and `zpcr.archive.text()`.
- **Curves** — the centerpiece (see below).
- **Raw files** — groups `zpcr.archive.entries` (Metadata / Plate reads / Calibration /
  Other). Each file opens in its **best default mode** (`RawFilesView.defaultMode`) with
  Decoded / Text / Hex always switchable: a typed **Decoded** view where one exists, else
  **Text** for textual files, else **Hex** (`archive.hexDump`, paginated). See below.

### Decoded views (`components/raw/DecodedView.tsx`)

A small router keyed on the file name (`decodedKind`):

- **`.Plateread`** → header (cycle, block temp, timestamp) + the DARKDATA table + the
  WELLDATA fluorescence table as a per-channel plate grid with a stat selector
  (mean/std/min/max). Reads straight from the decoded `PlateRead` (found by `fileName`).
- **`RunInfo.xml`** → a two-column key/value table (it is just a flat `KeyValuePairs` blob;
  parsed with `parseRunInfoRaw`).
- **`ProtocolRunDefinition.txt`** → one step per line (split on `;`), numbered.
- **other `.xml`** (e.g. `runlog.xml`) → pretty-printed, syntax-highlighted XML
  (`lib/xmlFormat.tsx`). runlog.xml is not single-rooted (a BOM, an empty header element,
  then many sibling `<Log>` records with no wrapper), so the formatter strips the BOM/XML
  declaration, wraps the body in a synthetic root for `DOMParser`, and renders that root's
  children — degrading to raw text on a parse error.

XML formatting is a *presentation* concern (not `.zpcr` decoding), so it lives in the app,
not the library.

## Curves view

Data flows `zpcr.curves({ includeReference:true })` + `zpcr.darkCurves()` → filter by
enabled channels/wells → `lib/uplot/chart.ts` `buildChart()` → `CurveChart` renders +
overlays a tooltip.

- **Selection:** a channel bar (6 dye-labelled toggles) and an 8×12 well matrix whose row
  (A–H) and column (1–12) headers toggle whole rows/columns, plus an all/none corner. A
  **reference row (R)** sits below H — the per-channel reference-well readings, toggled like
  any well but **off by default** and drawn **dashed**.
- **Transforms:** Raw ↔ ΔRFU (`deltaBaseline`) and Linear ↔ Log (uPlot `distr: 3`).
  - *Log + ΔRFU:* ΔRFU values go ≤ 0, undefined on a log axis, so non-positive points are
    gaps (`null`) with an inline note. The other three combinations are unaffected.
- **Dark (LED-off) background:** `zpcr.darkCurves()` gives one background series per channel.
  - *Show* (default): one **dashed** dark line per present channel, transformed like the
    curves — so you see where each channel's background sits.
  - *Subtract*: each curve is `subtractSeries(mean, dark[channel])` before ΔRFU/scale (the
    dark lines are dropped and the y-axis label gains "− dark"). Both `subtractSeries` and
    `deltaBaseline` are tested library functions.
- **Temperatures (right axis):** `zpcr.temperatureCurves(step)` gives one series per
  temperature field in the platereads. Chips in the rail toggle each one (all off by
  default, since they are instrument context rather than the measurement) and preview its
  latest value. Selected series are drawn **dashed** on a second uPlot scale with its own
  right-hand °C axis, which appears only when something is selected — so the RFU scale is
  never distorted by a 105 °C lid. Set points (fan on/off thresholds) are dimmed and
  labelled as such. Colors come from `lib/tempColors.ts`, a cool ramp deliberately outside
  the dye palette.
- **X axis:** integer cycles only — a tick per cycle, gridline + label every 5.
- **Hover/tap tooltip:** a uPlot cursor plugin finds the nearest series (well curve, dark,
  reference, or temperature) and reports its label, channel/dye, cycle, and mean/min/max/std
  — or, for a temperature, just its °C. The search projects each series through **its own**
  scale, so proximity is measured in pixels across both axes.

## Color encoding (see `lib/channelColors.ts`)

**Color encodes the channel, never the individual well.** With hundreds of lines, wells in a
channel share one hue; the hovered/nearest line is emphasized while siblings dim (uPlot
`focus.alpha`).

The hues follow each dye's **emission color** — FAM green, HEX yellow, Texas Red orange, Cy5
red, Cy5.5 purple — the Bio-Rad CFX convention users recognize. This palette is deliberately
**not colorblind-safe**: warm dye colors collide (orange↔red; channel 6's blue↔purple) and
cannot pass the CVD gate without abandoning the emission semantics. That trade is acceptable
only because identity never rests on color alone — the channel bar and hover tooltip always
name the channel and dye, and hover isolates one line. The cyberpunk character comes from the
**chrome** (near-black surfaces, cyan/magenta UI accents, glow, mono type), not the series.

**Channels.** The CFX scans six optical channels (`ScanMask=63`); all six carry real
per-well data. Channels 1–5 are the standard dye set; **channel 6 is a real sixth detector
(labelled FRET)**, not the dark/reference data — those are stored separately (`DARKDATA` and
the reference row inside `WELLDATA`). Channel 6 is off by default since standard runs don't
use it.

## Styling & responsiveness

- `theme.css` holds the dark-only design tokens (surfaces, ink, neon accents, channel
  palette, fonts). `app.css` holds layout + component styles.
- Layout is **container-query driven** (`app__main` is the query container): the Curves rail
  sits beside the chart on wide screens and stacks above it under ~720px; the Raw list
  collapses similarly. Fluid type/padding via `clamp()`/`cqi`; chart cells use
  `min-inline-size: 0` and overflow guards so the page never scrolls horizontally.
- `prefers-reduced-motion` is respected.
