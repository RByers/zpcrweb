# Web app architecture

The web app (`@zpcrweb/web`) is a browser UI over [`@zpcrweb/core`](../../packages/core). It
loads one or more `.zpcr` and/or `.pcrd` files, switches between them, and explores each
through five views: Overview, Curves, Diagnostics, Plates, and Raw.

## Two formats, mostly one UI

`@zpcrweb/core`'s `parseZpcr`/`parsePcrd` both produce the same `Zpcr` shape (see the root
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#two-input-formats-one-output-shape)), so most of the
app is format-agnostic:

- `OverviewView`, `CurvesView`, and `DiagnosticsView` take a plain `Zpcr` — they don't know or
  care whether it came from a `.zpcr` archive or a decoded `.pcrd` document. `OverviewView`'s
  protocol tile reads `zpcr.protocolText` (a real field on `Zpcr`, not a by-name file lookup),
  so it works identically either way.
- `DecodedPlateread` (the `.Plateread` typed view) shows the WELLDATA/DARKDATA tables from the
  already-decoded `PlateRead` object either way; it only conditionally shows the binary-only
  "descriptor dictionary" section (`decodePlateReadDetail` finds nothing when there's no
  matching binary archive entry — always the case for a `.pcrd`-origin read, since a `.pcrd`
  has no archive entries at all — which is the signal used to hide that section).
- `RunInfoTable` and `ProtocolDecoded` (`components/raw/DecodedView.tsx`) take plain
  `text: string` rather than `(zpcr, name)`, so both `RawFilesView` (`.zpcr`'s real files, by
  name) and `PcrdRawView` (a `.pcrd`'s real XML nodes, by direct reference) can feed them
  without either pretending to be the other.
- `PlatesView` takes a plain `Zpcr` too, via `zpcr.plates(password)` — a `.zpcr`'s embedded
  `.pltd` entries and a `.pcrd`'s single embedded plate setup both come back as the same
  `PltdEntry[]` shape, so the view never branches on `kind`.

**The Raw view is the one place formats genuinely diverge**, because a `.zpcr` is a real
multi-file archive and a `.pcrd` is a single XML document with no inner files — see "Raw
views" below. `App.tsx` picks `RawFilesView` vs `PcrdRawView` based on the active file's
`kind`.

## The `.pcrd` password gate

Unlike a `.zpcr`'s embedded `.pltd` (locked per-file, browsable independently), a whole `.pcrd`
document is encrypted — nothing (metadata, reads) exists until the password succeeds.
`useZpcrStore` reflects this: `LoadedFile` holds only raw `bytes` + `kind`; the actual `Zpcr` is
derived reactively per file (`runs: Map<id, RunResult>`, recomputed whenever the shared
password changes via `usePltdPassword` — see `state/pltdPassword.ts`, which despite the name
now covers `.pltd`/`.prcl`/`.pcrd` alike). `App.tsx` renders the shared `PasswordPrompt`
(`components/PasswordPrompt.tsx`) in place of the view area whenever the active file's `RunResult`
has `needsPassword`/`error` instead of a `zpcr`; `FileBar` shows a lock/warning glyph for
locked/errored files in the list without blocking selection of other files. `RunResult` also
carries `documentXml` for a successfully-decoded `.pcrd` — the full raw document
(`Pcrd.xml`), which `PcrdRawView` renders (see "Raw views" below).

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
- `settings` — `{ fileId, view, enabledChannels[], enabledWells[], enabledRefCols[], baseline,
  scale }`, so each file remembers its enabled wells/channels/reference columns and last view.
  Writes are debounced.

Deleting a file removes both its `files` and `settings` records and drops it from memory —
exposed as a clear affordance on each file chip.

## Views

- **Overview** — run metadata as stat tiles + the thermal protocol text, read from
  `zpcr.metadata` and `zpcr.protocolText`.
- **Curves** — the centerpiece (see below).
- **Diagnostics** — reference row vs factory calibration (see below).
- **Plates** — `PlatesView` (`components/views/PlatesView.tsx`): the visual, color-coded plate
  map (`components/plate/PlateViewer.tsx`) for every plate attached to the run, via
  `zpcr.plates()`. A sidebar lists plates when there's more than one (multiple `.pltd` entries
  in a `.zpcr`); a `.pcrd`'s single embedded plate setup shows directly. This is the same grid
  component (`PlateViewer`, formerly `PlateDetail`) previously embedded in the Raw view's
  Decoded mode for `.pltd` — moved to its own tab so it's reachable without hunting through the
  file list, and reused by nothing else now that Raw shows a plain table instead (see below).
  Layout: `PlatesView` uses its own `.plateview` flex layout rather than `.raw`'s CSS grid,
  because the plate-list sidebar is conditional (only multi-plate runs get one) — a grid's
  fixed column tracks would strand the lone content pane in the narrow first track when
  there's no sidebar to occupy the other. `PlateViewer` itself declares its own container
  context (`.plateview__main { container: platemain / inline-size }`, distinct from the
  app-wide `appmain` container `.raw`/`.curves` key off) so its internal grid-vs-well-detail
  layout responds to the space it's actually given rather than the whole app window: side by
  side once there's room, stacked (well detail below the grid) on narrow containers.
  Cell mode: a Compact/Detailed toggle controls what each well cell shows. Compact is the
  original abbreviation + per-fluor channel-color dots. Detailed (the default) writes the
  well's `condition` and each loaded fluor's `target` directly into the cell, the target text
  colored by that fluor's channel (`channelColor`) — trading grid density for being able to
  read sample identity and target without opening the click-through well detail panel.
