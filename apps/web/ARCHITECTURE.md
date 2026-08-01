# Web app architecture

The web app (`@zpcrweb/web`) is a browser UI over [`@zpcrweb/core`](../../packages/core). It
loads one or more files — `.zpcr`, `.pcrd`, a Biomeme run export (`.json`, see "A third format:
Biomeme" below), or a standalone plate file (`.pltd` or zpcrweb's own `.plt.csv`, see
"Standalone plate entries and attach" below) — switches between them, and explores each through
up to six views: Overview, Curves, Plates, Reference, Calibration, and Raw (a standalone plate
file only gets Plates + Raw; a Biomeme run only gets Overview, Curves and Plates — see below).

## Format independence

**Except for the Raw views, the app is entirely format-agnostic. This is an invariant, not an
observation.**

Concretely, outside `RawFilesView`/`PcrdRawView`, the `App.tsx` line that chooses between them,
and the tab-restriction checks that narrow `ViewSelector` for a standalone plate entry or a
Biomeme run (`isStandalonePlate`/`isBiomeme` in `App.tsx` — a real capability difference: a
Biomeme `Zpcr` has no reference row or `.Dcal` calibrations for Reference/Calibration to show,
same as a standalone plate has no curves), no component may:

- branch on `LoadedFile.kind` (or otherwise ask which format a run came from);
- read `Zpcr.archive`, which a `.pcrd`-derived `Zpcr` has none of;
- read `RunResult.documentXml`, which only a `.pcrd` populates;
- read any `Zpcr` field only one decoder fills — `Zpcr.wellFactors` is the live example.

The reason is not tidiness. `.zpcr` and `.pcrd` are two containers around *the same physical
run*, so anything the app reports off one must match what it reports off the other; a number
that changes with the container is an artifact, not a measurement. This binds the analysis
pipeline especially hard — see the header comment in `lib/runAnalysis.ts`, and the `wellFactors`
note in [`calibration.md`](../../calibration.md) §4.1 for the one correction dropped to keep it
true. Verified: a `.zpcr`/`.pcrd` pair of one run agrees to ~4e-5 cycles in Cq, the residual
being only that a `.pcrd` stores well readings as text rounded to two decimals where a `.zpcr`
stores binary float32.

Where a format difference genuinely has to be *known*, it is collapsed to a format-neutral fact
at the single boundary where runs are parsed (`parseRun` in `state/useZpcrStore.ts`). The
"Encrypted" block is the model: `RunResult.selfEncrypted` is a boolean meaning "the run file is
itself an encrypted container", not the `PcrdContainer` it used to be, so `OverviewView` and
`FileBar` ask about encryption without learning that a container exists.

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
  `Zpcr` alone) for its "Encrypted" block, but only for the format-neutral
  `RunResult.selfEncrypted` flag: set for an encrypted `.pcrd`, clear otherwise, in which case
  the status comes from any embedded `.pltd`/`.prcl` entry's `container.encrypted` (via
  `zpcr.plates()`/`zpcr.protocols()`) — see `lib/encryptionStatus.ts`. Its "Run identity" block
  omits the "Archive entries" row entirely when the archive is empty, rather than reporting a
  `.pcrd`'s `EMPTY_ARCHIVE` as a misleading "0 files".
