# Web app architecture

The web app (`@zpcrweb/web`) is a browser UI over [`@zpcrweb/core`](../../packages/core). It
loads one or more files — `.zpcr`, `.pcrd`, or a standalone plate file (`.pltd` or zpcrweb's own
`.plt.csv`, see "Standalone plate entries and attach" below) — switches between them, and
explores each through up to five views: Overview, Curves, Plates, Reference, and Raw (a
standalone plate file only gets Plates + Raw — see below).

## Two formats, mostly one UI

`@zpcrweb/core`'s `parseZpcr`/`parsePcrd` both produce the same `Zpcr` shape (see the root
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#two-input-formats-one-output-shape)), so most of the
app is format-agnostic:

- `OverviewView`, `CurvesView`, and `ReferenceView` take a plain `Zpcr` — they don't know or
  care whether it came from a `.zpcr` archive or a decoded `.pcrd` document. `OverviewView`'s
  protocol tile and thermal-protocol block read `zpcr.protocol()` (a real accessor on `Zpcr`,
  not a by-name file lookup), so both the name and — when the format provides one — the step
  table work identically either way; when there's no step list it falls back to
  `zpcr.protocolText` rendered through the same `ProtocolDecoded` line-numbering the Raw view
  uses (see below). `OverviewView` additionally takes the raw `RunResult` (not derivable from
  `Zpcr` alone) for its "Encrypted" block: a `.pcrd`'s own `container.encrypted` for a `.pcrd`,
  or any embedded `.pltd`/`.prcl` entry's `container.encrypted` (via `zpcr.plates()`/
  `zpcr.protocols()`) for a `.zpcr` — see `lib/encryptionStatus.ts`.
- `DecodedPlateread` (the `.Plateread` typed view) shows the WELLDATA/DARKDATA tables from the
  already-decoded `PlateRead` object either way; it only conditionally shows the binary-only
  "descriptor dictionary" section (`decodePlateReadDetail` finds nothing when there's no
  matching binary archive entry — always the case for a `.pcrd`-origin read, since a `.pcrd`
  has no archive entries at all — which is the signal used to hide that section). In its place,
  a `.pcrd`-origin read shows a key/value table of `PlateRead.headerFields` — the
  `Hdr/PlateReadDataHeader` XML element's own child elements, name and text content, decoded
  once in `pcrd.ts` rather than re-parsed in the component.
- `RunInfoTable` and `ProtocolDecoded` (`components/raw/DecodedView.tsx`) take plain
  `text: string` rather than `(zpcr, name)`, so both `RawFilesView` (`.zpcr`'s real files, by
  name) and `PcrdRawView` (a `.pcrd`'s real XML nodes, by direct reference) can feed them
  without either pretending to be the other.
- `PlatesView` takes a plain `Zpcr` too, via `zpcr.plates(password)` — a `.zpcr`'s embedded
  `.pltd`/`.plt.csv` entries and a `.pcrd`'s single embedded plate setup both come back as the
  same `PltdEntry[]` shape, so the view never branches on `kind` to *read* plate data (it does
  branch to decide whether to offer the attach control — see below, `.zpcr`-only).

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
now covers `.pltd`/`.prcl`/`.pcrd` alike). The password can also be seeded from the
`cfxPassword` URL query parameter on load (same module), so scripted/UI testing never has to
click through the prompt. `App.tsx` renders the shared `PasswordPrompt`
(`components/PasswordPrompt.tsx`) in place of the view area whenever the active file's `RunResult`
has `needsPassword`/`error` instead of a `zpcr`; `FileBar` shows a lock/warning glyph for
locked/errored files in the list without blocking selection of other files. `RunResult` also
carries `documentXml` for a successfully-decoded `.pcrd` — the full raw document
(`Pcrd.xml`), which `PcrdRawView` renders (see "Raw views" below).

Each chip's hover card (protocol name, cycle count, and the plate's target/sample lists — the
same lists `OverviewView` shows in its "Plate" section, via the shared `lib/plateTargets.ts`
helper) renders through a `createPortal` into `document.body` at a `position: fixed` spot
computed from the chip's `getBoundingClientRect()` on hover/focus, rather than as a normal
absolutely-positioned child of the chip. `.filebar` scrolls horizontally
(`overflow-x: auto`), which per the CSS spec forces the other axis to compute to `auto` too —
a plain `position: absolute` dropdown would get clipped vertically by that implicit scroll
box.

## Stack

- **React 18 API on the Preact runtime + Vite + TypeScript** — SPA, no router (the selected
  view is global, in-memory-only state in the store, shared across all loaded files). Source
  (`.tsx`) uses the standard React API; `vite.config.ts` aliases
  `react`/`react-dom`/`react/jsx-runtime` to `preact/compat`/`preact/jsx-runtime`, so no `react`
  or `react-dom` package is installed — only `@types/react`/`@types/react-dom` for typechecking.
  This cut the production bundle from 327 KB to 198 KB (111 KB to 72 KB gzipped) with no source
  changes; revisit if a future dependency needs a real React internal the compat shim doesn't
  cover.