- **Raw** — `RawFilesView` for `.zpcr`, `PcrdRawView` for `.pcrd` (see "Raw views" below).

### Decoded views (`components/raw/DecodedView.tsx`)

`RawFilesView`'s small router, keyed on the `.zpcr` archive entry's file name (`decodedKind`):

- **`.Plateread`** → header (cycle, block temp, timestamp) + the DARKDATA table + the
  WELLDATA fluorescence table as a per-channel plate grid with a stat selector
  (mean/std/min/max). Reads straight from the decoded `PlateRead` (found by `fileName`).
- **`.pltd`** → `DecodedPlate` (`components/raw/DecodedPlate.tsx`), which decrypts the entry
  and renders `PlateTable` (`components/raw/PlateTable.tsx`) — one row per well, in plate
  order, with sample type/name/condition/replicate/quantity and fluor→target columns. Plain
  tabular data, deliberately not the color-coded grid — see the **Plates** tab for that.
- **`RunInfo.xml`** → `RunInfoTable`, a two-column key/value table (it is just a flat
  `KeyValuePairs` blob; parsed with `parseRunInfoRaw`). Takes plain `text`, so `PcrdRawView`
  reuses it directly for a `.pcrd`'s `protocolRunInfo/RunInfo` subtree (same schema).
- **`ProtocolRunDefinition.txt`** → `ProtocolDecoded`, one step per line (split on `;`),
  numbered. Also takes plain `text` and is reused by `PcrdRawView` for `zpcr.protocolText`.
- **other `.xml`** (e.g. `runlog.xml`) → the shared collapsible `XmlTreeFromString`
  (`lib/xmlTree.tsx` — see "Raw views" below).

XML rendering is a *presentation* concern (not `.zpcr`/`.pcrd` decoding), so it lives in the
app, not the library.

## Raw views

A `.zpcr` is a real multi-file archive; a `.pcrd` is a single XML document with no inner
files. Rather than make `.pcrd` pretend to have files matching `.zpcr`'s names, the two
formats get separate raw-browsing components that share one XML rendering primitive.

### The shared XML tree (`lib/xmlTree.tsx`)