- `DecodedPlateread` (the plate-read typed view) takes just a `PlateRead` and reads everything
  off it — WELLDATA/DARKDATA tables and one "Header fields" key/value table built from
  `PlateRead.fields`, which the core decodes from a binary read's descriptor dictionary or a
  `.pcrd` read's XML header alike (see the root
  [`ARCHITECTURE.md`](../../ARCHITECTURE.md#two-input-formats-one-output-shape)). It doesn't
  touch `Zpcr.archive`, so it never has to ask whether `read.fileName` names a real file. The
  fields table is exactly two columns for both formats: the library types each untyped ICFF byte
  range once, and this view renders the result. It used to widen to eight columns for a binary
  read (offset/length/flag/int/float/text-hex, off the old `PlateReadField.binary`), which put
  ICFF layout and endianness knowledge into a component meant to be format-neutral; that raw
  view now lives behind the core's `decodePlateReadDetail()`. Only the file-structure numbers
  still branch (`read.binaryFile` — size and version words), because a `.pcrd`-origin read
  genuinely has no file behind it.
- Long values in those decoded tables stay on one ellipsized line and open a line-wrapping hover
  card (`components/raw/LongValue.tsx`, a `position: fixed` portal like the Curves view's hover
  cards, since `.decoded__gridwrap` scrolls and would clip an in-flow child). Instrument header
  values range from `12` to a few hundred characters of serial list or provenance note; sizing
  the column to the longest ruins the table, and plain CSS truncation left no way to read the
  rest at all. Values at or under 40 characters render as plain text with no hover target.
- `RunInfoTable` and `ProtocolDecoded` (`components/raw/DecodedView.tsx`) take plain
  `text: string` rather than `(zpcr, name)`, so both `RawFilesView` (`.zpcr`'s real files, by
  name) and `PcrdRawView` (a `.pcrd`'s real XML nodes, by direct reference) can feed them
  without either pretending to be the other.
- `PlatesView` takes a plain `Zpcr` too, via `zpcr.plates(password)` — a `.zpcr`'s embedded
  `.pltd`/`.plt.csv` entries and a `.pcrd`'s single embedded plate setup both come back as the
  same `PltdEntry[]` shape, so the view never branches on `kind` at all. Attaching a plate and
  downloading its `.pltd` bytes do need an archive to write into / read from, but that is asked
  as a capability (`zpcr.archive.entries.length > 0`), not as a format — see below.

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
`#cfxPassword=` URL hash key on load (same module), so scripted/UI testing never has to
click through the prompt. `App.tsx` renders the shared `PasswordPrompt`
(`components/PasswordPrompt.tsx`) in place of the view area whenever the active file's `RunResult`
has `needsPassword`/`error` instead of a `zpcr`; `FileBar` shows a lock/warning glyph for
locked/errored files in the list without blocking selection of other files. `RunResult` also
carries `documentXml` for a successfully-decoded `.pcrd` — the full raw document
(`Pcrd.xml`), which `PcrdRawView` renders and nothing else may read (see "Raw views" below and
"Format independence" above). It is the app's only genuinely format-specific payload; the rest
of `RunResult` is neutral by construction.

Each chip's hover card (protocol name, cycle count, and the plate's target/sample lists — the
same lists `OverviewView` shows in its "Plate" section, via the shared `lib/plateTargets.ts`
helper) renders through a `createPortal` into `document.body` at a `position: fixed` spot
computed from the chip's `getBoundingClientRect()` on hover/focus, rather than as a normal
absolutely-positioned child of the chip. `.filebar` scrolls horizontally
(`overflow-x: auto`), which per the CSS spec forces the other axis to compute to `auto` too —
a plain `position: absolute` dropdown would get clipped vertically by that implicit scroll
box.

## Hash routing

The active file and selected view live in the URL hash as a **query string**, not a path —
`#file=20260720_FirstQualification.zpcr&view=curves` (`state/urlHash.ts`). A query string rather than
`#/<file>/<view>` because file names contain spaces and `/`-unsafe characters, both keys are
optional and order-independent (an old link degrades instead of failing to parse), and more
shareable state can be added later without inventing path segments.

The file is identified by **name**, not by the store's `id` — `fileId()` hashes name+size, so
ids aren't portable between browsers. Files themselves live only in IndexedDB and can't be
fetched from a link, so a hash naming a file the user hasn't loaded falls back to the default
active file while still honoring the `view`.

`useZpcrStore` syncs both directions, each guarded by an "is it already that value?" check so
the echo one direction provokes in the other terminates rather than looping:

- **State → URL** is deferred until IndexedDB hydration finishes. Before that, `active` is
  still `null`, and writing would strip the incoming `#file=` before it could be honored. The
  first post-hydration write uses `replaceState` (the app choosing its own initial state
  shouldn't create a history entry); later writes `pushState`, which is what makes back/forward
  step through view switches.
- **URL → state** listens for `hashchange` *and* `popstate`: `hashchange` alone misses
  `pushState`, `popstate` alone misses manual address-bar edits.

The view is also seeded synchronously from the hash in `useState`'s initializer, so a shared
link opens on the right tab with no flash of the default one.

### `#load=<url>` — the file itself in a link

`#file=` can only name a file the recipient already has. `#load=<url>` closes that gap: the app
fetches the URL and runs the bytes through the same `addFiles` path a drop uses
(`useZpcrStore`'s `addUrl`), naming the file after the URL's last path segment. The fetch is
`credentials: "omit"` — the URL arrives in a link, so it must not be able to use the recipient's
cookies to pull something private into the page; cross-origin URLs work only with CORS, as any
other fetch would.

Unlike `file`/`view` it is an **instruction, not state**: `formatHash` never writes it back, so
it is consumed once and immediately replaced by the ordinary `#file=…&view=…` the loaded file
produces. A reload therefore reads the file from IndexedDB instead of re-fetching, and a URL
copied afterwards is a plain bookmark. Like the view, it is captured in a `useState` initializer
(first render, before any effect) so the state → URL sync can't strip it first; the fetch itself
waits for hydration, since replacing a same-named copy needs to know what's already stored.

The About/welcome card's **"Load an example file"** control is literally a link to one of these —
an `<a href="#load=…">`, not a button, so the browser's own affordances ("Copy link address",
middle-click, the status-bar target) work on it. Navigating to it is the whole mechanism; `App`'s
`loadExample` handler covers only the case where the hash already *is* that value (a repeat click
after a failed fetch), which fires no `hashchange`, and calls `addUrl` directly. So the link and
an external deep link are one code path and the resulting URL is shareable. The example is
`apps/web/public/examples/`, a symlink to the repo's `samples/` — Vite dereferences it into
`dist/` at build time, so the file is served for real without a second copy in git.

### Same name replaces

`addFiles` drops any already-loaded file with the same **name** before adding a new one. Ids
hash name+size, so an edited file (a plate attached, thresholds saved, a re-export) comes back
under a new id with the old name — without this it would sit in the file bar as an
indistinguishable second chip, and `#file=` would have two candidates to mean. This is what makes
clicking the example twice, or re-loading a file you just downloaded, do the obvious thing.

The decryption password shares this one hash query string (`#cfxPassword=…`, see the `.pcrd`
password gate above) rather than living in `?…`. A fragment is never sent to the server, so a
secret placed there can't reach access logs, proxies/CDNs or a `Referer` header;
`pltdPassword.ts` also strips it from the URL as soon as it reads it, which is why the key
never survives into the `file`/`view` hash that `writeHash` maintains.

`tools/uishot.mjs` navigates by hash for exactly this reason — one assignment per view, with no
dependence on tab label text, and `tools/uitest.mjs` asserts the whole contract above
(`npm run test:ui`). See CLAUDE.md "UI testing".

## Stack

- **React 18 API on the Preact runtime + Vite + TypeScript** — SPA, no router library; the
  selected view is global state in the store (shared across all loaded files) mirrored into the
  URL hash, see "Hash routing" above. Source
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
- Baselining (`threshold.md` §3–§4 — baseline-region selection and linear subtraction) is
  `packages/core/src/baseline.ts`, reached through `analysis.ts`'s `computeCqTable` /
  `correctCurveForDisplay`; the app never invents its own baseline math. It is not a
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
  file's own bytes. A standalone `.plt.csv` names its fluor columns by dye with no channel, and
  carries no calibration of its own to resolve them against, so its channels are simply
  **unknown** — no `channelForFluor` is passed. Nothing is inferred from column order, and the
  mapping isn't borrowed from some other run that happens to be loaded, since that would be a
  guess about a different instrument's optics. The UI says so explicitly instead (see
  `FluorChannelChip`, below).
- **Attach (replace a run's plate)** — `PlatesView`'s upload control, enabled only for a run
  that has a file archive to add an entry to (so: a `.zpcr`; a `.pcrd` gets the control disabled
  with an explanatory title, since it has no archive) —
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
- `settings` — **display state only**: `{ fileId, enabledChannels[], enabledWells[],
  enabledRefCols[], baseline, curveView, drawBaseline, scale, … }`, so each file remembers its
  enabled wells/channels/reference columns. `baseline` (Reference view's factory-relative
  ΔRFU/Drift %) and `curveView` (the Curves view's display mode — baselining itself is never
  stored, since it's always the auto-detected linear fit) are independent settings — see "Two
  baseline concepts" under Reference view. Two settings of the retired standalone Analysis view
  are simply ignored when present: `analysisDisabledTargets[]` (its own target opt-out set, since
  folded into the shared `disabledFluors`) and `analysisCqAlgorithm` (its Cq-algorithm selector —
  Cq is always §6's threshold crossing now). Writes are debounced by 300 ms. Older records may
  still carry the retired `curveBaseline`/`curveBaselineRange` fields (`state/db.ts`);
  `useZpcrStore.ts`'s `fromStored()` migrates `curveBaseline: "raw"` to `curveView: "absolute"`
  (anything else to `"relative"`) and drops the region override entirely.

Deleting a file removes both its `files` and `settings` records and drops it from memory —
exposed as a clear affordance on each file chip.

### Analysis state lives in the file, not in IndexedDB

Anything that changes a **number** the app reports is stored in the run's own archive, as a
`zpcrweb.json` entry (`zpcrweb-json.md`, `packages/core/src/zpcrwebSettings.ts`) — not in the
`settings` store above. That is `thresholdOverrides` (manual per-fluorophore threshold RFU),
`curveThresholdOverrides` (the same one curve at a time), `thresholdMultiplier` (§5.2's
auto-threshold `k`) and `calibrationNormalization` (`calibration.md` §3): the inputs
`useRunAnalysis` uses to produce a different Cq for the same run. (`subtractDark` was a fifth
until the dark-current stage was retired — `calibration.md` §4.2a. The key is still *read* so
files carrying it load, and is no longer written or acted on.)

A run loaded from a `.pcrd` also seeds `thresholdOverrides` from the file's own
`thresholdOverrideValue` per fluorophore (`threshold.md` §5.3) when it has no `zpcrweb.json` of
its own — that one value is what makes this app reproduce CFX's Cq exactly for an overridden dye.
It seeds *state* rather than feeding the pipeline: a `.pcrd` and the `.zpcr` of the same run must
still quantify identically, and a persisted threshold is a saved decision, not a measurement, so
it belongs somewhere the user can see and change it. Keeping them per-browser made a run's interpretation invisible to whoever the
file was sent to, and made clearing site data silently change the numbers.

The split is invisible to views. `state/analysisSettings.ts` defines `AnalysisSettings` and the
`ANALYSIS_KEYS` list; `FileSettings extends AnalysisSettings`, `store.settings` merges the two
halves into one flat object, and `updateSettings` routes each key of a patch to its own store —
so every call site keeps writing one `onChange({ … })` regardless of where the value lands.

- **Seeding.** A file's settings are read from its `zpcrweb.json` once it parses — which for an
  encrypted `.pcrd` means after the password lands, so the effect keyed on `runs` retries rather
  than seeding defaults over a file it couldn't read yet. The file is authoritative; local state
  never overrides it. The one exception is a one-time migration of pre-split IndexedDB records
  (`legacyAnalysisFromStored`), which applies only to a file carrying no `zpcrweb.json` and is
  then written into it.
- **Writing** is rate-limited to one archive rewrite per file per minute, plus a flush on active-
  file change, `visibilitychange` → `hidden`, and `pagehide` (`state/analysisPersist.ts`; the
  first edit to an idle file writes immediately). The rewritten bytes go to IndexedDB only —
  never back into `files` state, where they would re-parse the run and rebuild every derived
  value on each save. `size` is deliberately left at the loaded file's size so `fileId()` still
  dedupes a re-add of the same file.
- **Downloads** go through `ZpcrStore.exportBytes`, which re-zips on demand, so a copy saved from
  the Overview view carries the thresholds it was read with. A download deliberately changes
  *nothing* about the session: it does not re-seed, does not swap the in-memory bytes, and does
  not reset the persister. React state stays the single source of truth from seeding until the
  file is closed, and the flush cycle above converges IndexedDB onto it on its own schedule.
  There is nothing to "reconcile" precisely because the pre-edit document is never read a second
  time — `parseZpcrwebSettings` is called only from the seeding effect, guarded by `seeded`.
- **Displaying** the entry (the Raw view's `zpcrweb.json` row) therefore renders live state
  rather than the archive's copy — see "`RawFilesView`" below. The archive's copy is the one
  thing that is *legitimately* stale, so showing it would be showing settings nothing is being
  analyzed with.
- **`.pcrd` and standalone plate files can't hold it.** A `.pcrd` is one encrypted XML document,
  not an archive (`pcrd.md` §1) — it has its own `dataAnalysisParameters` we decode but don't yet
  write back, so analysis edits to a `.pcrd` are live for the session and then gone.

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
- **Calibration** — the run's `.Dcal` pure-dye response curves (see below). Last of the analysis
  tabs: it's the instrument's factory characterization, context for the run rather than the run
  itself, so it sits after the tabs that show what was actually measured.
- **Plates** — `PlatesView` (`components/views/PlatesView.tsx`): the visual, color-coded plate
  map (`components/plate/PlateViewer.tsx`) for every plate attached to the run, via
  `zpcr.plates()`, plus an upload control to attach/replace the run's plate (`.zpcr` only —
  see "Standalone plate entries and attach" below) and a `PlateDownloadButton`. Per-sample-type color/label/abbreviation lives in one place,
  `lib/sampleType.ts`'s `SAMPLE_TYPE_META` — grey for empty, purple for other, green for positive
  control, red for negative control, blue for unknown — shared with the Curves view's well-selection matrix (see
  below) so the two grids read the same way. A cell is colored by its sample type only when the
  well is `loaded`, and unloaded wells read as empty; the legend applies the same gate, so it
  lists exactly the colors on screen rather than types only an unloaded well carries. A sidebar lists plates when there's more than one
  (multiple `.pltd` entries in a `.zpcr`); a `.pcrd`'s single embedded plate setup shows
  directly. This is the same grid
  component (`PlateViewer`, formerly `PlateDetail`) previously embedded in the Raw view's
  Decoded mode for `.pltd` — moved to its own tab so it's reachable without hunting through the
  file list, and reused by nothing else now that Raw shows a plain table instead (see below).
  Layout: `PlatesView` uses its own `.plateview` flex layout rather than `.raw`'s CSS grid,
  because the plate-list sidebar is conditional (only multi-plate runs get one) — a grid's
  fixed column tracks would strand the lone content pane in the narrow first track when
  there's no sidebar to occupy the other. `PlateViewer` itself is a single full-width column —
  there is no side panel and no click-through well detail: everything the old panel showed
  (replicate, quantity, the fluor→channel→target mapping) is in each cell's `title` tooltip, and
  the 320px column it needed was one a narrow container could only stack below the grid. Wells
  are therefore not clickable; the hover outline stays, as a reading aid pairing with the
  tooltip.
  Cells: each well cell writes the well's `sample` and each loaded fluor's `target` directly
  into the cell, the target text colored by that fluor's channel (`channelColor`) — trading
  grid density for being able to read sample identity and target at a glance. Every cell is the
  same fixed set of lines: one for the sample name, then **one per plate fluor**, in the optical-
  channel order `PlateViewer.fluorOrder` computes (unknown channel last — the same order the
  fluor chips above the grid use). A well that doesn't carry a given fluor renders that line
  blank rather than pulling the ones below it up, so a target always sits on its own channel's
  line and a column of cells can be read down. The line count is published as the
  `--plate-fluor-rows` custom property on the table and spent by `.plate__grid td.plate__well`'s
  `height` calc, which is also what makes every row of the grid the same height — applied to
  empty cells too, so a row of untouched wells is no shorter than a loaded one. Letting cells
  size to their own content instead left the grid ragged, since a plate mixes 1-fluor and
  3-fluor wells freely.
  Header: the plate's title line, the attach/download controls, and a short `<dl>` of vessel /
  scan mode / plate type / std units. The controls are passed *into* `PlateViewer` as its
  `toolbar` prop and rendered on the title line (`.plateviewer__head`) rather than in a band of
  their own above it; the no-plate branches (password prompt, decode error) have no title line to
  share, so they render the same node above their own content. The `<dl>` deliberately omits the
  plate's target list — it is long enough to wrap to several lines, and every target it names is
  already visible in the grid below.
- **Raw** — `RawFilesView` for `.zpcr`, `PcrdRawView` for `.pcrd` (see "Raw views" below).
- **Device** — a live instrument over USB rather than a file; see "The Device view" below.
- **About** — `AboutView` (`components/views/AboutView.tsx`): one card carrying both the credits
  (name, the "nothing leaves your device" line, author and GitHub links) *and* the large
  `DropZone` plus the "Load an example file" link. About and the welcome screen used to be two
  separate screens; they're one now, so a first-time visitor sees what the app is and where their
  data goes on the same screen that asks for a file, and there's a single place to keep current.
  It's the one view with no tab in `ViewSelector` — the header wordmark is a `<button>` that
  switches to it — and the one that renders with no file loaded, so the empty state's
  `app--empty` branch shows it unconditionally. `onBack` is what distinguishes the two uses:
  `App` keeps the last non-About view in a ref and passes `onBack` only when a file is loaded, so
  "← back" returns where the user was and the welcome screen (with nowhere to go back to) omits
  the button; with a file loaded the tab strip stays visible (no tab selected) as a second way
  out. Being file-independent, it is also exempt from the standalone-plate view fallback.

### Decoded views (`components/raw/DecodedView.tsx`)

`RawFilesView`'s small router, keyed on the `.zpcr` archive entry's file name (`decodedKind`):

- **`.Plateread`** → header (cycle, block temp, timestamp) + the DARKDATA table + the
  WELLDATA fluorescence table as a per-channel plate grid with a stat selector
  (mean/std/min/max). Reads straight from the decoded `PlateRead` (found by `fileName`).
- **`.pltd`/`.plt.csv`** → `DecodedPlate` (`components/raw/DecodedPlate.tsx`) — decrypts a
  `.pltd` entry (password-gated) or picks the `.plt.csv` entry out of `zpcr.plates()` (no
  password needed; taken from `plates()` rather than re-parsed, because only that path wires up
  the archive's `.Dcal` dye→channel lookup — see root `ARCHITECTURE.md`), either way rendering
  the same `PlateTable` (`components/raw/PlateTable.tsx`) from
  the same `PlateDefinition` object model: one row per well, in plate order, with sample
  type/name/replicate/quantity and fluor→target columns. Wells carrying nothing at all are
  skipped (core's `isBlankWell`, the same test that leaves them out of a `.plt.csv`), with a
  count of the hidden ones under the table, so a mostly-empty plate reads as its handful of
  loaded wells rather than 96 rows. Plain tabular data,
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
`.pltd`'s payload (`PlateXml`), `runlog.xml`'s per-entry hover tooltip, `.pcrd`'s whole
document, and the **Text/XML mode of any raw entry whose content is XML** — goes through one
component, `XmlTree` (plus `XmlTreeFromString` for callers that start from a raw string rather
than parsed `Element`s). Built on the native `DOMParser` (same BOM/declaration-stripping trick
as before), each element is its own React component with its own open/closed `<details>` state;
children are only turned into React elements when their parent is open, so a closed subtree
costs ~O(1) regardless of size — a `.pcrd`'s `calibrationCollection` (~1.4 MB of deeply nested
elements in the real sample) collapses by default and costs nothing until opened. A node starts
open when it has at most `DEFAULT_OPEN_MAX_CHILDREN` (4) element children, so anything wide
lands collapsed behind an "N children" count; the rule is generic, not tuned to any one
format's tag names.

**A document's own root is exempt and always starts open**, however wide — otherwise opening
`RunInfo.xml` (66 children) lands on a single collapsed line that says nothing about the file,
and the first click is always the same one. The exemption applies only when there *is* one
root: `parseXmlFragment` wraps the payload in a synthetic root and hands back its children, so
a fragment of many top-level siblings (`runlog.xml`'s 92 `<Log>` records, `.pcrd`'s `logEls`)
arrives as many roots, none of which is *the* root — those keep the child-count rule, since
expanding all 92 would defeat the collapsing entirely.

**The flat `<pre class="raw__dump">` is for hex dumps and genuinely plain text only** — never
for XML. Which one a raw text view uses is decided by `looksLikeXml(text)` sniffing the
*content*, not the file name, because extensions lie in both directions here: a `.zpcr`'s
`.alf` and `ProtocolRunDefinition.txt` are line-oriented plain text, while the payload
decrypted out of a `.pltd`/`.prcl` is XML that never had a `.xml` name. `uitest.mjs`'s "XML
rendering" group pins this down from both sides (XML entries render `.decoded__xml` with
collapsed nodes; `.txt` stays a dump) — a flat dump of XML is readable enough to regress
unnoticed otherwise.

### `RawFilesView` (`.zpcr`)

Unchanged in spirit from before `.pcrd` support: groups `zpcr.archive.entries` (Metadata /
Analysis / Plate setup / Plate reads / Calibration / Other). Each file opens in its **best
default mode** (`RawFilesView.defaultMode`) with Decoded / Text / Hex always switchable: a typed
**Decoded** view where one exists (`DecodedView.tsx`, above), else **Text** for textual files
(`.xml`/`.txt`/`.alf`/`.json`/`.plt.csv`), else **Hex** (`archive.hexDump`, paginated). Text
mode renders the collapsible XML tree whenever the content is XML (`RunInfo.xml`, `runlog.xml`,
`GlobData.xml`, and the decrypted `.pltd`/`.prcl` payloads, which label the mode "XML") and the
plain dump otherwise.

**`zpcrweb.json` is the one synthesized entry** (its own "Analysis" group, sorted just above
Plate setup). It is listed whether or not the loaded archive contains it, and its Text/Hex
content is generated from *live* analysis state — `formatZpcrwebSettings(zpcrwebFromAnalysis(
settings))`, the same serializer `writeZpcrwebSettings` uses — rather than read from
`zpcr.archive`. That is the only way the row can be honest: analysis settings live in React
state and are written back into the archive bytes in IndexedDB by `analysisPersist.ts` at most
once a minute, so the copy embedded in the bytes this view parsed is routinely absent or stale
(see "File-backed analysis settings" and `zpcrweb-json.md`). What's shown is byte-identical to
what `exportBytes` writes into a downloaded copy, modulo the write-time `updatedAt` stamp.
`RawFilesView` therefore takes `settings` alongside `zpcr`.

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

## One analysis per run: `lib/runAnalysis.ts`

**The rule: analysis is computed once, here, by the library — and every other module in the app is
downstream of it.** Nothing else calls `baseline.ts`/`threshold.ts`, and no view derives a
baseline, noise estimate, threshold or Cq of its own, not even for something as apparently
cosmetic as where to draw a line. A curve's analysis travels with it as one record
(`CurveAnalysis`), and a view's job is to project that record onto the screen.

This is enforced by construction rather than convention: `lib/uplot/chart.ts` imports no analysis
function at all, and what it plots in the "Relative" view *is* `CurveAnalysis.correctedValues` —
the very array the Cq was computed from — rather than a re-derivation that happens to agree.

The rule exists because the two implementations that used to coexist drifted, silently and
visibly:

- The chart ran its own copy of baseline-region selection, subtly different from the analysis's.
  On `20260726`'s well A4 / Texas Red that was cycles 2–28 against 11–28: two different fitted
  lines, and a plotted curve sitting ~17 RFU below the one the Cq had been taken on — so the
  rail's threshold line (48.6 RFU) passed well above a Cq ring drawn at 31.7.
- The Cq ring was then placed by interpolating the plotted curve at the fractional Cq rather than
  by reading the threshold, a second, independent disagreement.
- On a log scale, `logFloor` lifted **each curve** by its own offset while the threshold line was
  drawn at the bare threshold value, so the line was at the right height for no curve at all.

All three were arithmetic that was individually reasonable and collectively inconsistent, which is
what re-derivation buys. The fixes were structural, not local: the chart consumes the analysis, the
Cq ring is placed *at* `(cq, threshold)` and projected through `SeriesMeta.plotDelta` (so it lands
on the threshold line by construction rather than by agreement), and the log-scale shift became one
shared constant for the whole plot.

`useRunAnalysis(zpcr, settings, pltdPassword, activeStep)` is that single run-level
derivation, shared by the Curves view's chart, hover cards and table mode: plate + password state,
fluorophore/target groups
(`lib/plateTargets.ts`), the calibration matrix and `calibration.md` §4 corrections, the
color-separated `allFluorCurves` — and, on top of those, the run's **Cq table**.

- **`cqTable`** — `packages/core/src/analysis.ts`'s `computeCqTable()` over *every* well/dye pair on
  the plate, keyed by `curveKey(row, col, fluor)`. One entry per key: Cq, the §5.2 group threshold,
  noise, ΔRFU, end-point RFU and the fitted baseline. Views look values up in it and never
  recompute — that is the whole point. A group's threshold is the median baseline noise across the
  curves it's computed with, so the old arrangement (three independent computations over the plotted
  curves, over every curve, and over the standalone Analysis view's enabled wells) had the same well
  showing a Cq in one place and "—" in another. Display filters — enabled wells, disabled targets, sample and
  fluor toggles, the view-mode switch — now change only which entries are *shown*.
- **`plainBaselines`** — the same `baselineCorrectCurve()` call, for the plotted series that carry
  no Cq: the raw per-channel curves (`channelCurveKey`) and the dark overlay (`darkCurveKey`). The
  "Relative" view baselines whatever it is plotting, channel space and the dark line included, so
  those series need a baseline even though they will never be quantified — and it must be the same
  baseline the rest of the app would compute, which is exactly what a second implementation in the
  chart failed to be. Like the Cq table, it is built over the whole run, not the plotted subset.
- **`CurveAnalysis`** is the union of the two: `CurveBaselineResult` plus optional `cq`/`threshold`.
  A dye curve's record is its `CqTableEntry` (both present); a channel or dark curve's is the
  baseline-only kind. One optional type means the chart treats every series identically and
  "quantified" is simply `threshold != null`.
- **Grouping** is two separate things, deliberately. `groupOf(row, col, fluor)` is the *display*
  group — the pair's target/gene, the shared `"(none)"` catch-all when it has none, or the
  fluorophore on a plate with no targets — and organizes chips, table rows and colors.
  `thresholdGroupOf` is the **threshold** group and is always the **fluorophore**. Baseline noise is
  a property of the dye and the optics; a target is a biological label on the same measurement, so
  grouping thresholds by target split one dye's wells into cohorts differing only in what they were
  called: on `20260720_FirstQualification.zpcr` the three Tex 615 wells carry two targets and got
  thresholds 162 and 49 RFU for near-identical curves, with one cohort a single well. It also
  matches the format — CFX
  persists `thresholdOverrideValue` per `fluorId`, never per target. `thresholdOverrides` is
  therefore keyed by fluorophore name; `curveThresholdOverrides` goes one level finer (see
  "Threshold section" below) and is keyed by `curveKey`. Both are independent of the Curves view's
  Fluorophore/Target *display* mode, which used to re-group the thresholds under the chart and so
  produce different Cq values than the table for the same wells.
- **Noise cohort:** only well/fluor pairs the plate actually loads (`loadedFluors`) contribute to a
  group's threshold, via `CqTableCurve.contributesToThreshold`. Pairs the plate never loaded still
  get their own entry — the Curves view can plot them with "Unloaded" on, and they need a Cq — but a
  dye that was never pipetted into a well doesn't set the bar for the wells that were. That's a
  data-validity gate, not a user filter.
- **No channel-space analysis, at all.** There was a second table, `channelCqTable`, running the
  same computation over the raw *channel* curves so the Curves view could mark Cq while color
  separation was off. The arithmetic was real, the quantity wasn't: a raw channel reads everything
  emitting into that filter, so an optical channel the plate assigns **no fluorophore** to still
  produced a confident-looking Cq — one belonging to whichever neighbouring dye was bleeding into
  it. Quantification is per-fluorophore *after* color separation, which is what the separation is
  for, and CFX reports it that way too. Channel space is now purely a look at the raw signal: no
  Cq, no threshold, no quoted baseline fit. A channel curve's `PlotCurve.analysis` is the
  baseline-only `plainBaselines` record — enough to plot it in the "Relative" view, with `cq` and
  `threshold` absent — so the chart's Cq ring, the tooltip's Cq and baseline rows and the rail
  hover cards' Cq column all drop out together (`HoverCardRow.cq` distinguishes `null` — "has no
  Cq", shown as "—" — from `undefined`, "Cq doesn't apply", which hides the column).
- **The dye-space solve is unconditional.** It used to be skipped while the Curves view was showing
  channel space (`dyeSpace`, a fifth parameter) since one pseudo-inverse per well per cycle is real
  work. It no longer is: the target thresholds and the CSV export are target-based in *every* view
  mode and both read `cqTable`, which is empty without it — and `OverviewView` already pays for the
  same solve on every run.

## A third format: Biomeme

`@zpcrweb/core`'s `parseBiomeme` decodes a Biomeme handheld device's run-export JSON into the
same `Zpcr` shape `parseZpcr`/`parsePcrd` produce (see the root
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#a-third-non-cfx-input-biomeme) and
[`biomeme.md`](../../biomeme.md)), so `useZpcrStore` routes it through the exact same
`RunResult`/`useRunAnalysis` pipeline every other run uses — a `.json` file only reaches
`parseBiomeme` after `isBiomemeJson()` sniffs its content (the extension alone is too generic a
signal; see `fileKind()` in `state/useZpcrStore.ts`), and from there on almost nothing in the app
needs to know it isn't a `.zpcr`. Two real differences do surface, both because they're
capability checks rather than format checks:

- **Fewer view tabs.** `App.tsx`'s `isBiomeme` restricts `ViewSelector` to Overview/Curves/Plates
  — Reference has no reference row to show, Calibration has no `.Dcal` set, Raw has no archive
  (`Zpcr.archive` is honestly empty, the same "nothing here" `.pcrd` already models). The same
  pattern `isStandalonePlate` already used for a bare `.pltd`/`.plt.csv` entry.
- **`Zpcr.dyeSpace`**, checked once in `useRunAnalysis` — see the next section — and
  **`WellCurve.fileAnalysis`**, read by the Curves view's file/computed toggles — see "File vs.
  computed analysis" under Curves view below.

A third thing follows from the *shape* of a Biomeme run's synthesized plate rather than from any
flag: `PlateDefinition.rows`/`columns` are `1` and (typically) `3`/`6`/`9` rather than the `8`/
`12` every `.zpcr`/`.pcrd` plate has always had, and the well-selection grid and plate map size
themselves to that instead of assuming a fixed 8×12 shape:

- `components/curves/WellMatrix.tsx` takes `rows`/`cols` props (defaulting to `8`/`12`, so every
  existing call site is unaffected) and uses them everywhere a loop used to hardcode `ROWS`/
  `COLS` — the grid's `--cols` custom property, the corner "toggle all", the row/column toggle
  buttons, the cell grid itself. A plate with exactly one row drops the row-letter header and
  cell-label prefix (`cellLabel()`) rather than showing an always-`"A"` column, but the header
  *button* for that row is still rendered (empty) — CSS grid auto-placement has no way to leave a
  gap for a genuinely omitted element, so removing it outright would shift every cell in that row
  into the reserved header column instead. Clicking it still toggles the (only) row, which is the
  same thing the corner button already does, so nothing is lost by leaving it live.
- `components/plate/PlateViewer.tsx` (the Plates view's grid) already read `plate.rows`/
  `plate.columns` rather than hardcoding a size, so a Biomeme run's plate map was correctly
  sized with no change; the one addition is the same single-row row-letter suppression, safe
  here as a blank `<th>` since an HTML `<table>` has no auto-placement hazard to work around.
- `CurvesView`'s own `isHoveredWell` check builds its own well-label string to compare against
  `WellMatrix`'s hover callback rather than reading a curve's `.wellLabel` field, so it has a
  `cellLabel` mirroring `WellMatrix`'s (and `biomeme.ts`'s `singleRowAwareLabel`) rather than
  always calling core's row-letter-always `wellLabel()`. Three copies of the same one-line rule
  is duplication that would be worth centralizing if a fourth format needed it; for now each side
  (core's synthesized `WellDefinition.label`, the app's hover label, the app's plate-map header)
  independently agrees on "no letter when there's only one row" because there's no shared
  formatting entry point between core and the app to hang one function on without adding an
  export purely for this.

### Dye-space sources skip color separation

A CFX reading is a raw 6-channel vector `calibration.md`'s solve unmixes into per-dye
concentrations; a Biomeme reading is per-fluorophore already, so there is nothing to solve.
`useRunAnalysis` checks `zpcr.dyeSpace` once, near the top, and branches the one stage that
differs:

- `calibratedFluors` is `fluorCals` unfiltered (every fluor counts as usable — there is no
  `.Dcal` match to have failed, so gating on `FluorCalibration.curve` the way a CFX run does
  would hide every fluor), and `calibrationAvailable` follows from that.
- `matrix` is skipped outright (`dyeSpace || calibratedFluors.length === 0`) rather than built
  and then discarded.
- `allFluorCurves` comes from `lib/fluorCurves.ts`'s `dyeSpaceFluorCurves()` instead of
  `computeFluorCurves()` — a relabelling of `allCurves` (each `WellCurve.channel` is already a
  fluor index; `dyeSpaceFluorCurves` just resolves it back to a name via the plate's `fluors[]`
  and carries `WellCurve.fileAnalysis` through untouched), not a solve.

Everything past that point — `cqTable`, the chart, the table, the CSV export, the rail's
Wells/Targets/Samples/Threshold sections — reads `allFluorCurves` the same way regardless of
which path produced it, which is the point: a dye-space run needs zero changes below
`useRunAnalysis`. The one place a *view* still has to ask is where it would otherwise gate on
`FluorCalibration.curve` for something other than the solve itself — three spots in
`CurvesView.tsx` (`calibrated` on rail chips, the Threshold section's row filter, and the "no
.Dcal calibration matches" notes) — those add `dyeSpace ||` because "no curve" means something
different for the two kinds of run: "the separation failed to match" for a CFX run, nothing at
all for one that was never going to separate.

Note this is an unrelated concept to the identically-named parameter `computeFluorCurves` used
to take (removed; see "One analysis per run" above) — that one meant "the Curves view is
currently displaying dye space rather than channel space", a *display* mode. `Zpcr.dyeSpace` is
a fact about the **source**, permanently true or false for a given run regardless of which mode
the view happens to be showing.

## Curves view

Data flows `zpcr.curves({ includeReference:false })` + `zpcr.darkCurves()` → filter by
enabled channels/wells → `lib/uplot/chart.ts` `buildChart()` → `CurveChart` renders +
overlays a tooltip. The reference row is excluded here — it has its own chart in the
**Reference** view (below), so `Toggle` (`components/Toggle.tsx`) and `CurveChart` are the
only pieces the two views share.

- **Selection:** a channel bar (6 dye-labelled toggles) and a well matrix (`WellMatrix`, 8×12 for
  a CFX plate, sized to the run's actual plate otherwise — see "A third format: Biomeme" above)
  whose row and column headers toggle whole rows/columns, plus an all/none corner. Once the
  plate definition is available (password permitting), each cell is tinted by
  `SAMPLE_TYPE_META` (see **Plates** below) so selection state reads alongside sample type; a
  reset button next to the "Wells" label restores the selection to exactly the plate's
  non-empty wells. The matrix sits directly under the View toggle, above the channel/target bar:
  besides being the selection reached for first, it doubles as a positives map — a well holding
  any curve the run's Cq table gave a Cq is marked with a `+` in its own sample-type color
  (`WellMatrix`'s `positiveWells`), so a positive NTC reads red. The mark is a drawn SVG cross,
  not a glyph, so it centers on the cell rather than on a text baseline, and it is faded by
  `plusOpacity()` of the well's *lowest* Cq: full strength at Cq ≤ 20, down to 0.35 by 30 and
  0.12 at 35 and beyond, so an early strong positive reads at a glance against a late marginal
  one. `positiveWells` maps well key → min Cq and comes from `cqTable`, not from the plotted
  subset, so rail filters don't make the marks come and go.
  `CurvesView` applies that same non-empty-wells set as the one-time default
  the first time a file's plate loads (only while the selection still looks like the untouched
  "all wells" default, so a previously customized selection is left alone). Channel mode mirrors
  this: the default `enabledChannels` (and its reset button, next to "Channels"/"Targets"/
  "Fluorophores") is the intersection of the run's available channels and `PlateDefinition.
  fluors[].channel` — the channels the plate configuration actually assigns a dye to — rather
  than a hardcoded 1–5. The same button resets dye-space mode by clearing `disabledFluors`
  instead, since there every fluor/target is enabled by default already.
- **Baseline is always automatic — no mode or region is user-configurable.** Every curve is
  baseline-corrected with `packages/core/src/baseline.ts`'s `LinearBaseLineNormalized` over the
  region `threshold.md` §3 derives: cycle 3 to the last cycle for a well with no Cq, or to
  `round(Cq) − 2` for one that has it. There used to be a three-way mode selector
  (Raw/Constant/Linear) plus a manual region-override slider; both were removed — the
  manual-region override, in particular, made it easy to silently understate a region's real noise
  and produce a spuriously early or missed Cq (see the git history around the retired
  `BaselineRangeSlider`/`curveBaselineRange` for the worked example that motivated dropping it).
- **`CurveView` setting (`"relative"` default / `"absolute"`, labelled "Values" in the rail —
  the mode toggle above already owns "View"):** what the chart *displays* —
  `"relative"` plots the baseline-corrected curve, `"absolute"` plots the curve's raw RFU
  unmodified. This is purely a display choice: Cq/ΔRFU/noise/threshold in both the chart's own
  markers and the Analysis table are always computed from the corrected values regardless of
  which is shown (`lib/cq.ts`'s `ANALYSIS_BASELINE_MODE` constant, fixed at
  `LinearBaseLineNormalized`). This is a genuinely different concept from the Reference view's
  ΔRFU/Drift %, which are factory-relative, not a fitted baseline — see "Two baseline concepts"
  under Reference view below. Also Relative ↔ Log (uPlot `distr: 3`).
  - *Log + baseline:* a relative (baseline-corrected) curve can go ≤ 0, undefined on a log axis,
    so every RFU series is shifted up by **one shared constant** (`applyLogFloor` in
    `lib/uplot/chart.ts`), enough for the lowest point anywhere on the plot to read 1, with an
    inline note. A no-op when nothing on the plot is non-positive (absolute view is unaffected).
    Shared rather than per curve: lifting each curve by its own minimum looked tidier but gave
    every curve a different y offset, so two curves at the same RFU drew at different heights, the
    axis labels described no curve in particular, and one threshold could not be drawn as one line
    — it sat at a different pixel row per curve, which is how the rail's dotted line came to miss
    the Cq rings on a log scale.
- **`drawBaseline` setting (off by default):** overlays each well curve's fitted baseline
  (`CurveAnalysis.baselineFit`, looked up — never re-fitted) as a separate uPlot series, at 50%
  opacity of the curve's own color
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
  A pure display overlay — it never alters the plotted well curves or the y-axis label. The
  "Show dark" `Switch`: off (default) draws nothing; on draws one **dotted**
  dark line per present channel, transformed like the curves (so it still tracks the baseline
  mode/log). Channel-space only, like the min/max bands, so it only appears when color
  separation is off.
- **Min/max band (`bands`, off by default):** shades each plotted curve's per-cycle min/max
  envelope — including each dark overlay's, when "Show dark" is also on: a DARKDATA record
  carries the same per-cycle min/max over the LED-off wells that WELLDATA does over the lit ones
  (a few tens of RFU wide in the committed samples), so a dark line drawn without its band would
  be the one curve on the plot claiming a spread it hasn't got. *On this view* channel-space
  only, like the dark overlay; the Reference rail offers the same switch over the same setting
  (see "Reference view" below), the way "Show dark" is shared. A plain on/off `Switch` alongside
  it —
  it used to be a three-way `off`/`auto`/`on` mode whose `auto` drew the bands only when a
  single well was selected, which made one control's effect depend on another's state;
  `fromStored` migrates a stored `"on"` to `true` and everything else to `false`.
- **Right axis — temperatures *or* LED currents:** the chart has one auxiliary axis, and two
  things can occupy it: `zpcr.temperatureCurves(step)` (one series per temperature field) or
  `zpcr.ledCurves(step)` (one per optical channel's excitation-LED drive setting, in DAC counts).
  Both are mapped by `lib/rightAxis.ts` onto the format-agnostic `AuxCurve`/`AuxAxis` pair
  `lib/uplot/chart.ts` draws, so the chart knows only that some series ride the right scale — it
  names neither temperatures nor LEDs. Chips in two collapsible rail sections toggle each series
  (all off by default — instrument context, not the measurement) and preview its latest value via
  the shared `AuxBar`.
  - **Mutually exclusive, enforced in the store.** °C and DAC counts share no scale, and a second
    right axis would eat plot width and make the reader check which axis a dashed line belongs to.
    So filling either key set empties the other, in `useZpcrStore`'s `updateSettings` rather than
    at each call site — no control can leave both on, and a persisted record can't either.
  - Selected series are drawn **dashed** on a second uPlot scale whose axis appears only when
    something is selected — so the RFU scale is never distorted by a 105 °C lid. Set points (fan
    on/off thresholds) are dimmed, finer-dashed and labelled as such.
  - **Colors:** temperatures use `lib/tempColors.ts`, a cool ramp deliberately outside the dye
    palette. LED currents instead borrow their own channel's hue (`channelColor`) — an LED current
    *is* a property of one optical channel, so `Ch3`'s dashed LED line matching `Ch3`'s solid well
    curves is the point; the axis is labelled in DAC counts and every series is named in the rail
    and the hovercard, so the shared hue can't be read as a fluorescence value.
  - The axis' `AuxAxis` is built from the *full* series list and then filtered to what's enabled
    (`selectAux`), so a series' color doesn't shift as its neighbours are toggled — the positional
    temperature ramp would otherwise recolor lines behind the user's back.
- **Samples:** a collapsible rail section (collapsed by default, like Temperatures) listing every
  distinct `WellDefinition.sample` name actually assigned to a well on the plate (`pltd.md`'s
  `conditionName` — despite the XML attribute name, this is the sample name CFX Manager's UI
  shows). `SampleBar` chips toggle an opt-out set (`disabledSamples`, all shown by default,
  mirroring `disabledFluors`); a well with no `sample` set is never hidden by this filter, since
  there's no chip for it. Its section header carries the same `<ResetIcon />` re-enable-all button
  as Channels/Targets and Wells, rather than the "all"/"none" text link it used to — one glyph
  meaning "back to the default" throughout the rail, and a label that doesn't change under the
  cursor. Applies to both channel- and dye-space curves alike (`sampleVisible()`,
  consulted by both `visibleChannel` and `visibleFluor`).
- **Cq range (`components/curves/CqRange.tsx`, settings `cqMin`/`cqMax`, both `null` = off):** a
  double-ended slider, dye space only, that hides every curve whose Cq falls outside the range —
  the rail's one filter over a *derived* number rather than over plate metadata. It sits just
  above "Subtract dark" and, like it, applies in table mode too: the bounds enter the shared
  `fluorCurveVisible` predicate, so the chart, the table and the CSV export show the same set.
  Purely a display filter even so — thresholds and Cq are computed over the whole plate
  (`runAnalysis.ts`) and never over the plotted subset, so narrowing the range can't move a
  number.
  - The slider's stops are the run's cycles **plus one past the last**, which is where the curves
    with no Cq at all live: an upper bound of `null` (that top stop, the default) keeps them, any
    real bound drops them. That's also what makes "only the curves with no Cq at all" a
    reachable state — park the *lower* handle on the top stop and no real Cq can satisfy it. A
    plain pair of number fields could express neither, since "no Cq" isn't a number; on a Cq axis
    it has an obvious place, past every real value.
  - Bounds are stored as `null` rather than as the cycle count they were dropped at, so
    "unbounded" survives a switch to a step with a different number of cycles; `CqRange` clamps
    whatever it's given to the current track. Two overlaid native `<input type="range">`s, each
    clamping against the other on change so the handles can't cross, with pointer events on the
    thumbs only — see `.cq-range` in `app.css` and `uitest.mjs`'s `cqFilterChecks`.
- **Rail chip bars — one component, four adapters.** `ChannelBar`, `FluorBar`, `SampleBar` and
  the Reference view's `RefColBar` are thin mappings from their own domain onto a `Chip`
  (`key`/`label`/`sublabel`/`color`/`on`/`selectable`), rendered by the shared
  `components/curves/ChipBar.tsx`. They were four near-identical copies of the same markup and
  handlers, which is how `RefColBar` drifted into a bespoke per-chip "only" button while the
  other three grew double-click solo, hover peek and hover cards. The interaction contract now
  lives in one place and is therefore identical everywhere: **click** toggles, **double-click**
  solos (`onSolo`), **hover** both dims the rest of the chart and *peeks* — every view lets the
  hovered chip's curves bypass its own disabled check, so hovering a turned-off chip shows it
  temporarily (only its own check: peeking a disabled target doesn't also reveal wells the user
  turned off). What stays in each view is the **reset** button beside the section title, since
  the default selection is a property of the view's data (plate-derived on the Curves rail,
  not on the Reference rail), not of the chips. `uitest.mjs`'s `referenceChecks` covers the
  peek and solo — both are transient states of the plotted set, invisible to a screenshot.
- **Rail hover highlight and hover cards:** hovering a chip/cell in any rail section (channel,
  fluorophore/target, well, sample, or reference column) dims every plotted curve that doesn't
  match, via `HighlightMatch`/`applyHighlight` (`lib/uplot/chart.ts`) — `"sample"` and
  `"refcol"` match variants join the pre-existing `"target"`/`"well"`/`"channel"` ones, the
  former keyed by the well's `PlotCurve.sample` (which
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
  mean, plus min/max/std **only where those exist** — or, for a temperature, just its °C.
  Spread is a channel-space property: a color-separated curve is one solved concentration per
  cycle (calibration.md §5), not a distribution, and the baseline overlay, factory reference and
  temperature series have none either. `PlotCurve.std/min/max` are therefore optional and left
  absent rather than filled with `mean`/`mean`/`0` as they once were — a "collapsed" envelope
  still draws, as a zero-height hover whisker and three tooltip rows restating the mean, which
  reads as a measured zero spread instead of no measurement. Band, whisker and rows now drop out
  together. The search projects each series
  through **its own** scale, so proximity is measured in pixels across both axes. A well
  series also carries its `analysis` record (see "Table mode" below); for a quantified curve the
  tooltip adds a "baseline" row (the fitted linear baseline, rendered as a formula — see
  `CurveBaselineResult.baselineFit`/`formatBaselineFormula()` above) right before a Cq row, and
  the chart draws a small ring at that curve's `(cq, threshold)` — the crossing point *by
  definition*, projected into plotted space through `SeriesMeta.plotDelta`, so the ring sits on the
  curve and on the rail's threshold line without either being re-derived from the other
  (`cqMarkers` in `buildChart()`). A curve with no Cq — one whose corrected trace never crosses its
  threshold, in either direction — gets no ring.
- **Color separation (dye space) and the channel/fluorophore/target selector** (also labelled
  "View" in the rail, distinct from the baseline `CurveView` toggle above): `lib/fluorCurves.ts`
  matches
  the plate's fluorophores to this run's `.Dcal` data, builds one calibration matrix per step
  (restricted to the scanned channels, so its RFU scale factors are measured over the right
  rows), and solves every well/cycle — see [`calibration.md`](../../calibration.md). `CurvesView`
  assembles the §4 corrections that go in first: the per-scan reference level from the reference
  row: the per-scan reference level from the reference row, and nothing else.

  There is deliberately **no dark-current control**. A "Subtract dark" toggle used to sit here,
  off by default; it is gone, because the choice is now measured rather than open. Subtracting the
  per-cycle `DARKDATA` makes the reconstruction of CFX's own exported curves **260× worse**
  (median residual 7.3e-3 → 1.90 RFU): the dark level is re-read every scan and its scatter is
  random noise no linear baseline can absorb (`calibration.md` §4.2a). A *constant* background,
  meanwhile, is removed by baselining before any number is reported, so choosing one cannot change
  a result. `DARKDATA` remains a plotted overlay and an instrument-health diagnostic. (Per-well
  gain factors are likewise not passed: they are a `.pcrd`-only field, and feeding them in would
  make the same run quantify differently depending on which file you opened.)

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

  A four-way "View" toggle (`calibration`/`fluorViewMode` settings, defaulting to **Target**)
  picks channel space, one of two dye-space groupings, or the table (see "Table mode" below — it
  groups by target, like **Target**): **Fluorophore** labels/legends each curve by its dye name
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
visible (target, well) pair — Cq, endpoint ΔRFU and §7's End RFU — while the whole rail
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
  Target column (the group *is* the fluorophore, already in the Fluor column).
- **Every column sorts:** clicking a header sorts by it, clicking again reverses; the active column
  draws ▲/▼ and carries `aria-sort`, the rest a faint ↕ that only appears on hover, so the headers
  advertise sorting without eight arrows competing with the labels. Two rules sit on top of the
  comparison: sorting by Cq parks the wells that have none at the bottom in *both* directions, and
  plate position is the final tiebreak everywhere, so equal values keep a stable A1→H12 order.
  Well sorts on that position number, not its label — `A10` after `A2`. The sort is component
  state, not a settings/URL key: it's a way of reading the table, not a property of the run.
  Covered by `tools/uitest.mjs` (`tableSortChecks`), since row order is exactly what a screenshot
  can't check.
- **Colour is borrowed, never invented.** Fluor and Target render as chips in the optical-channel
  hue (`channelColor`) their curve is drawn in, so a row matches its line in the chart; the Type
  chip and the row's background wash use `SAMPLE_TYPE_META`, the same palette the plate map paints
  wells with, so controls separate from unknowns without reading a word. ΔRFU carries a bar scaled
  to the largest endpoint in the whole table (not the sorted page), so amplitudes compare down the
  column. All of it is `lib/` colour data reused through one `--c`/`--rowc` custom property per
  chip/row (see `.atbl*` in `app.css`) — no palette lives in the table.
- **ΔRFU and End RFU are different numbers, and both are shown.** ΔRFU is the last corrected
  value's rise above the baseline; End RFU is the mean of the last five corrected cycles
  (`threshold.md` §7), which is what the instrument's own End Point export reports. On a
  still-climbing well the two differ by hundreds of RFU, so neither substitutes for the other.
- **Cq is a position, not just a number:** each Cq sits on a track spanning cycle 1 → the last
  cycle the active step read (`cycleCount`, derived from the curves rather than the protocol, so a
  run stopped early gets the axis its data actually has), with a marker where that well crossed.
  It's the chart's own x domain, so the cue reads as "when did it cross"; sorting by Cq lines the
  markers into a diagonal. The number beside it carries the same signal redundantly as brightness
  along `--ink` → `--ink-muted`, which puts "late but real" and "never crossed" on one continuum.
  A well with no Cq keeps an empty track — the axis with nothing on it *is* the statement.

  Deliberately position rather than a colour ramp: hue is already spent on channel and sample
  type, and a green→red Cq scale would assert a verdict the app has no basis for — whether "late"
  is bad depends on the assay and on a user-set threshold, and a Cq only compares within a target,
  so any table-relative scale would mislead across targets. An absolute cycle axis is a
  measurement, not a judgement.
- **Sample type travels with the row:** `AnalysisRow.sampleType` comes straight from
  `WellDefinition.sampleType`, and is exported in the CSV as its own column.
- **The same filters as the chart:** wells, sample names and the chip opt-out set are applied through
  one shared predicate (`CurvesView`'s `fluorCurveVisible`), so the table lists exactly the curves the
  chart would plot. The chips are the rail's normal `disabledFluors` set — table mode has no
  opt-out set of its own, unlike the old separate view.
- **Baseline:** always the auto-detected linear fit — `baselineCorrectCurve()`
  (`packages/core/src/analysis.ts`), which `computeCqTable()` applies internally with the fixed
  `ANALYSIS_BASELINE_MODE` constant (`"LinearBaseLineNormalized"` — baselining isn't
  user-configurable at all, see "Baseline is always automatic" under Curves view): the §3 baseline
  region, the corrected values, `baselineNoise`, ΔRFU (endpoint corrected value minus the baseline region's mean),
  `endRfu` (§7's end-point RFU, the mean of the last five corrected cycles) and `baselineFit` (the
  fitted `{ slope, intercept }`, rendered via `formatBaselineFormula()`). All of it reaches the
  table through the run's Cq table, so a row's ΔRFU/Cq is the same value the chart's marker and the
  hover cards show — the same object, not a matching recomputation.
- **Cq is always §6's threshold crossing**, the observed instrument default and now the only
  algorithm the library implements. The Analysis view's `"Threshold"`/`"NoThreshold"` selector is
  gone and so is the second algorithm behind it (`threshold.md` §10), which is what makes a
  per-group threshold always meaningful and the override section always applicable.
- **Threshold (`thresholdMultiplier` + `thresholdOverrides` + `curveThresholdOverrides`
  settings — all stored in the run's own `zpcrweb.json`, not IndexedDB; see "Analysis state
  lives in the file" above):** §5.2's `resolveThreshold` over the median `baselineNoise` across a fluorophore's own
  wells, in the rail's collapsible "Threshold" section (`<details className="rail__details">`,
  chevron rotates open, like the Temperature section), rendered by
  `components/curves/ThresholdSection.tsx`. A **slider** at the top sets §5.2's multiplier `k` in
  `threshold = k × median noise` (1–100, default 20, with a Reset link back to it): it is exposed
  rather than buried because it is the one number in the pipeline with no measurement behind it —
  the instrument's own automatic rule is known *not* to be of this form (§5.2) — and it is
  the one number that shifts every Cq on the plate — the thresholds below it update live as it
  moves, so its effect is visible rather than inferred.

  Below that, **one row per fluorophore, expandable to the curves behind it** (its own chevron
  button, not a nested `<details>`, so the row stays hoverable as one unit). A fluorophore's
  threshold is a median over exactly the curves listed under it, and each curve's line shows the
  two numbers that median is made of: its own baseline region (`cycles a–b`, plus a ⚠ when the
  whole corrected curve sits *above* this threshold, so it can never cross it — `threshold.md`
  §A.4's E4 case, which is indistinguishable from a flat well in the output and means the
  opposite) and its own `σ` noise. Both inputs are less self-evident than they
  look — noise is a median-absolute-second-difference statistic (`threshold.md` §5.1) and each
  region is derived from that curve's own Cq (§3) — so a surprising threshold is usually one
  curve's region,
  and the list says which. This replaced a hover card carrying the same breakdown: same
  information, but transient, read-only, and long enough to run off screen on a full plate.

  **Both levels are editable, and the finer one wins.** A row's number input sets
  `thresholdOverrides[fluor]`; a curve's sets `curveThresholdOverrides[curveKey]`, which
  `computeCqTable` applies over the group's threshold whatever that resolved to (`threshold.md`
  §5.3). The group median deliberately refuses to follow any single well, which is right for the
  default and leaves no other way to correct one well without moving every other well of that dye
  with it. An input holding a manual value is tinted green (`.is-override`, `--good-dim`) so a
  hand-set threshold never reads as something the run computed; an automatic one carries the live
  auto value greyed via `.is-auto` rather than sitting empty behind a placeholder, because an empty
  number input steps from 0 — one press of the down arrow would jump the threshold from ~200 to
  nothing. Seeded this way the arrows nudge from where the threshold actually is, in whole RFU
  (`step={1}`). A **reset** button per row clears that level's override — the same `<ResetIcon />`
  the Wells section uses for "reset to the plate definition", so one glyph means "back to the
  derived default" throughout the rail — and is disabled while the row is already automatic.

  **Hover is two-level too.** Hovering a fluorophore row isolates its curves and draws a dotted
  line at its threshold, and nothing more. Hovering one curve's row isolates that single curve
  (`HighlightMatch`'s `"curve"` variant, matched on well label + fluorophore), draws the line at
  the threshold *that curve* is measured against, and adds the region/σ overlay: the exact cycle
  span its baseline was fitted over, traced on the curve in a fixed highlighter color with its
  noise labelled at the end (`ThresholdLineState.regions`, `lib/uplot/chart.ts`). The overlay is
  deliberately one curve at a time — drawn for a whole fluorophore's wells at once, the σ labels
  overlapped into illegibility. In channel mode there is no dye-space curve to isolate and no
  threshold on the raw channel curve, so a hover highlights the fluor's channel (or the curve's
  well) and draws neither.

  The section sits in the Curves rail in **every** view mode, Channel included, and lists **every**
  fluorophore with a matched calibration curve (`thresholdGroups.filter(g => g.curve)`) — not just
  the ones currently toggled on in the Targets/Fluorophores chip list above, and not gated by which
  wells happen to be selected either: a dye hidden from the chart, or one whose wells are all
  deselected, still has a real threshold worth checking or overriding, and hiding its row along
  with its chip would leave nothing on screen to bring it back. An override feeds the run's one Cq
  table, so it moves the chart's Cq markers and the hover cards' numbers exactly as it moves the
  table's. Channel mode used to hide the section, on the grounds that the old `channelCqTable`'s
  groups were channels rather than targets; that table is gone (see above), and with it the
  confusing part — the section now shows the same thresholds in every mode, and in channel mode
  they simply describe curves the chart isn't currently drawing in dye space rather than silently
  moving markers on it. Each row's displayed automatic value is read from the run's Cq table
  directly (`CurvesView`'s `groupThresholds`, reading `CqTableEntry.groupThreshold` rather than
  `threshold` so an overridden well can't rewrite its fluorophore's displayed number) rather than
  from the display-filtered `tableRows`, for the same reason the row list itself isn't filtered.
  The per-curve list is the plate's *loaded* wells for that dye — exactly the §5.2 noise cohort.

  Each row has a hover effect (`.analysis__threshold-row:hover` background tint, like the app's
  other hoverable rail rows) backing up what it actually does: hovering a fluorophore row sets the
  same `hoverHighlight` a chip's hover sets (isolating that dye's curves via `applyHighlight`) plus
  a dotted line at its threshold RFU — drawn per highlighted curve at `threshold + plotDelta` and
  deduplicated by pixel row, which is one line in practice (every curve on a plot shares one
  `plotDelta` in the "Relative" view) but cannot drift away from the Cq rings if that ever stops
  being true — via `CurveChart`'s `thresholdLine` prop →
  `lib/uplot/chart.ts`'s `ThresholdLineState`/`setThresholdLine` (a mutable holder + cheap
  `u.redraw`, the same pattern `applyHighlight` uses, so hovering doesn't rebuild the whole uPlot
  instance). Only meaningful in `curveView: "relative"` — the threshold/noise/Cq math
  (`threshold.md` §5–§6) is computed against the baseline-subtracted curve, not the raw one — so
  `CurvesView` passes `null` under "absolute". The `hoverThreshold` state stores *which* row is
  hovered (fluorophore, plus a `curveKey` for a curve row), not the RFU it held at mouse-enter, and
  the value is resolved out of `thresholdRows` on each render: the row's threshold input sits inside
  the hovered row, so typing or arrow-stepping it — like dragging the auto-threshold multiplier —
  changes the number with no pointer event to refresh a snapshot, and the line would otherwise stay
  at the old level while the numbers and Cq markers moved.

  Hovering an individual **curve** row adds the per-curve diagnostic, for debugging a surprising
  auto threshold: the isolated curve gets its exact `CurveBaselineResult.baselineRegion` —
  auto-detected *per curve*, so two wells of one dye legitimately show different ranges, e.g. a
  late-amplifying well's flat region reaching much further right than an early one's — traced in a
  fixed highlighter yellow (`REGION_MARK_COLOR`, deliberately not the curve's own color: tracing it
  in-hue read as barely a thicker version of the line itself, next to invisible against the dark
  theme) with a dark halo stroke under it, plus a small curve-colored dot and a "σ12.3"-style noise
  label (`CurveBaselineResult.noise`) at its end — the dot ties the label back to which line it
  belongs to now that the mark itself is a shared color. The label flips from above the point to
  below whenever it would otherwise land on the dotted threshold line (the two are frequently close
  in RFU by construction — the region tends to end near where a curve approaches its own
  threshold). `PlotCurve`/`SeriesMeta` carry the whole `analysis` record (the lookup-not-recompute
  rule at the top of this section) purely so `lib/uplot/chart.ts`'s
  `overlayPlugin` can draw this without a second pass over the run's curves; nothing else reads
  them. It is gated on its own `ThresholdLineState.regions` flag rather than riding on the dotted
  line, which is what keeps it to one curve at a time: it used to appear for every curve the hover
  isolated, and a whole fluorophore's worth of σ labels overlapped into illegibility.

  Both hover effects are dye-space-only. In Channel mode a row's threshold is a level on the
  color-separated curve, not on the raw channel one, and no plotted curve carries the dye's label
  — so `CurvesView` passes no threshold line and no regions, and highlights the fluorophore's own
  channel (or, for a curve row, its well) instead.
- **Greying:** a row renders at reduced opacity (`.analysis__row.is-nocq`) whenever it has no Cq
  (`cq == null`) — which now has exactly one cause, the curve not crossing its threshold
  (`threshold.md` §6). Keying greying on the Cq result itself, rather than on a separately
  cached verdict, is what makes it react live to editing a threshold override. A row is never hidden, so a well's disqualification is
  visible instead of silently dropped from the table.
- **Table/CSV columns, same order in both:** well, sample (`WellDefinition.sampleName`, the
  same field `PlateTable`'s "Sample" column shows), fluor, target (only when `usingTargets`;
  the CSV always includes it, since it's harmless there even when identical to fluor),
  [channel — CSV only, not shown in the table], baseline (`CurveBaselineResult.baselineFit`,
  rendered as a formula via `formatBaselineFormula()` — the same value the Curves view's
  tooltip shows — placed just before threshold since threshold/noise are derived from the same
  baseline region), threshold, Cq, ΔRFU, end RFU. The CSV is built from the same rows via the
  shared `csvRow()` quoting helper (`lib/download.ts`) and `downloadText()` — filename
  `<run name>_analysis.csv`, the same `dataFile`-derived naming `plateReadCsvFilename` uses for the
  Raw view's per-cycle export. Its rail button is always present — in Channel mode too, since the
  export is the same target-based table whichever space the chart happens to be showing — and is
  disabled rather than hidden when there are no rows (no usable calibration, or the rail filtered
  everything out), so exporting never requires switching modes first.

### File vs. computed analysis

Only relevant to a source that carries its own analysis alongside the raw curve — currently
Biomeme (`WellCurve.fileAnalysis`, `biomeme.md`). Two independent `FileSettings` toggles,
`baselineSource`/`cqSource` (`"file"` default, `"computed"`), rendered as a pair of `Toggle`s in
the rail whenever `RunAnalysis.hasFileAnalysis` is true — absent entirely for a `.zpcr`/`.pcrd`
run, which has nothing to switch between.

They take effect in exactly one place, `lib/runAnalysis.ts`'s `blendWithFileAnalysis`, called
once per curve while building `cqTable` — never in a view. `computeCqTable()` still runs
unconditionally first (a curve's threshold has to come from *somewhere*, and this library's own
algorithm is the only thing that can resolve one across a group), and `blendWithFileAnalysis`
then substitutes the file's own numbers for the matching half of each `CqTableEntry`:
`baselineSource` swaps `correctedValues`/`baselineFit`/`baselineRegion`/`deltaRfu` (`noise` stays
this library's own always — Biomeme states no noise estimate, only the threshold it implies, and
`noise` is an internal diagnostic, never shown as "the file's"); `cqSource` swaps
`cq`/`threshold`/`endRfu`. Because this happens inside the one `cqTable` every view reads —
chart, table, hover cards, CSV — none of them need to know the toggle exists; the chart's Cq
marker, for instance, is still just `(entry.cq, entry.threshold)`, whichever source those came
from.

The two are genuinely independent, not a single "source" radio: a user comparing this app's
baseline fit against the device's own Cq call (or the reverse) is a real, useful combination, not
an edge case to prevent. Picking "file" baseline with "computed" Cq means the chart's marker sits
at this library's threshold against the *file's* corrected curve, which won't necessarily land
exactly on a crossing — an honest picture of two independent analyses compared piecewise, not a
bug. `biomeme.md` §3 has the measured numbers motivating why this is a toggle rather than one
pipeline reproducing the other: 19/27 curves on the committed sample agree on amplified-or-not,
median 4.1 cycles apart where both report a Cq.

## Calibration view

`CalibrationView` (`components/views/CalibrationView.tsx`) plots the archive's `.Dcal` pure-dye
calibrations as response curves: **block temperature on x, RFU on y**, one line per (calibration
file × optical channel). This is the *input* to color separation — `calibration.md` §2's
`max(0, dyeReading − emptyReading)` per channel — so the view shows exactly what the calibration
matrix is assembled from at any block temperature, and how far each dye bleeds into its
neighbours' channels.

- **Nothing is interpolated for drawing.** §3 samples a response curve at an arbitrary block
  temperature by straight-line interpolation between the bracketing knots, so the segments uPlot
  draws between the four measured points *are* the algorithm; adding intermediate vertices would
  redraw the same lines. Where a plotted file has no knot at another file's temperature (they all
  agree on 20/40/60/80 in practice, but nothing in the format requires it), the gap is filled by
  calling the library's own `interpolateResponse` — never a second interpolation written here.
  Outside a file's measured range the line stops: the algorithm does extrapolate from the end
  segment's slope, but drawing that would read as data. The tooltip marks an interpolated point
  `interp` beside the temperature, so a measured value is never mistaken for a derived one.
- **The hover card shows all three levels**, in both modes: the dye-plate reading, the empty-plate
  reading, and the response — `calibration.md` §2's subtraction read top to bottom — with the row
  for the line actually under the cursor marked and brought forward. A response means little
  without the two readings it's the difference of, and a raw reading means little without its
  counterpart, so each mode was previously answering only half the question it raised. Every line
  therefore carries all three level arrays (`CalPlotSeries.levels`) regardless of which one it
  draws; the hovered level is reported from the plotted array verbatim so the card can't disagree
  with the pixel under the cursor, and the other two are evaluated through the same
  `interpolateResponse`. A level whose curve doesn't reach that temperature shows `—`.
- **Default selection = what the analysis uses.** A run ships a `.Dcal` for every dye Bio-Rad
  sells on both tube types (28 files in the committed samples), which is unreadable all at once.
  `lib/calibrationCurves.ts` marks each file `inUse` on exactly the terms
  `matchFluorCalibrations` matches on (this plate's fluorophores, this plate's tube type, both
  compared case-insensitively), and those are what's shown; everything else is one chip-click
  away. `inUse` decides the default selection and **nothing else** — in particular it doesn't
  affect how a line is drawn. A `.Dcal` set characterizes the instrument's optics, not the run:
  across the committed samples the four `.zpcr` files carry bit-identical calibration values from
  2019 to 2026 (same instrument, alpha `SG16130`), and the two `.pcrd` files agree with them to
  ~5e-3 RFU — text round-trip noise, not a difference. So "does this run read this file" is not
  information about the data, and the dash is spent on something that is. With no plate (missing,
  or still behind the password prompt) nothing is in use, so the fallback is every calibration for
  the default tube type, with a rail note saying so.
- **Solid = signal, dashed = crosstalk.** A dye on its own channel (`Dcal.primaryChannel`) is
  drawn solid at double width; the same dye's response on every other channel is dashed and thin.
  That is the distinction the plot exists to show — how far each dye bleeds into its neighbours —
  and it reads directly off the line style instead of having to be traced back through the legend.
- **Colored by the dye, tinged by the channel** (`crosstalkColor` in `lib/channelColors.ts`, the
  one deliberate exception to that module's color-encodes-the-channel rule). Every other view
  plots one series per channel, so the channel's hue *is* the series' identity; this view plots
  one dye across all six at once, where colouring purely by read channel scatters a single dye's
  lines across the whole palette and makes a rainbow of one measurement. So the line takes the
  dye's own channel hue with 35% of the read channel's mixed in: FAM's bleed into Ch2 is still
  green, but yellow-tinged. The dye's lines cluster, and the tint still separates FAM-on-Ch2 from
  FAM-on-Ch4 within the cluster. On its own channel the two hues coincide, so a primary line is
  exactly its channel color and matches its rail chip. The tooltip swatch uses the blended color
  too — it has to be the line the pointer is on, not the channel it was read on.
  Chips are ordered by that same channel (then by name) within each tube-type group, so the dye
  list runs along the spectrum in step with the channel bar below it.
- **Relative vs. absolute** (`calView`, the rail's Values switch). Relative — the default — is
  the response the algorithm consumes, `max(0, dye − empty)`. Absolute splits it back into the two
  raw reads that difference is taken between, plotting the pure-dye plate and, dotted below it,
  the empty-plate baseline; the y axis relabels to *Reading (RFU)*. This is the only place the
  `.Dcal` empty blocks are visible at all — the pipeline reads them for that one subtraction and
  nowhere else — so "how much of this response is baseline?" has an answer in the UI. Core grew
  `buildDyeReadingCurves` for it (`packages/core/src/calibration.ts`), and
  `buildDyeResponseCurve` is now defined as the clamped difference of its output, so the two can't
  drift apart. Both raw levels are carried in the response-knot shape, so the chart interpolates
  and draws them exactly as it does a response curve; a `kind` field (`response`/`dye`/`empty`) is
  what picks the dash, the width and the tooltip's value label.
- **Hovering an off chip previews it.** The rail highlight otherwise dims every line and reveals
  nothing when the hovered dye or channel isn't plotted, so a *deselected* chip's lines join the
  plot for as long as the pointer is on it — and the highlight then isolates exactly them.
  Comparing against something unselected is a hover, not a click, a look and a click back. The
  previewed file keeps its sorted position so the lines around it can't reorder, and the rail's
  curve count deliberately counts the *selection* rather than what's plotted, so it doesn't
  flicker as the pointer crosses the rail.
- **The run's own temperature is marked** with a vertical dotted line, from
  `runAnalysis.ts`'s exported `stepTemperature` — the same function `useRunAnalysis` builds its
  matrix at, not a second derivation — so the point on the x axis the analysis actually samples
  is visible rather than implied. It follows the plate-read step selector.
- **Shared with the Curves view:** the `.curves` rail+plot layout, `FluorBar` for the dye chips
  (passed the *complement* of the selection, since `FluorBar` is opt-out and a calibration
  selection is opt-in — that inversion is the price of not forking the component) and `ChannelBar`
  reading the very same `enabledChannels` setting, so a channel turned off in one view is off in
  the other. Chips are grouped by tube type under a `.calgroup` sub-heading, since the archive
  ships each dye twice and the pair are different measurements.
- **Its own chart builder** (`lib/uplot/calChart.ts`), deliberately not a mode of
  `lib/uplot/chart.ts`: that chart's x axis *is* the cycle (integer splits, per-cycle baselines,
  Cq rings, min/max whiskers), none of which means anything for a four-point curve against
  temperature that has no baseline, threshold or Cq. What the two share is the channel palette,
  the SVG-overlay/tooltip pattern and the alpha-only `applyCalHighlight` redraw on rail hover.
- **State:** two per-file display settings of its own. `calFiles` (`${dye}|${plateType}` keys) —
  empty means *unseeded* rather than *none*: the view seeds it from the run the first time it has
  the calibration data, apply-once-per-source like the Curves view's well/channel defaults, so a
  restored selection is never overwritten. And `calView`, the relative/absolute switch above,
  defaulting to `"relative"` and absent from older stored records.

## Reference view

`ReferenceView` (`components/views/ReferenceView.tsx`) is the reference row's own chart,
plus the reference-vs-factory-calibration table (`RefCalPanel`) below it. It reuses the same
rail+chart layout and `CurveChart` component as the Curves view, but with its own selection
state (`enabledRefCols`, a `RefColBar` chip bar) rather than a well matrix, since every plotted
curve here is a reference well. `RefColBar` is one of the four `ChipBar` adapters (see "Rail chip
bars" under Curves view), so its columns behave exactly like the Curves rail's chips: click
toggles, double-click solos, hovering a turned-off column peeks at it. It used to carry a
per-chip **only** button instead of the shared double-click solo; that one-off is gone, along
with its `.refchip*` CSS. Both chip sections carry the rail's standard `<ResetIcon />` button —
restoring, respectively, every channel the run reads and every reference column, neither of which
is plate-derived the way the Curves rail's defaults are (the reference row is instrument optics,
read on every channel whatever the plate holds).

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
- **Three overlapping flat lines, three dash patterns.** Live reads are solid, the factory
  reference is a fine dot (`[1, 3]`), the dark overlay is a dash-dot (`[5, 3, 1, 3]`). Dark and
  factory were *both* `[1, 3]` until this view gained a dark overlay and put them on the same
  chart in the same channel color, where they were indistinguishable — they sit within tens of
  RFU of each other, so the pattern is the only thing telling them apart.
- **Dark overlay ("Show dark"):** the same `showDark` setting and the same `CurveChart`
  `darkCurves` prop the Curves view's channel space uses — one switch meaning "overlay the
  LED-off background", wherever raw channel readings are on screen. It answers the question the
  reference row's *absolute* level raises: how much of a reference well's reading is optical
  background rather than the reference material? Across every committed sample the dark level
  lands below **every** reference column, a per-channel offset (7–215 RFU, i.e. 0.3–10 % of R1)
  below the dim end of the row that is stable to a few RFU across years and runs — and the two
  don't track each other cycle to cycle, so neither substitutes for the other as a background
  estimate (see `plateread.md` §DARKDATA vs. the reference row).
  **Raw-baseline only:** a dark curve has no factory value to be relative to, so ΔRFU/Drift %
  have nothing to plot it against and would drop a ~2000 RFU line onto an axis spanning tens of
  RFU. The switch stays visible but inert there, with a `rail__note` saying why, rather than
  disappearing — the same choice the factory line makes in those modes.
- **Factory overlay ("Show factory"):** on by default — the live-vs-factory comparison is what
  this view is for — and Raw-baseline only, for the mirror-image reason the dark overlay is:
  under ΔRFU/Drift % the live curve is *already* plotted relative to the factory value, so the
  line would be a flat zero. The toggle gates `buildChart`'s **`drawFactory`**, not the
  `factoryCurves` array, and that distinction is load-bearing: those same values are what
  `wellAdjust` computes the ΔRFU and Drift % baselines from, so emptying the array to hide the
  line would silently break both modes. `uitest` asserts ΔRFU still works after the line is
  hidden.
- **Min/max band ("Min/max band"):** the Curves rail's switch and the same `bands` setting,
  shading each drawn curve's per-cycle min/max envelope — the reference reads and, alongside
  them, the dark overlay. Unlike the two overlays it is *not* Raw-only: the envelope is mapped
  through the same `{scale, shift}` its line was, so it stays correct under ΔRFU and Drift %
  (where the axis spans tens of RFU and the band is at its most legible). It *is* Cycle-axis
  only — see the column-mode bullet below.
- **X axis ("Cycle" / "Column"):** cycle mode is the time series — one line per (channel,
  reference column), showing the reference row's *stability* over the run. Column mode collapses
  each of those lines to its mean over all cycles and replots it against the plate column, giving
  one line per channel across R1–R12: the reference row's *shape*. Nothing about `buildChart`
  changes for it — a series is just (x[], y[]), so column mode only alters what x means, plus a
  `xAxis` config that relabels the axis and ticks every one of the ≤12 categorical positions
  (the cycle axis keeps its every-fifth thinning, which would be unreadable here). Consequences
  worth knowing:
  - A series spans every column, so it carries **`col: -1`** — the same "not one specific column"
    sentinel the dark/baseline series already use. The factory overlay is keyed to it by the same
    `channel,col` match, so it too becomes one per-column line rather than twelve flat ones.
  - The **dark overlay becomes a flat line** there: the dark reading has no column dependence, so
    its run-averaged value simply repeats across the columns — the mirror of the factory line
    being flat in cycle mode.
  - A column the rail turns off leaves a **gap** (NaN) rather than shifting the remaining points
    along, so position on the axis always means the same column.
  - The **min/max band is suppressed** there, and a rail note says so: a column point is a mean
    over the whole run, so the only spread available to shade would be drift over time — a
    different quantity from the per-read spread the band means everywhere else. Column mode's
    dark series clear `min`/`max` for the same reason.
  - The rail's column **peek still works** (it fills the point back in), but the column *dimming*
    does not: a `refcol` highlight has no per-column series to keep lit, so `ReferenceView`
    suppresses it in column mode rather than dimming the entire chart.
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

**Unknown channels.** A fluor's channel is optional (`PlateFluor.channel?`) — a `.plt.csv`
labels its columns by dye alone, so a dye no `.Dcal` covers, or any plate CSV opened standalone,
has no channel at all. Nothing is ever guessed: `channelColor(undefined)` returns `NEUTRAL_COLOR`
and `channelLabel(undefined)` returns `UNKNOWN_CHANNEL_LABEL` (`Ch?`). One shared component,
`components/plate/FluorChannelChip.tsx`, renders every dye chip in both the Plates and Raw views —
dashed outline plus a `Ch?` marker and an explanatory `title` when the channel is unknown, and
`hasUnknownChannel(plate.fluors)` gates its `UnknownChannelNote` footnote under the fluor list.
The rest of the pipeline treats `undefined` as "not in any channel" rather than channel 0:
`fluorCurves.ts` propagates it, and `chart.ts`'s dark-overlay `presentChannels` set filters it
out. That only costs colouring and grouping — the color-separation solve keys off `.Dcal`
response curves, not channel numbers.

## Styling & responsiveness

- `theme.css` holds the dark-only design tokens (surfaces, ink, neon accents, channel
  palette, fonts). `app.css` holds layout + component styles.
- Layout is **container-query driven** (`app__main` is the query container): the Curves rail
  sits beside the chart on wide screens and stacks above it under ~720px (a tighter step at
  ~560px trims padding and drops Overview's tiles and definition lists to one column); the Raw
  list collapses similarly. Fluid type/padding via `clamp()`/`cqi`; chart cells use
  `min-inline-size: 0` and overflow guards so the page never scrolls horizontally.
- The **app shell** is the one place that can't rely on container queries, because it *is* what
  sizes the container: `.app__header` is a non-wrapping flex row, so the view-tab strip's
  intrinsic width used to stretch the whole `.app` grid past a phone viewport and push every
  view into horizontal overflow. The tabs therefore live in their own `.app__views` scroller
  (`min-width: 0; overflow-x: auto`) and the logo/drop button are `flex: 0 0 auto`.
- The header **goes iconographic when it stops fitting** rather than scrolling, in four steps
  driven by a `data-fit` attribute that `state/useHeaderFit.ts` sets by measurement: 0 is the
  full `zpcr//web` + five labelled tabs (each with its line icon from `components/ViewIcons.tsx`)
  + "load file"; 1 drops the wordmark's `//web` tail and the load button's word; 2 drops every
  tab label *but the selected one's*, so the current view still reads as a word for as long as
  there's room for it; 3 is all icons. Nothing is lost at any level — each control keeps its word
  in `title` + `aria-label` (hence `Logo`'s split spans and `ViewSelector`'s explicit labels), so
  hover, screen readers and `tools/uitest.mjs`'s name-based tab lookups all still work. Only
  `.app__header` carries `data-fit`, so the welcome screen's `.app__brand` — no tabs, plenty of
  room — keeps the full mark unconditionally.
- **Why measurement and not a media query.** The header's natural width depends on what it
  currently holds: a standalone `.pltd` shows two tabs and a run shows five, and level 2's width
  depends on which label happens to be selected. Any single breakpoint therefore either collapses
  a header that still fits or lets one truncate — the old `@media (max-width: 599px)` rule let
  the tab strip scroll away about a third of its width before it fired. `useHeaderFit` instead
  probes a **hidden clone** of the header pinned to the real one's width, writing each candidate
  `data-fit` onto the clone and reading the resulting flex layout back, and takes the first level
  whose content fits the real header's content box (re-run on a `ResizeObserver`, on view/file
  change, and on `document.fonts.ready`). Probing a copy is what makes the transitions work: an
  in-place probe has to suppress transitions to avoid measuring a half-finished animation, and
  doing that right after React commits the new state computes the destination widths with no
  transition, so the labels snap. Level 0 is also where each label's natural width is read off
  and written to the real element's `--w`, since `max-width` can only animate between two lengths.
- Level changes **animate** (140ms `max-width`/`opacity` on the labels, plus `gap`/`padding` on a
  tab whose label has gone, so its icon re-centres in a square tap target). Two suppressions:
  `[data-measuring]` kills transitions on the clone, and holds them on the real header across the
  first pass only — that flag lives in a `useRef`, because a flag local to the effect would be
  re-armed by every dep change and silently kill the animation on exactly the tab switches that
  want it. `prefers-reduced-motion` turns the whole thing off.
- **Phone support is two shapes, not one.** *Portrait* is the stacked container-query layout
  above — settings on top, chart/table below, the page scrolling vertically as one column, which
  means the stacked `.curves__rail` needs `overflow: visible; height: auto` (its own
  `overflow-y: auto` applies only when it's a column). *Landscape* is a separate
  `@media (orientation: landscape) and (max-height: 560px)` block: the chrome shrinks
  (`--header-h: 40px`, compact file chips) and `.curves__rail` becomes an off-canvas drawer —
  absolutely positioned, `translateX(-100%)` until `CurvesView`'s `railOpen` state puts
  `is-railopen` on `.curves` — so the chart nearly fills the viewport. `.curves__railtoggle` and
  `.curves__scrim` are `display: none` everywhere else. The query is deliberately height/
  orientation based rather than `pointer: coarse`, which no headless browser reports, so
  `tools/uishot.mjs --width 844 --height 390` can actually check it.
- The two systems overlap (a landscape phone's main area is also a narrow *container*), so the
  landscape rules sit **after** the container queries they must beat — several ties are at equal
  specificity and are resolved by source order alone. `.analysis__table-wrap`'s landscape
  override consequently lives next to its own base rule far down the file rather than in the
  main landscape block.
- Touch targets are enlarged under `@media (pointer: coarse)` only, and safe-area insets
  (`env(safe-area-inset-*)`, with `viewport-fit=cover` in `index.html`) pad the header and file
  bar. Both are no-ops for a desktop mouse on a notchless screen.
- **Desktop is the regression baseline.** Every mobile rule lives inside a narrow-only
  container/media query, so `node tools/uishot.mjs --views overview,curves,plates,raw --width
  1400 --height 900` renders byte-identically before and after — worth diffing the PNG hash when
  touching anything here.
- `prefers-reduced-motion` is respected (the drawer animates with a `transition`, which
  `theme.css`'s global reduced-motion rule already disables).

## The Device view

The one view that operates on **no file at all**. It connects to a CFX96 over WebUSB and shows the
instrument: identity, live status, its filesystem, and the decoded protocol traffic. Everything it
knows about the protocol comes from `@zpcrweb/core`'s `CfxDevice` (see the root
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#talking-to-an-instrument-not-a-file-srcusb) and
[`usb.md`](../../usb.md)), per the standing rule that logic lives in the library — the app side is
`state/useCfxDevice.ts`, which owns only what a browser session adds: obtaining the device through
`navigator.usb`, a poll timer, a bounded traffic log, and the React state the components render.

**Why it is set apart in the chrome.** Every other tab is a lens on the active file, and the file
bar underneath says which one. This tab isn't, so three things follow, and they are one decision
rather than three:

- Its tab sits in its **own group** in the strip (`ViewSelector`'s `DEVICE_VIEW`, kept out of
  `ALL_VIEWS`), separated by a gap and accented magenta where the file tabs are cyan. Grouping it
  with the rest would assert that the file selection applies to it.
- `App` renders it through an **early return** that omits the `FileBar` entirely — there is no
  active file for it to be about.
- It renders **with nothing loaded**, ahead of the empty-state branch, so someone with a cycler
  and no files can reach it. That is also why the welcome screen carries a "Connect an instrument
  over USB" button: it is the one thing the drop zone can't offer.

The `CfxDevice` lives in a **ref**, not state: it is a long-lived object with a background read
loop, and a re-render must not be able to look like a new connection — `open()` on an
already-claimed interface fails.

Four components, under `components/device/`:

- **`DeviceRail`** — the left rail, reusing the Curves view's `.rail__*` vocabulary so the two
  read as the same kind of surface. Connection, the identification block, live status, and the
  action buttons. Status fields the protocol doesn't name are either omitted or footnoted rather
  than labelled with a guess (the sample temperature is the live example).
- **`DeviceProtocol`** — stage a thermal protocol for a new run. Everything on the host side of
  starting one, and nothing on the wire: the library has no upload or run-control commands
  (`usb.md` §10), so both action buttons are disabled and say what they are waiting for.

  It is the one place the file list comes back. The view hides the `FileBar` because no *view* is
  about a file — but "which protocol" is a question about the app's loaded runs, since the
  instrument has no protocol library to pick from (`usb.md` §5.1). So the panel carries its own
  list, and a file that can't supply a protocol is listed **disabled with the reason** rather than
  omitted: "this run has no protocol in it", "this is a plate file", and "this run isn't decrypted
  yet" are different problems and only one is fixed by typing a password. `lib/protocolSource.ts`
  answers that question for each file; the picker only renders it.

  What is reviewed is the **ASCII run definition**, not a decoded step table — the same
  `ProtocolDecoded` the Raw and Overview views use. That text is the artifact that would actually
  be sent (`prcl.md` §3), so reviewing anything else would be reviewing the wrong object; it also
  makes a loaded `.prcl.txt` and a run's embedded protocol render identically, since by then they
  are the same kind of thing. The `.prcl.txt` picker is the escape hatch for a protocol no loaded
  run carries, and the Overview tab's protocol section is where that file comes from.
- **`DeviceFiles`** — the instrument's storage, grouped by kind the way the Raw view groups a
  `.zpcr`. A *single* retrieved file is **saved to disk, not loaded into the app**: what lives on
  the instrument are the *parts* of a run — individual `.Plateread`s, the `.Dcal` set, the
  `.pltd`/`.prcl` pair — where every format this app opens is a whole run in one container.

  A whole directory is different, and is what **Open run** does: a `.zpcr` *is* a ZIP of a run
  directory (root `ARCHITECTURE.md`, "A run directory is a `.zpcr`"), so the button pulls every
  file — sequentially, since the command channel carries one request at a time, with the busy
  label counting them off — hands them to the library's `zpcrFromRunFiles`, and drops the result
  into `store.addFiles`. From there it is an ordinary loaded file: the same validate → IndexedDB
  path as a drop, under the name the run calls itself, then a switch to Overview so a successful
  open goes somewhere. It is offered for any directory whose listing contains a `RunInfo.xml`
  (what makes a directory a run, and what `parseZpcr` refuses an archive without) — in practice
  `CurrentRun`. `addFiles` returns the id it left active precisely so this caller can tell a
  rejected archive from a loaded one and stay put, with the error banner, in the first case. When
  `GETFILESLEN` answers with a status code instead of a length, the panel distinguishes the two
  the instrument actually sends (`usb.md` §5): *empty* — which `\Storage Card` is, holding only
  the two directories below it — reads as an ordinary empty listing, while *no such directory* is
  called out as a failure. Either way no names are shown, because the protocol's failure mode is
  to return *another directory's* contents, and showing them under the wrong heading would be
  worse than showing nothing.
- **`DeviceConsole`** — every decoded message in both directions, at the level of logical
  messages rather than USB packets, which is where the protocol is legible. Channel is on every
  line: a reply arriving on channel 2 rather than 1 is exactly the thing that would otherwise be
  invisible. Polling is filtered out by default (it would otherwise be all there is to see).

  **Read-only, deliberately.** It used to carry a prompt that sent whatever was typed into it;
  that is gone, and the library no longer offers the call it was built on (`usb.md` §10). The
  vocabulary is reverse-engineered rather than specified, a mistyped line is indistinguishable
  from an intended one, and the thing on the other end heats a block and moves a lid — so what the
  app can ask an instrument to *do* is the fixed set of buttons below, each an entry in
  `CFX_COMMANDS`. The debugging value was in watching the traffic, which is unchanged.

**Action commands carry their provenance.** `CFX_COMMANDS` tags each action with how it is known
to do what it says. All four currently offered — `BLOCKID 1` (flash the indicator), `LID OPEN`,
`LID CLOSE`, `CANCEL` — are `observed` in a capture. Anything tagged `unverified` is badged `?`
with a dashed border and an explanatory note, so a guess is never presented as a feature; the
instrument's result code is reported either way. The badge and its footnote are driven off the tag
rather than hardcoded, so adding an unverified command surfaces the warning on its own.

Two of these were briefly shipped *as* guesses, which is why the mechanism exists — and then a
re-read of the `usb-basic` capture against the operator's account of it (flash, then open, then
close) found both: `LID CLOSE` verbatim, and `BLOCKID` as the indicator flash. See `usb.md` §3.

**Testing.** The protocol logic is unit-tested in the library against a mock instrument scripted
with the real device's replies (`packages/core/test/usbDevice.test.ts`) — the read pump, command
serialization, the atomic listing pair, and `GETFILE`'s verbatim bytes. The *browser* connect path
can't be automated: WebUSB permission can't be granted to a headless Chrome, so `uishot`/`uitest`
only ever see the disconnected state, and the connected UI is checked by hand or by stubbing
`navigator.usb`. **Open run**'s substance is in the library for the same reason: what a browser
can't reach — that a run directory's files zip into an archive `parseZpcr` accepts, byte for byte
— is covered by `packages/core/test/runFolder.test.ts`, leaving only the button wiring untested.