- **`@zpcrweb/core` resolves to its TypeScript source, not its build output.** Rationale and the
  conditions for revisiting it are in the root [`ARCHITECTURE.md`](../../ARCHITECTURE.md#why-the-web-app-imports-cores-source);
  the mechanics are here. `vite.config.ts`
  aliases the package specifier to `packages/core/src/index.ts`, and `tsconfig.json` carries a
  matching `paths` entry — both must change together, or the bundler and the typechecker end up
  reading different versions of the library. This means `npm run dev` alone hot-reloads edits to
  the library; without it, `packages/core`'s `exports` point at `dist/`, so core changes would
  need a concurrent `tsup --watch` to become visible. Consequences: the app never exercises
  `packages/core/dist` in either dev or production, so packaging-level breakage (the `exports`
  map, dual ESM/CJS output, generated `.d.ts`) is caught only by `npm run build` at the repo
  root, not by the app; and `tsconfig.json` needs `"node"` in `types` because core's entry
  re-exports `node.ts`, whose `node:fs/promises` import tsc now sees directly. That import is
  dynamic precisely so bundlers can drop it, so Vite externalizes it and logs a
  "has been externalized for browser compatibility" warning on build — expected, not a defect.
- **uPlot** — canvas charting. Chosen because a run can produce ~648 line series
  (6 channels × 108 wells); uPlot renders that volume smoothly with native log scales and a
  fast cursor, where an SVG library would stutter.
- **IndexedDB** (hand-rolled, no dependency) for persistence.

## Core principle: logic lives in the library, not the app

**All non-trivial data logic is in `@zpcrweb/core`, where it is unit-tested.** The app is a
thin presentation + persistence shell. Concretely:

- Curve derivation and the per-cycle stats (mean/std/min/max) come from `zpcr.curves()`.
- Baselining (`threshold.md` §2–§4 — smoothing, auto baseline-region detection, and linear
  subtraction) is `packages/core/src/baseline.ts` — the app never invents its own baseline math,
  only calls `autoBaselineRegion`/`subtractBaseline`/`fitLinearBaseline` per curve. It is not a
  user-configurable choice: every Cq/analysis computation always uses the auto-detected linear
  baseline (`LinearBaseLineNormalized`); the app's `CurveView` setting only picks what the Curves
  chart *displays* (the corrected curve, or the raw one), and a separate `drawBaseline` toggle
  optionally overlays the fitted line itself.
- The app only owns view state (which channels/wells are selected, view/scale toggles),
  rendering, and IndexedDB storage.

Consequence for testing: there are **no app-level tests yet** — coverage rides on the
library's suite. If UI bugs prove frequent we can add Playwright e2e later (tracked in the
root `TODO.md`). Any new analytical transform must be added to the library with tests, not
written inline in a component.

## Standalone plate entries and attach

Two more `LoadedFile` kinds, `"pltd"` and `"csv"` (a bare `.csv` upload is treated leniently as
zpcrweb's own `.plt.csv` format — see root `ARCHITECTURE.md`'s "Plate CSV + attaching a plate"),
alongside `"zpcr"`/`"pcrd"`:

- **Standalone entries** — a `.pltd` or `.plt.csv` dropped with no run selected becomes its own
  top-level file, resolved via `plateFiles`/`activePlateFile` (a `PlateFileResult`, parallel to
  `runs`/`activeRun` but with no `Zpcr` involved). `App.tsx` detects `active.kind === "pltd" |
  "csv"` and renders a restricted `ViewSelector` (`views={["plates","raw"]}`) routing to
  `StandalonePlateView`/`StandaloneRawView` instead of the normal five-view `Zpcr`-gated branch
  — both are thin, `Zpcr`-free versions of `PlatesView`/`RawFilesView` operating directly on the
  file's own bytes.
- **Attach (replace a run's plate)** — `PlatesView`'s upload control (`.zpcr` runs only; a
  `.pcrd` shows an explanatory note instead, since it has no real archive to add an entry to)
  calls `store.attachPlate(fileId, file)`, which rewrites the run's own bytes via
  `attachPlateToZpcr` (see root `ARCHITECTURE.md`) and re-persists them under the same file id.
  There is **no separate override state** — once attached, the plate is just part of the run's
  `.zpcr` bytes, so `zpcr.plates()` picks it up the same way it would an originally-embedded
  `.pltd`, and `CurvesView`'s `zpcr.plates(pltdPassword)[0]` labeling updates with no code path
  of its own to keep in sync. This is also how "download the run with its attached plate" works
  — `FileBar`'s per-chip download button just downloads `LoadedFile.bytes` as-is, which already
  includes anything attached.
- **`PlateDownloadButton`** (`components/plate/PlateDownloadButton.tsx`) is the two-option
  download menu (`.pltd` / `.plt.csv`) shared by `PlatesView` and `StandalonePlateView`: "Download
  .pltd" is only enabled when real `.pltd` bytes exist (a real archive entry, or a standalone
  `.pltd` upload) — never for a `.plt.csv`-sourced plate or a `.pcrd`'s embedded plate, neither of
  which has raw `.pltd` bytes to hand back. "Download .plt.csv" is always available, serialized
  from the current `PlateDefinition` via `plateToCsv`.

## State & persistence

`state/useZpcrStore.ts` is the single store hook. It holds the list of loaded (not yet parsed)
files, the active file id, a per-file settings map, the derived `runs`/`plateFiles` maps (see
"The `.pcrd` password gate" above and "Standalone plate entries and attach"), and the
globally-selected view (`view`/`setView`, plain `useState` — not persisted, and not part of the
per-file settings map, so switching files never changes which view is showing). `state/db.ts` is
a minimal IndexedDB wrapper with two object stores:

- `files` — `{ id, name, size, addedAt, bytes, kind }`; **raw bytes** are stored so files
  survive reloads and are re-parsed (`parseZpcr`/`parsePcrd`/`parsePltd`/`parsePlateCsv`, by
  `kind`) on load. `id` is a `name:size` key, which also dedupes re-adding the same file (an
  attach changes `size`, so re-persisting after one just writes the same `id` again — no
  separate override record to keep in sync, see above). `kind` defaults to `"zpcr"` for records
  written before `.pcrd` support existed.