Every place the app shows XML — the generic `.zpcr` archive-entry fallback, a decrypted
`.pltd`'s payload (`PlateXml`), `runlog.xml`'s per-entry hover tooltip, and `.pcrd`'s whole
document — goes through one component, `XmlTree` (plus `XmlTreeFromString` for callers that
start from a raw string rather than parsed `Element`s). Built on the native `DOMParser` (same
BOM/declaration-stripping trick as before), each element is its own React component with its
own open/closed `<details>` state; children are only turned into React elements when their
parent is open, so a closed subtree costs ~O(1) regardless of size — a `.pcrd`'s
`calibrationCollection` (~1.4 MB of deeply nested elements in the real sample) collapses by
default and costs nothing until opened. The default-open heuristic (child count, then a
text-length fallback) is generic, not tuned to any one format's tag names.

### `RawFilesView` (`.zpcr`)

Unchanged in spirit from before `.pcrd` support: groups `zpcr.archive.entries` (Metadata /
Plate setup / Plate reads / Calibration / Other). Each file opens in its **best default mode**
(`RawFilesView.defaultMode`) with Decoded / Text / Hex always switchable: a typed **Decoded**
view where one exists (`DecodedView.tsx`, above), else **Text** for textual files, else **Hex**
(`archive.hexDump`, paginated).

### `PcrdRawView` (`.pcrd`)

Parses the full document once (`parseXmlFragment(documentXml)`) and builds a table of contents
from `<experimentalData2>`'s *real* children (per `pcrd.md`'s schema) — not files. Left-nav
groups: **Document** (the whole tree, shown first/by default — large subtrees collapsed, per
the user's request to see the real document rather than a fabricated file list), **Plate
setup** (`plateSetup2` → `PlateTable`, same component `.zpcr`'s embedded `.pltd` uses — the
color-coded grid lives in the **Plates** tab instead, fed by the same `zpcr.plates()`),
**Protocol** (`protocol2` → `ProtocolDecoded` fed `zpcr.protocolText`), **Plate reads** (one
entry per real `<plateRead>`, labeled by its actual cycle number, → `DecodedPlateread` fed
`zpcr.reads[i]` directly — no filename indirection), **Calibration** (`calibrationCollection`
— XML only, no decoder yet), **Run info** (`protocolRunInfo/RunInfo` → `RunInfoTable`), **Log**
(every real `<log>` element, fed straight to `RunLogTable` — see below), **Other** (every
remaining top-level element, one nav entry each — always current since it's discovered from
the parsed document rather than a hardcoded list, so an unfamiliar future subtree still
surfaces). Each entry toggles Decoded/XML (no Hex — low value for a text-format node); nodes
with no decoder default to XML and disable the Decoded toggle, mirroring `RawFilesView`'s
`disabled={!hasDecoded}` pattern.

### `runlog.ts`'s two real shapes

`.zpcr`'s real `runlog.xml` uses child elements (`<Log><TS>…</TS><Msg>…</Msg></Log>`); a
`.pcrd`'s real `<log>` records are attribute-only (`<log ts="…" msg="…" />` — see `pcrd.md`).
`lib/runlog.ts` reads both directly (`logEntriesFromElements`, branching on
`el.attributes.length`, with an explicit attribute→column-name map since some names are
genuine abbreviation differences, not just casing — `assemblyName` → `ANm`) rather than
reshaping one into the other, so `RunLogTable` (`parsed: RunLogParsed`) renders either
format's real elements without either one faking the other's schema.

## Curves view

Data flows `zpcr.curves({ includeReference:false })` + `zpcr.darkCurves()` → filter by
enabled channels/wells → `lib/uplot/chart.ts` `buildChart()` → `CurveChart` renders +
overlays a tooltip. The reference row is excluded here — it has its own chart in the
**Diagnostics** view (below), so `Toggle` (`components/Toggle.tsx`) and `CurveChart` are the
only pieces the two views share.

- **Selection:** a channel bar (6 dye-labelled toggles) and an 8×12 well matrix (`WellMatrix`)
  whose row (A–H) and column (1–12) headers toggle whole rows/columns, plus an all/none corner.
- **Transforms:** Raw ↔ ΔRFU (`deltaBaseline`) and Linear ↔ Log (uPlot `distr: 3`).
  - *Log + ΔRFU:* ΔRFU values go ≤ 0, undefined on a log axis, so non-positive points are
    gaps (`null`) with an inline note. The other three combinations are unaffected.
- **Dark (LED-off) background:** `zpcr.darkCurves()` gives one background series per channel.
  A pure display overlay — it never alters the plotted well curves, min/max bands, or the
  y-axis label. Off (default) draws nothing; On draws one **dotted** dark line per present
  channel, transformed like the curves (so it still tracks ΔRFU/log). Channel-space only,
  like the min/max bands, so the toggle only appears when color separation is off.
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
  factory overlay, or temperature) and reports its label, channel/dye, cycle, and
  mean/min/max/std — or, for a temperature, just its °C. The search projects each series
  through **its own** scale, so proximity is measured in pixels across both axes.