- `settings` — `{ fileId, enabledChannels[], enabledWells[], enabledRefCols[], baseline,
  curveView, drawBaseline, scale, … }`, so each file remembers its enabled wells/channels/
  reference columns. `baseline` (Reference view's factory-relative ΔRFU/Drift %) and `curveView`
  (the Curves view's display mode — baselining itself is never stored, since it's always the
  auto-detected linear fit) are independent settings — see "Two baseline concepts" under
  Reference view. `thresholdOverrides` (`[group, value][]`, manual per-group threshold RFU) and
  `thresholdMultiplier` (§5.1's auto-threshold `k`, absent on records written before it was
  adjustable) are the Curves rail's Threshold section — see "Table mode" below. Older records may carry
  it under its former name, `analysisThresholdOverrides`, alongside two settings of the retired
  standalone Analysis view that are now simply ignored: `analysisDisabledTargets[]` (its own
  target opt-out set, since folded into the shared `disabledFluors`) and `analysisCqAlgorithm`
  (its Cq-algorithm selector — Cq is always §6.1's threshold crossing now). Writes
  are debounced. Older records may still carry the retired `curveBaseline`/`curveBaselineRange`
  fields (`state/db.ts`); `useZpcrStore.ts`'s `fromStored()` migrates `curveBaseline: "raw"` to
  `curveView: "absolute"` (anything else to `"relative"`) and drops the region override entirely.

Deleting a file removes both its `files` and `settings` records and drops it from memory —
exposed as a clear affordance on each file chip.

## Views

- **Overview** — run metadata as stat tiles + the thermal protocol text, read from
  `zpcr.metadata` and `zpcr.protocolText`, a "Plate" section listing the plate's targets and
  samples as chips, plus an "Encrypted" block (see above) showing
  green "No" when nothing in the file is encrypted, orange "Yes" with the password used when
  encrypted content was successfully decrypted, or red "Yes" when it wasn't. The file bar's
  per-chip dot (`components/FileBar.tsx`) mirrors the same three states/colors, computed the
  same way for `.pltd`/`.csv` chips via `lib/encryptionStatus.ts`'s
  `plateFileEncryptionStatus`.

  Each target/sample chip carries that group's positive/negative curve tally — how many of its
  well/fluor curves got a Cq and how many didn't — as two counts either side of a small track
  filled to the positive fraction (`CountChip`/`.chipcount`). The numbers come out of
  `useRunAnalysis`'s single Cq table (`lib/runAnalysis.ts`), the same one the Curves view reads,
  so a chip can't disagree with the Curves table about the same well; the tally is per *curve*,
  so a duplexed well contributes to each of its dyes. That's why Overview takes `settings` —
  thresholds and calibration options change the Cq table. Unloaded wells are skipped, and the
  chips render bare (name only) whenever the Cq table is empty: an uncalibrated run, or a plate
  still behind the password prompt.
- **Curves** — the centerpiece (see below).
- **Reference** — reference row vs factory calibration (see below).
- **Plates** — `PlatesView` (`components/views/PlatesView.tsx`): the visual, color-coded plate
  map (`components/plate/PlateViewer.tsx`) for every plate attached to the run, via
  `zpcr.plates()`, plus an upload control to attach/replace the run's plate (`.zpcr` only —
  see "Standalone plate entries and attach" below) and a `PlateDownloadButton`. Per-sample-type color/label/abbreviation lives in one place,
  `lib/sampleType.ts`'s `SAMPLE_TYPE_META` — grey for empty, green for positive control, red for
  negative control, blue for unknown — shared with the Curves view's well-selection matrix (see
  below) so the two grids read the same way. A sidebar lists plates when there's more than one
  (multiple `.pltd` entries in a `.zpcr`); a `.pcrd`'s single embedded plate setup shows
  directly. This is the same grid
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
  well's `sample` and each loaded fluor's `target` directly into the cell, the target text
  colored by that fluor's channel (`channelColor`) — trading grid density for being able to
  read sample identity and target without opening the click-through well detail panel.
- **Raw** — `RawFilesView` for `.zpcr`, `PcrdRawView` for `.pcrd` (see "Raw views" below).

### Decoded views (`components/raw/DecodedView.tsx`)

`RawFilesView`'s small router, keyed on the `.zpcr` archive entry's file name (`decodedKind`):

- **`.Plateread`** → header (cycle, block temp, timestamp) + the DARKDATA table + the
  WELLDATA fluorescence table as a per-channel plate grid with a stat selector
  (mean/std/min/max). Reads straight from the decoded `PlateRead` (found by `fileName`).
- **`.pltd`/`.plt.csv`** → `DecodedPlate` (`components/raw/DecodedPlate.tsx`) — decrypts a
  `.pltd` entry (password-gated) or parses a `.plt.csv` entry (`parsePlateCsv`, no password
  needed), either way rendering the same `PlateTable` (`components/raw/PlateTable.tsx`) from
  the same `PlateDefinition` object model: one row per well, in plate order, with sample
  type/name/replicate/quantity and fluor→target columns. Plain tabular data,
  deliberately not the color-coded grid — see the **Plates** tab for that.
- **`RunInfo.xml`** → `RunInfoTable`, a two-column key/value table (it is just a flat
  `KeyValuePairs` blob; parsed with `parseRunInfoRaw`). Takes plain `text`, so `PcrdRawView`
  reuses it directly for a `.pcrd`'s `protocolRunInfo/RunInfo` subtree (same schema).