## Diagnostics view

`DiagnosticsView` (`components/views/DiagnosticsView.tsx`) is the reference row's own chart,
plus the reference-vs-factory-calibration table (`RefCalPanel`) below it. It reuses the same
rail+chart layout and `CurveChart` component as the Curves view, but with its own selection
state (`enabledRefCols`, a `RefColBar` chip bar mirroring `ChannelBar`) rather than a well
matrix, since every plotted curve here is a reference well. Each `RefColBar` chip also has a
small **only** button (`onOnly`) that sets `enabledRefCols` to just that one column, for
quickly isolating a single reference well's drift.

- **Live curves:** `zpcr.curves({ includeReference:true })`, filtered to `isReference` wells,
  by enabled channel and reference column. Plotted **solid** — `isReference` is forced to
  `false` when building each `PlotCurve`, since the dashed style that marks a reference well on
  the main Curves view has no meaning on a chart where every well *is* the reference row.
- **Factory overlay:** `zpcr.factoryRefCal()` gives one `(channel, col) → mean` value per
  reference well (`RunInfo.xml`'s `FactoryRefRowCal`; see `packages/core/src/refcal.ts`). Each
  is expanded to a flat line (`mean` repeated once per cycle) and passed to `CurveChart` as
  `factoryCurves`, an overlay concept added to `lib/uplot/chart.ts`'s `buildChart()` — matched
  to a well curve's series by `channel,col` key and drawn **dotted** in the Raw baseline,
  exactly the same "pure display overlay, never subtracted" pattern the Dark toggle uses on
  the main Curves view (`darkCurves`), just keyed by column as well as channel since the
  factory value differs per reference well rather than per channel alone. The tooltip shows
  the matched column (`R{n}`) alongside the channel/dye for a factory series, since a factory
  line's identity isn't otherwise visible the way a well curve's label is.
- **ΔRFU is drift from factory, not from cycle 1:** on the main Curves view, ΔRFU subtracts
  each curve's own first cycle (`deltaBaseline`). Here that would bury the factory
  comparison the view exists to show, so `buildChart()` special-cases any well curve with a
  matching `factoryCurves` entry: in the `"delta"` baseline it plots `live − factory` (constant
  per cycle) instead, and skips drawing the factory line itself (it would otherwise be a flat,
  redundant 0). Well curves with no factory match — none exist in this view today, but the
  branch is generic — still fall back to the normal `deltaBaseline`.
- **`RefCalPanel`** (`components/views/RefCalPanel.tsx`, relocated from Overview): the
  col×channel drift/factory/live grid, from `zpcr.refCalComparison()` — a run-averaged summary
  alongside the chart's per-cycle detail. Laid out as `.refcal`, a two-column flex row (text +
  stat toggle on the left, the grid on the right, wrapping to stacked on narrow containers)
  rather than stacked blocks, so the panel's height is set by the taller side instead of their
  sum — it was previously the tallest section on the page.

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