- **`ProtocolRunDefinition.txt`** → `ProtocolDecoded`, one step per line (split on `;`),
  numbered. Also takes plain `text` and is reused by `OverviewView` for the flat-text fallback
  (a `.zpcr`'s protocol, or any archive without a structured step list).
- **`.prcl`** → `DecodedProtocol` (`components/raw/DecodedProtocol.tsx`), which decrypts the
  entry and renders `ProtocolDetail`: root settings (lid/volume/real-time) plus, when the XML
  `protocol2` payload parsed into a step list, a numbered step table via the shared
  `ProtocolStepsTable`/`stepSummary` (`components/raw/ProtocolSteps.tsx`) — reused verbatim by
  `PcrdRawView`'s **Protocol** node and `OverviewView`'s thermal-protocol block, so all three
  format the same `ProtocolStep[]` identically (GOTO-target-friendly numbering, a `●` read
  marker). Falls back to `ProtocolDecoded` on `runDefinition` for the plaintext `.prcl` variant
  (`prcl.md` §1.1), which carries no XML step list.
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
**Protocol** (`protocol2` → `ProtocolDetail` fed `zpcr.protocol()`, the same full name +
settings + step-table view `.prcl` entries get — no password needed, since a `.pcrd`'s protocol
isn't a separate encrypted file), **Plate reads** (one
entry per real `<plateRead>`, labeled by its actual cycle number, → `DecodedPlateread` fed
`zpcr.reads[i]` directly — no filename indirection), **Calibration** (one nav entry per
`zpcr.calibrations()` entry — the same `DcalEntry[]` `.zpcr`'s real `.Dcal` files decode to,
since `pcrd.ts`'s `parseCalibrationDataElement` produces the identical `Dcal` shape — each
rendered with the same `DecodedDcal` component `RawFilesView` uses for a `.Dcal` archive entry;
XML mode shows the matching `<CalibrationData>` subtree, found by walking
`FactoryCals`/`UserCals` in the same order `decodeCalibrationCollection` does), **Run info**
(`protocolRunInfo/RunInfo` → `RunInfoTable`), **Log**
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

## One Cq per well/target: `lib/runAnalysis.ts`

`useRunAnalysis(zpcr, settings, pltdPassword, activeStep, dyeSpace)` is the single run-level
derivation the Curves view's chart, hover cards and table mode share: plate + password state,
fluorophore/target groups
(`lib/plateTargets.ts`), the calibration matrix and `calibration.md` §4 corrections, the
color-separated `allFluorCurves` — and, on top of those, the run's **Cq table**.

- **`cqTable`** — `packages/core/src/analysis.ts`'s `computeCqTable()` over *every* well/dye pair on
  the plate, keyed by `curveKey(row, col, fluor)`. One entry per key: Cq, the §5.1 group threshold,
  noise, amplification verdict, ΔRFU and the fitted baseline. Views look values up in it and never
  recompute — that is the whole point. A group's threshold is the median baseline noise across the
  curves it's computed with, so the old arrangement (three independent computations over the plotted
  curves, over every curve, and over the standalone Analysis view's enabled wells) had the same well
  showing a Cq in one place and "—" in another. Display filters — enabled wells, disabled targets, sample and
  fluor toggles, the view-mode switch — now change only which entries are *shown*.
- **Grouping** is `groupOf(row, col, fluor)`: the pair's target/gene, the shared `"(none)"` catch-all
  when it has none (NTC/NRT wells still get a real threshold and a real Cq rather than being dropped
  for lack of a name), or the fluorophore itself on a plate with no targets at all. Note this is
  independent of the Curves view's Fluorophore/Target *display* mode, which used to re-group the
  thresholds under the chart and so produce different Cq values than the table for the same wells.
- **Noise cohort:** only well/fluor pairs the plate actually loads (`loadedFluors`) contribute to a
  group's threshold, via `CqTableCurve.contributesToThreshold`. Pairs the plate never loaded still
  get their own entry — the Curves view can plot them with "Unloaded" on, and they need a Cq — but a
  dye that was never pipetted into a well doesn't set the bar for the wells that were. That's a
  data-validity gate, not a user filter.
- **`channelCqTable`** — the same computation over raw *channel* curves, keyed by
  `channelCurveKey(row, col, channel)`, for the Cq markers the Curves view draws while color
  separation is off. A separate quantity rather than a second copy of the same one: a channel curve
  mixes every dye emitting into that filter and belongs to no target.

## Curves view

Data flows `zpcr.curves({ includeReference:false })` + `zpcr.darkCurves()` → filter by
enabled channels/wells → `lib/uplot/chart.ts` `buildChart()` → `CurveChart` renders +
overlays a tooltip. The reference row is excluded here — it has its own chart in the
**Reference** view (below), so `Toggle` (`components/Toggle.tsx`) and `CurveChart` are the
only pieces the two views share.

- **Selection:** a channel bar (6 dye-labelled toggles) and an 8×12 well matrix (`WellMatrix`)
  whose row (A–H) and column (1–12) headers toggle whole rows/columns, plus an all/none corner.
  Once the plate definition is available (password permitting), each cell is tinted by
  `SAMPLE_TYPE_META` (see **Plates** below) so selection state reads alongside sample type; a
  reset button next to the "Wells" label restores the selection to exactly the plate's
  non-empty wells. `CurvesView` applies that same non-empty-wells set as the one-time default
  the first time a file's plate loads (only while the selection still looks like the untouched
  "all wells" default, so a previously customized selection is left alone).
- **Baseline is always automatic — no mode or region is user-configurable.** Every curve is
  baseline-corrected with `packages/core/src/baseline.ts`'s `LinearBaseLineNormalized`: find the
  flat pre-amplification region with `autoBaselineRegion` on a smoothed copy of the curve
  (falling back to cycles 2–9 if detection finds nothing confident — `threshold.md` §2–§3), fit
  a line to it (`fitLinearBaseline`), and subtract it (`subtractBaseline`). There used to be a
  three-way mode selector (Raw/Constant/Linear) plus a manual region-override slider; both were
  removed — the manual-region override, in particular, made it easy to silently understate a
  region's real noise and produce a spuriously early or missed Cq (see the git history around
  the retired `BaselineRangeSlider`/`curveBaselineRange` for the worked example that motivated
  dropping it). `findBaselineByRegression`'s "extend while within `k` std errors" loop still
  needs an `initialWidth` of at least **5** points (3 degrees of freedom) and `kStdErrors: 5` for
  the same low-sample-count instability reason — see the regression test in
  `packages/core/test/baseline.test.ts` ("doesn't truncate a flat, realistically-noisy curve …").
- **`CurveView` setting (`"relative"` default / `"absolute"`):** what the chart *displays* —
  `"relative"` plots the baseline-corrected curve, `"absolute"` plots the curve's raw RFU
  unmodified. This is purely a display choice: Cq/ΔRFU/noise/threshold in both the chart's own
  markers and the Analysis table are always computed from the corrected values regardless of
  which is shown (`lib/cq.ts`'s `ANALYSIS_BASELINE_MODE` constant, fixed at
  `LinearBaseLineNormalized`). This is a genuinely different concept from the Reference view's
  ΔRFU/Drift %, which are factory-relative, not a fitted baseline — see "Two baseline concepts"
  under Reference view below. Also Relative ↔ Log (uPlot `distr: 3`).
  - *Log + baseline:* a relative (baseline-corrected) curve can go ≤ 0, undefined on a log axis,
    so each curve is shifted up by a constant (a "min-1" baseline, `logFloor` in
    `lib/uplot/chart.ts`) so its own minimum reads 1, with an inline note. A no-op when the curve
    is already positive (absolute view is unaffected).
- **`drawBaseline` setting (off by default):** overlays each well curve's own fitted baseline
  line as a separate uPlot series, at 50% opacity of the curve's own color
  (`hexToRgba(color, BASELINE_LINE_ALPHA)` in `chart.ts`) — plotted through the *same* per-cycle
  `Adjust` the well curve itself uses, so it reads correctly in either view: the real trend line
  under Absolute, a near-zero reference line under Relative (subtracting a line from itself is
  ~0). These overlay series are appended after every well series (never interleaved), so the
  Cq-marker code — which assumes well curve `i` lives at row/series index `i + 1` — doesn't need
  to know about them, and they're explicitly excluded from the cursor hit-test loop
  (`SeriesMeta.kind === "baseline"`) since they carry no tooltip of their own.
- **Baseline formula display:** wherever a baseline is shown or exported — the chart tooltip's
  "baseline" row, the Analysis table's "Baseline" column, its CSV export — it's rendered as the
  fitted line itself, e.g. `"2000 + 4c"` (`c` = cycle number), via `lib/cq.ts`'s
  `formatBaselineFormula()` over `CurveBaselineResult.baselineFit` (`{ slope, intercept }`,
  `packages/core/src/analysis.ts`), not a single diagnostic RFU number.
- **Number formatting:** `lib/cq.ts` owns two helpers used by every analysis-facing readout, so the
  same quantity never appears at two precisions in two places. `formatRfu()` renders an RFU *level*
  as a whole number (thresholds, ΔRFU, the chart tooltip's mean/min/max, a baseline's intercept):
  readings run to thousands and carry nothing below the ones place, so decimals there are noise
  dressed as precision. `formatCq()` renders a Cq to one decimal — the second digit sits well inside
  the spread between replicates, so showing it invites comparisons the number can't support.
  Deliberately *not* rounded: quantities that share the unit but not the scale (a baseline's slope
  in RFU/cycle, a per-cycle standard deviation), the raw-file inspectors under "Raw files", whose
  job is to show decoded values faithfully, and the CSV export, where full precision is the point.
- **Dark (LED-off) background:** `zpcr.darkCurves()` gives one background series per channel.
  A pure display overlay — it never alters the plotted well curves, min/max bands, or the
  y-axis label. The "Show dark" toggle: off (default) draws nothing; on draws one **dotted**
  dark line per present channel, transformed like the curves (so it still tracks the baseline
  mode/log). Channel-space only, like the min/max bands, so the toggle only appears when color
  separation is off.
- **Temperatures (right axis):** `zpcr.temperatureCurves(step)` gives one series per
  temperature field in the platereads. Chips in the rail toggle each one (all off by
  default, since they are instrument context rather than the measurement) and preview its
  latest value. Selected series are drawn **dashed** on a second uPlot scale with its own
  right-hand °C axis, which appears only when something is selected — so the RFU scale is
  never distorted by a 105 °C lid. Set points (fan on/off thresholds) are dimmed and
  labelled as such. Colors come from `lib/tempColors.ts`, a cool ramp deliberately outside
  the dye palette.
- **Samples:** a collapsible rail section (collapsed by default, like Temperatures) listing every
  distinct `WellDefinition.sample` name actually assigned to a well on the plate (`pltd.md`'s
  `conditionName` — despite the XML attribute name, this is the sample name CFX Manager's UI
  shows). `SampleBar` chips toggle an opt-out set (`disabledSamples`, all shown by default,
  mirroring `disabledFluors`); a well with no `sample` set is never hidden by this filter, since
  there's no chip for it. Applies to both channel- and dye-space curves alike (`sampleVisible()`,
  consulted by both `visibleChannel` and `visibleFluor`).
- **Rail hover highlight and hover cards:** hovering a chip/cell in any rail section (channel,
  fluorophore/target, well, or sample) dims every plotted curve that doesn't match, via
  `HighlightMatch`/`applyHighlight` (`lib/uplot/chart.ts`) — a `"sample"` match variant joins the
  pre-existing `"target"`/`"well"`/`"channel"` ones, keyed by the well's `PlotCurve.sample` (which
  `CurvesView` fills in from the `wellSample` map alongside every other per-curve field). Each of
  `ChannelBar`/`FluorBar`/`WellMatrix`/`SampleBar` also renders a small floating hover card (see
  `components/curves/HoverCard.tsx`'s `useHoverCard` hook — a fixed-position portal to
  `document.body`, positioned from the hovered element's own bounding rect, mirroring `FileBar`'s
  file-chip card) listing everything on the plate for that chip/cell and its Cq, one line per
  entry (swatch · label · sample/well · Cq, the sample/well eliding with an ellipsis before the
  Cq ever gets pushed off): hovering a well lists its targets/fluors with Cq (plus, in the card's
  subtitle, its sample type — the same `SAMPLE_TYPE_META` label the cell's color comes from, read
  as `"empty"` for an unloaded well — and its sample name); hovering a target/fluor lists its
  wells (with sample) and Cq; hovering a
  channel lists its wells (with sample) and Cq; hovering a sample lists its targets/fluors (with
  well) and Cq. Card rows come from `allPlotCurves` — every curve on the plate for the active
  view mode, computed the same way as `plotCurves` but *without* the enabled-wells/channels/
  fluors/samples filters (`CurvesView`'s `allPlotCurves`) — rather than
  `plotCurves` itself, so an element excluded by a rail filter still gets a row instead of being
  dropped from the card entirely; each row carries a `selected` flag (in `selectedCurveKeys`,
  the set of curves actually in `plotCurves`) that `HoverCard` uses to greyed-out (`.is-dim`) and
  sort unselected rows after the selected ones. Rows are capped at 10 with a "N more" footer past
  that, selected rows always counted first so a long unselected tail can't crowd them out. Both
  Both sets of rows take their Cq from the run's single Cq table (`lib/runAnalysis.ts`) by
  well/fluor key, so a curve's Cq in a hover card is by construction the same number as its marker
  on the chart and its row in table mode. (It used to be computed three separate times over
  three different subsets — the plotted curves, every curve, and the standalone Analysis view's
  enabled wells —
  which made the same well legitimately show a Cq in one place and "—" in another.)
  `WellMatrix` renders its native `title` tooltip (`"A1 — NRT (no-RT)"`) only when no `cardData`
  callback is passed, so the two hover affordances never stack: the Curves rail shows the card
  alone, while a card-less `WellMatrix` (as the Reference-style grids use it) keeps the plain
  tooltip. Either way the same text stays on the cell's `aria-label`.
  Hovering a chip/cell that's individually *disabled* still needs a curve in `u.series` for
  `applyHighlight` to un-dim — so `CurvesView`'s `isHoveredWell`/`isHoveredChannel`/
  `isHoveredTarget`/`isHoveredSample` helpers let the hovered item bypass its own disabled check
  in `visibleChannel`/`fluorCurveVisible`/`sampleVisible` (only its own dimension's check — hovering
  a disabled target doesn't also reveal wells the user turned off), so the "peek" a hover implies
  actually shows the curve instead of just dimming everyone else.
  Double-clicking a chip/cell (`onSolo`/`onSoloWell` on each of the four components) isolates it
  within its own dimension — `CurvesView`'s `soloChannel`/`soloFluor`/`soloWell`/`soloSample`
  reset that dimension's enabled/disabled set so only the double-clicked item remains on.
- **X axis:** integer cycles only — a tick per cycle, gridline + label every 5.
- **Hover/tap tooltip:** a uPlot cursor plugin finds the nearest series (well curve, dark,
  factory overlay, or temperature) and reports its label, channel/dye, cycle, and
  mean/min/max/std — or, for a temperature, just its °C. The search projects each series
  through **its own** scale, so proximity is measured in pixels across both axes. A well
  series also carries `baselineFormula` and `cq` (see "Table mode" below); when defined, the
  tooltip adds a "baseline" row (the fitted linear baseline, rendered as a formula — see
  `CurveBaselineResult.baselineFit`/`formatBaselineFormula()` above) right before a Cq row, and
  the chart draws a small ring on the curve at its (interpolated) Cq position — the same marker
  logic (`cqMarkers` in `buildChart()`) that makes an unamplified or off-curve well show no
  marker at all.
- **Color separation (dye space) and the channel/fluorophore/target selector** (also labelled
  "View" in the rail, distinct from the baseline `CurveView` toggle above): `lib/fluorCurves.ts`
  matches
  the plate's fluorophores to this run's `.Dcal` data, builds one calibration matrix per step
  (restricted to the scanned channels, so its RFU scale factors are measured over the right
  rows), and solves every well/cycle — see [`calibration.md`](../../calibration.md). `CurvesView`
  assembles the §4 corrections that go in first: the per-scan reference level from the reference
  row, the additive background, and the per-well gain factors when the run has them (a `.pcrd`
  thing — a `.zpcr` carries none, so only the background subtraction bites there). The
  **"Subtract dark" toggle** (`Off` by default) controls `calibration.md` §4.2's optional
  dark-current stage: when on, the plate read's per-cycle `DARKDATA` is subtracted per channel;
  when off, nothing is. `Off` is what matches the reported RFU scale of the run measured in §8.
  It is **not** a display-only control: `DARKDATA` is re-read every cycle, so the level removed
  varies slightly cycle to cycle, which perturbs the fitted baseline and raises the noise the
  auto threshold derives from — on the committed sample it moves Cq by up to ≈0.6 cycles. It sits
  directly below the Scale row but **outside** the chart-only `!tableMode` block, precisely
  because it moves the numbers the table and CSV export report, not just the chart.

  There is deliberately **no normalization selector**: `calibration.md` §5.1 divides the column
  scaling back out, so every mode reports identical RFU for any full-column-rank matrix, and the
  control could not do anything observable. The `calibrationNormalization` setting still exists
  (fixed at `global`) for the rank-deficient case and for stored-record round-tripping.
  `computeFluorCurves` solves every well against every calibrated plate fluor, but `CurvesView`
  only plots a line when all three hold: the well is enabled, the fluor (or, in target mode,
  its target — see below) isn't disabled, and — per `pltd.md`'s per-well dye layers
  (`WellDefinition.fluors`) — that specific well actually has that fluor loaded, so a dye layer
  that skips some wells doesn't draw phantom lines for them. That third check can be bypassed via
  the `showUnloadedFluors` setting (the "Unloaded" `Switch` below the Fluorophores/Targets chip
  list, off by default), drawing a curve for every enabled well/fluor pair regardless of what
  the plate definition actually loads there — useful for spotting cross-talk or a mis-configured
  plate, at the cost of otherwise-meaningless curves once it's on.

  A four-way "View" toggle (`calibration`/`fluorViewMode` settings) picks channel space, one of
  two dye-space groupings, or the table (see "Table mode" below — it groups by target, like
  **Target**): **Fluorophore** labels/legends each curve by its dye name
  (`FluorBar`'s chips, keyed by fluor); **Target** instead labels each curve by the target/gene
  assigned to that fluor *in that well* (`WellFluor.target`, per `pltd.md`), so the same dye
  used for different genes in different wells appears as separate legend entries. Loaded
  well/fluor pairs carrying no target of their own get one shared `"(none)"` group instead
  (`lib/plateTargets.ts`'s `NO_TARGET`/`targetGroups()`, shared with table mode) — on by
  default like every other target, so a partially-annotated plate's remaining curves stay
  labelled and toggleable rather than showing up under their dye name with no chip. That
  catch-all is only added *alongside* real targets: on a plate with no `geneName` anywhere,
  target mode is already de facto fluorophore mode, and one lumped group would merge the dyes'
  per-group Cq thresholds — so those curves keep falling back to their fluor name (the same
  reason table mode falls back to fluorophore grouping there; see `usingTargets` below).
  Both modes keep the same channel-derived color (`FluorChip.channel`) — target mode does not
  introduce a new color scheme, just a different grouping/label built by `CurvesView`'s
  `labelForFluorCurve`/`targetInfos`. A group spanning several fluorophores (`"(none)"`, or a
  target loaded as more than one dye) has no single channel, so its chip takes
  `channelColors.ts`'s `NEUTRAL_COLOR` rather than borrowing one member's hue.

### Table mode

The former standalone **Analysis** view, folded into the Curves view as the fourth option of the
rail's "View" toggle (`fluorViewMode: "table"`). It replaces the chart with a table of one row per
visible (target, well) pair — Cq and endpoint ΔRFU, per `threshold.md` §5–§7 — while the whole rail
(targets, wells, samples, background, thresholds) keeps driving it. It was a separate tab with a
near-identical rail of its own; the two disagreed about Cq (see "One Cq per well/target" above) and
about which targets were filtered, so the tab is gone and its two unique controls — the threshold
overrides and the CSV download — moved into the Curves rail, where they apply to the chart too.

Rows come from `lib/analysisRows.ts` (`buildAnalysisRows`/`analysisCsv`), rendered by
`components/curves/CurveTable.tsx`. Table mode is dye-space-only, for the same reason "Target" mode
is: a per-target curve needs channel→dye color separation (`calibration.md`).

- **One row per (target, well) — or (fluorophore, well) with no targets assigned:** built from
  `PlateDefinition.wells[].fluors[]`, for `loaded` wells only — an unloaded pair can still be
  *plotted* ("Unloaded") but has no real measurement to tabulate. Grouping keys on
  `RunAnalysis.groupOf`: `WellFluor.target`, the shared `"(none)"` catch-all `lib/plateTargets.ts`'s
  `targetGroups()` appends (see the Curves view's target mode above) so untargeted NTC/NRT wells get
  Cq rows instead of being dropped, or — when no well on the plate has a target at all
  (`usingTargets` false) — the fluorophore itself, mirroring Fluorophore mode. In that last case the
  rail's "Targets" section relabels itself "Fluorophores" and the table drops the now-redundant
  Fluor column.
- **The same filters as the chart:** wells, sample names and the chip opt-out set are applied through
  one shared predicate (`CurvesView`'s `fluorCurveVisible`), so the table lists exactly the curves the
  chart would plot. The chips are the rail's normal `disabledFluors` set — table mode has no
  opt-out set of its own, unlike the old separate view.
- **Baseline:** always the auto-detected linear fit — `baselineCorrectCurve()`
  (`packages/core/src/analysis.ts`), which `computeCqTable()` applies internally with
  the fixed `ANALYSIS_BASELINE_MODE` constant (`"LinearBaseLineNormalized"`, no region
  argument — baselining isn't user-configurable at all, see "Baseline is always automatic"
  under Curves view): auto-detected baseline region, `baselineValid` (§7's baseline-validation
  gate — `validateBaselineRegion()` re-checked against the region actually used), corrected
  values, `baselineNoise`, `isAmplified` (forced `false` when `baselineValid` is `false`), ΔRFU
  (endpoint corrected value minus the baseline region's mean), and `baselineFit` (the fitted
  `{ slope, intercept }`, rendered via `formatBaselineFormula()`) in one call. All of it reaches the
  table through the run's Cq table, so a row's ΔRFU/Cq is the same value the chart's marker and the
  hover cards show — the same object, not a matching recomputation.
- **Cq is always §6.1's threshold crossing.** `lib/runAnalysis.ts`'s `CQ_ALGORITHM` constant is fixed
  at `"Threshold"` — the observed instrument default, and §6's own. The Analysis view's
  `"Threshold"`/`"NoThreshold"` selector is gone (§6.2's 2nd-derivative variant is still implemented
  and still reachable through `computeCqTable`, just not selectable), which is what makes a per-group
  threshold always meaningful and the override section always applicable.
- **Threshold (`thresholdMultiplier` + `thresholdOverrides` settings):** §5.1's `resolveThreshold`
  over the median `baselineNoise` across a group's own wells, in the rail's collapsible "Threshold"
  section (`<details className="rail__details">`, chevron rotates open, like the Temperature
  section). The section holds two controls. A **slider** sets §5.1's multiplier `k` in
  `threshold = k × median noise` (1–100, default 20, with a Reset link back to it): it is exposed
  rather than buried because the scale behind it rests on two anchors from a single run and it is
  the one number that shifts every Cq on the plate — the per-group thresholds below it update live
  as it moves, so its effect is visible rather than inferred. Below that, one **per-group override**
  row each. That input always carries a value — the live auto threshold when no override is set,
  greyed via `.is-auto` — rather than sitting empty behind a placeholder, because an empty number
  input steps from 0: one press of the down arrow would jump the threshold from ~200 to nothing.
  Seeded this way the arrows nudge from where the threshold actually is, in whole RFU (`step={1}`).
  A **reset** button per row clears the override and returns that group to the slider — the same
  `<ResetIcon />` the Wells section uses for "reset to the plate definition", so one glyph means
  "back to the derived default" throughout the rail. It is disabled while the row is already
  automatic. It sits in the Curves rail whenever dye space is on, in *any* of the three dye-space
  modes, because an override feeds the run's one Cq table: it moves the chart's Cq markers and the
  hover cards' numbers exactly as it moves the table's. (In Channel mode the section is hidden —
  `channelCqTable`'s groups are channels, not targets.)
- **Amplification / greying:** a row renders at reduced opacity
  (`.analysis__row.is-unamplified`) whenever it has no Cq (`cq == null`) — because the
  baseline-validation gate failed, because `isAmplified` (§7 — total rise under 10× baseline noise)
  failed, or because the curve never crossed (or didn't end above) the resolved threshold. Keying
  greying on the Cq result itself, not a separately-cached amplification flag, is what makes greying
  react live to editing a threshold override. A row is never hidden, so a well's disqualification is
  visible instead of silently dropped from the table.
- **Table/CSV columns, same order in both:** well, sample (`WellDefinition.sampleName`, the
  same field `PlateTable`'s "Sample" column shows), fluor, target (only when `usingTargets`;
  the CSV always includes it, since it's harmless there even when identical to fluor),
  [channel — CSV only, not shown in the table], baseline (`CurveBaselineResult.baselineFit`,
  rendered as a formula via `formatBaselineFormula()` — the same value the Curves view's
  tooltip shows — placed just before threshold since threshold/noise are derived from the same
  baseline region), threshold, Cq, ΔRFU, amplified. The CSV is built from the same rows via the
  shared `csvRow()` quoting helper (`lib/download.ts`) and `downloadText()` — filename
  `<run name>_analysis.csv`, the same `dataFile`-derived naming `plateReadCsvFilename` uses for the
  Raw view's per-cycle export. Its rail button is available in any dye-space mode, not just table
  mode, so the export doesn't require switching away from the chart first.

## Reference view

`ReferenceView` (`components/views/ReferenceView.tsx`) is the reference row's own chart,
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
  to a well curve's series by `channel,col` key and drawn **dotted** only in the Raw baseline
  (ΔRFU and Drift % both plot the well curve relative to it, so the factory line would be a
  flat, uninformative constant), exactly the same "pure display overlay, never subtracted"
  pattern the Dark toggle uses on the main Curves view (`darkCurves`), just keyed by column as
  well as channel since the factory value differs per reference well rather than per channel
  alone. The tooltip shows
  the matched column (`R{n}`) alongside the channel/dye for a factory series, since a factory
  line's identity isn't otherwise visible the way a well curve's label is.
- **Two baseline concepts, one `{scale, shift}` model:** `buildChart()` maps each raw value to
  plotted space as `raw * scale + shift`, computed per cycle by `wellAdjust()`. "Raw" is the
  identity (`scale:1, shift:0`). Here (Reference view), "ΔRFU" and "Drift %" are both
  factory-relative: a well curve with a matching `factoryCurves` entry subtracts the factory
  value (`shift = -factory`) for ΔRFU, or maps to `(live/factory - 1) * 100`
  (`scale = 100/factory, shift = -100`) for Drift % — the same % deviation `RefCalPanel`'s
  "Drift %" stat shows (run-averaged there, per-cycle here), so its origin is 0 like ΔRFU's, not
  100. A well curve with no matching factory value — none exist in this view today, but the
  fallback is generic — falls through to the *other* baseline concept, `curveView` (see "Baseline
  is always automatic" under Curves view above); this view always passes `curveView: "absolute"`,
  so that fallback is the identity. The factory line itself is only drawn under the raw baseline — under
  ΔRFU or Drift % it would be a flat, redundant 0, now that the well curve is already plotted
  relative to it. The same `{scale, shift}` per point is stored on each series' metadata and
  reused by the hover whisker and min/max band, so they reposition correctly under a
  multiplicative baseline instead of assuming ΔRFU's additive offset.
- **`RefCalPanel`** (`components/views/RefCalPanel.tsx`, relocated from Overview): the
  col×channel drift/factory/live grid, from `zpcr.refCalComparison()` — a run-averaged summary
  alongside the chart's per-cycle detail. Laid out as `.refcal`, a two-column flex row (text +
  stat toggle on the left, the grid on the right, wrapping to stacked on narrow containers)
  rather than stacked blocks, so the panel's height is set by the taller side instead of their
  sum — it was previously the tallest section on the page.

## Color encoding (see `lib/channelColors.ts`)

**Color encodes the channel, never the individual well.** With hundreds of lines, wells in a
channel share one hue; the hovered/nearest line is emphasized while siblings dim (uPlot
`focus.alpha`). Hovering a target/fluor chip, a channel chip, or a well-grid cell in the rail
dims every non-matching curve the same way, but driven externally rather than by cursor proximity:
`buildChart()` returns its `SeriesMeta[]` alongside the uPlot options, and `CurveChart` calls
`applyHighlight(u, meta, match)` (`lib/uplot/chart.ts`) to set each series' `alpha` directly and
redraw without rebuilding paths — cheap enough to call on every mouse move, and independent of
the single-nearest-series cursor focus above.

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
