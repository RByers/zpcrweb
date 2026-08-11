# Web app architecture

The web app (`@zpcrweb/web`) is a browser UI over [`@zpcrweb/core`](../../packages/core). It
holds a set of **open files** — `.zpcr`, `.pcrd`, a Biomeme run export (`.bmrun`, see "A third
format: Biomeme" below), a standalone plate file (`.pltd` or zpcrweb's own `.plt.csv`, see
"Standalone plate entries and attach" below), a thermal protocol (`.prcl.txt`) or an instrument run
report (`.alf`, see "A run report on its own" below) — **selects exactly one** of them, and explores
it through up to seven views: Overview, Protocol, Curves, Plates, Reference, Calibration and Raw (a
standalone plate file only gets Overview, Plates and Raw; a standalone protocol file only Overview,
Protocol and Raw; a run report only Overview and Raw; a Biomeme run only Overview, Protocol, Curves,
Plates and Raw — see below). Two further tabs are about no file at all: **Files**, the open files
and the folders — the ones granted on disk, plus the app's own bundled `samples` — and
**Instrument**, a live cycler over USB.

Open files and the one selection are the app's spine; see "Open files and the one selection" below
before changing anything that touches them.

## Format independence

**Except for the Raw views, the app is entirely format-agnostic. This is an invariant, not an
observation.**

Concretely, outside `RawFilesView`/`PcrdRawView`, the `App.tsx` line that chooses between them,
and the capability checks that disable `ViewBar` tabs for a standalone plate, protocol or report
entry or a Biomeme run (`isStandalonePlate`/`isStandaloneProtocol`/`isStandaloneReport`/`isBiomeme`
in `App.tsx` — a real capability difference: a
Biomeme `Zpcr` has no reference row or `.Dcal` calibrations for Reference/Calibration to show,
same as a standalone plate has no curves), no component may:

- branch on `LoadedFile.kind` (or otherwise ask which format a run came from);
- read `Zpcr.archive`, which a `.pcrd`-derived `Zpcr` has none of;
- read `RunResult.documentXml`, which only a `.pcrd` populates;
- read any `Zpcr` field only one decoder fills — `Zpcr.wellFactors` is the live example.

For a `.zpcr`/`.pcrd` run those same tabs are decided by *content*, not by kind (`runViews`), and
that check is held to this rule too: it asks `zpcr.reads`, `factoryRefCal()` and `calibrations()`
— all of which both decoders fill — rather than looking for `.Dcal` entries in `Zpcr.archive`,
which a `.pcrd` doesn't have. Reading the archive there would have silently disabled Calibration
for every `.pcrd`, which is exactly the class of bug this section exists to prevent.

The reason is not tidiness. `.zpcr` and `.pcrd` are two containers around *the same physical
run*, so anything the app reports off one must match what it reports off the other; a number
that changes with the container is an artifact, not a measurement. This binds the analysis
pipeline especially hard — see the header comment in `@zpcrweb/core`'s `runAnalysis.ts`, and the `wellFactors`
note in [`calibration.md`](../../docs/calibration.md) §4.1 for the one correction dropped to keep it
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

- `OverviewView`, `ProtocolView`, `CurvesView`, and `ReferenceView` take a plain `Zpcr` — they
  don't know or care whether it came from a `.zpcr` archive or a decoded `.pcrd` document.
  `OverviewView`'s "Protocol" row and `ProtocolView`'s thermal-protocol block both read
  `zpcr.protocol()` (a real accessor on `Zpcr`, not a by-name file lookup), so both the name and —
  when the format provides one — the step table work identically either way; when there's no step
  list it falls back to `zpcr.protocolText` rendered through the same annotated `ProtocolDecoded`
  listing the Raw view uses (see below). `OverviewView` additionally takes the raw `RunResult` (not derivable from
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

A chip leads with an icon that says two things at once (`components/FileIcons.tsx`): its **shape**
is what the file is — a run, a plate map, a thermal protocol or a run report — and its **color** is the
encryption status above. The shape comes from core's `fileCategory()` (`fileKind.ts`), not from the
extension, which is why the two plate encodings (`.pltd`, `.plt.csv`) and the two protocol ones
(`.prcl`, `.prcl.txt`) each draw as one icon: the bar shows the seven accepted formats as the four
kinds of thing they actually are — the same grouping that decides which half of an experiment a file
can be attached as. The icon replaced a plain colored dot, which carried the encryption half alone; a
protocol chip's "proto" badge went with it, the icon now being what tells a protocol from a plate at a
glance.

Each chip's hover card (the file's detailed type description — `fileKindDescription()`,
`fileKind.ts` — plus protocol name, cycle count, and the plate's target/sample lists, the
same lists `OverviewPlateSection` shows in an Overview's "Plate" section, via `@zpcrweb/core`'s shared
`plateTargets()` helper) renders through a `createPortal` into `document.body` at a `position: fixed` spot
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

The file is identified by **name**, which is also its key in IndexedDB — so `#file=` names a
stored record directly, with nothing to resolve. Files themselves live only in IndexedDB and can't
be fetched from a link, so a hash naming a file the user hasn't loaded falls back to the default
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
an external deep link are one code path and the resulting URL is shareable. The example is one of
the bundled samples, at the same `/examples/<name>` path the samples folder opens its files from
(see "The bundled samples folder" below) — one copy of the file, one way of reaching it.

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
(`npm run test:ui`). See the root README's "UI tooling" for what the two scripts cover, and
AGENTS.md "UI testing" for when to reach for each.

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

## A protocol on its own

A thermal protocol is the third kind of top-level file, and it arrives in **two encodings**, the
same way a plate does: Bio-Rad's own `.prcl` (`prcl.md` — a ZipCrypto container, or the bare-text
variant of §1.1) and this project's `.prcl.txt` (§3.1). `LoadedFile.kind` is `"prcl"` or
`"prcltxt"` accordingly, and both resolve through `protocolFiles`/`activeProtocolFile` to one
`ProtocolFileResult` — the canonical one-line run definition plus the decoded `ProtocolDocument`,
alongside `needsPassword`/`error`/`container`, exactly mirroring `PlateFileResult`. It is a result
wrapper rather than a bare string precisely because of `.prcl`: a protocol file can now be present
and unreadable, which is a state a string cannot hold. (A `.prcl.txt` still never reaches it — the
store's `fileKind` admits only bytes that already parsed.)

The two encodings differ in exactly **two** visible ways, and `App.tsx`'s `isProtocolKind` is where
everything they share is kept shared:

- **Only a `.prcl.txt` is editable.** This project reads Bio-Rad's container but has no writer for
  one, so `editable` is false for a `.prcl` and the Edit pencil never appears — the same standing a
  `.pltd` has against a `.plt.csv` on the Plates tab.
- **Only a `.prcl` carries a structured step list.** Its `protocol2` XML has real steps, so
  `ProtocolView` gets them as `steps` and draws the step table it draws for a `.pcrd`; a
  `.prcl.txt` is directive text and nothing else, and gets the annotated listing.

Everything else — the tabs, where opening one lands, what the Instrument view will start — asks
the category, not the encoding.

It enables **four** tabs, `["overview","protocol","raw","instrument"]`, because it is several
things:

- **Overview** (`StandaloneProtocolOverview`) — the shared `OverviewPanel` with no slots filled
  at all (see "One Overview panel" below): the `Type`/`Filename`/`Last modified` identity card and
  the download/edit/clone toolbar, and nothing else. All the protocol's own content lives on
  Protocol instead, the same split a run's Overview/Protocol pair uses.
- **Protocol** (`ProtocolView` — the *same* component a run's Protocol tab uses, see "One Protocol
  view" below) — the protocol *as a document*, editable for a `.prcl.txt` because it is a draft
  rather than a record. Its name leads the view and the annotated `ProtocolDecoded` listing follows,
  behind an Edit pencil (`components/protocol/`, see "Editing a protocol" below). Everything shown is
  `parseRunDefinition`'s (`protocol.md`) — the view reads nothing out of the text itself. For a
  locked `.prcl` this tab is where the shared `PasswordPrompt` goes, in place of the protocol, the
  same place and the same component a locked `.pltd` puts it on Plates.
- **Raw** (`StandaloneRawView`, shared with `.pltd`/`.plt.csv`/Biomeme) — the file's own bytes
  verbatim for a `.prcl.txt`, which is already plain UTF-8 with nothing to decrypt; for a `.prcl`,
  the decrypted `protocol2` XML in the same collapsible tree a `.pltd`'s payload gets, since it is
  the same container (`zipcrypto.md`).
A `.prcl.txt` **with a `PLATEREAD` in it** is not something that can be started, only attached to
an experiment that can (see "The Instrument view"): the run it would produce wants the name, plate
and identity an experiment file carries. The Instrument tab is still reachable while one is
selected — it is reachable always, being about no file — but selecting such a protocol says nothing
about what the instrument should run, and the view goes on showing the experiment it was already
pointed at.

Both encodings are also offered by the **attach/replace protocol** menus (`lib/attachSources.ts`),
but a `.prcl` is offered as its decoded directive text rendered to `.prcl.txt` rather than as its
own bytes — `attachProtocol` writes text into the archive, and there is no encrypted-container
writer to write anything else with. A `.prcl` nobody has unlocked has no text to offer and so is
not listed, unlike a locked `.pltd`, whose bytes can be attached verbatim without ever being read.

**A protocol with no `PLATEREAD` is the exception, and is started as itself.** The instrument
builds no run folder for one (`usb.md` §7.10), so there is no `.zpcr` coming and an experiment file
would be a container for results that never arrive. `App`'s `instrumentExperiment` therefore makes
such a protocol file — either encoding, since what gets typed at the instrument is the directive
text (`protocol.md` §7) — the Instrument view's subject directly, named after the file, and
`startExperiment` sends it without marking anything begun. What comes back is the run's `.alf`
report — see "A run report on its own" below.

Enabling Overview is what removed the old special case in `App.tsx`, where a `.prcl.txt` selected
on any tab was forced into the Instrument view because it had no file-backed view to render. It
now falls back like every other file, to the first tab its kind enables — and **loading one lands
on Overview** (`addFiles`), because opening a protocol is asking what it is; Instrument is where
you go when you mean to start a run.

## A run report on its own

An `.alf` (`alf.md`) is the fourth kind of top-level file, `LoadedFile.kind === "alf"` — and the
first whose `fileCategory` is neither run, plate nor protocol but **`report`**. That distinction is
load-bearing: a report says a protocol executed, when, for how long and whether it completed, and
carries no fluorescence, no plate and no editable protocol. Categorising it as a run would offer it
everywhere a run belongs, and every one of those places would find it empty.

It enables **three** tabs, `["overview","protocol","raw"]`:

- **Overview** (`StandaloneReportOverview`) — who ran what, and how it went. The shared
  `OverviewPanel` gets the six summary rows of `lib/alfSummary.ts` (the run's name, when it ran, how
  long it took, the outcome it reports, the instrument, and what the log holds) and nothing else:
  the full decode is one tab over in Raw, and the Instrument view's last-run panel builds its
  account of a report still on the machine from the same six.
- **Protocol** (`ProtocolView`, the same component a run and a `.prcl.txt` use) — what actually ran,
  and what it cost. A report carries a protocol of its own: line 2 is the run definition
  post-expansion, with the scan mask the run really used (`alf.md` §5), so the view takes it with
  `executed` set and heads it *Thermal protocol as executed*. Not editable — a report is a record.
  Below it, the same **Thermal profile as run** section a `.zpcr` gets, since the report is exactly
  what that section plots.
- **Raw** (`StandaloneRawView`, shared with `.pltd`/`.plt.csv`/`.prcl.txt`/Biomeme) — the report's
  own text, which is already plain UTF-8.

The report is parsed once, in `App.tsx` (`activeReport`), and handed to both views: Overview and
Protocol read the same fields, and parsing it twice is how the two would drift.

Reports arrive two ways: dropped in like any other file, or collected from the instrument at the
end of a **thermal-only run**, which produces one instead of a `.zpcr` (`state/useRunWatch.ts`'s
`collectReport`). Either way it is an ordinary file of the user's from that moment — in the bar, in
the catalog, in IndexedDB, renameable and deletable like any other.

### One Protocol view (`ProtocolView`)

**A protocol is rendered by one component wherever it lives** — a standalone `.prcl.txt`, a run's
own protocol, and the copy an `.alf` run report carries alike. There were two
(`StandaloneProtocolView` and `ProtocolView`) and they had
drifted in every way two components can: only one had an editor, only one had the download/clone
pair, one led with a stat table of `Method`/`Lid`/`Volume`/`Steps`/`Plate reads`/`Scan` and the other
didn't. But the thing on screen is the same directive text either way, so where it is stored changes
only two things, and both are props:

- **whether it may be edited** — a standalone file and a *pending* experiment are drafts, a run that
  has happened is a record (see "Editing what has already happened");
- **whether there is a thermal profile below it**, which only a run that actually executed has;
- **whether the text is the report's own copy of what ran** (`executed`) rather than an authored
  protocol, which changes the heading and adds one line about the scan mask — the distinction
  `alf.md` §5 draws, and the reason a report's protocol isn't allowed to pass for a `.prcl`'s.

A standalone `.alf` is the third caller and the one that needs both of the last two: the report *is*
the protocol and *is* the profile.

Its replace/download/clone toolbar is the Plates tab's, mirrored — see `PlateDownloadButton` under
"Plates and plate files" for the three buttons and the two places the protocol's set deliberately
differs from the plate's.

It takes the protocol *text* rather than a `Zpcr`, which is what lets it serve a `.prcl.txt` at all —
that file has no run around it to hand over.

**The stat table is gone.** Every fact in it was a directive in the listing directly below it —
`HOTLID 105,30` *is* the lid row, annotated in plain English — so it restated the protocol in a
second, shorter form that could only ever agree with it or be a bug.

**The name leads the view**, the same shape an experiment's name leads its Overview
(`ExperimentHeader`), down to the red required state and the pencil: it is the same question about
the same kind of thing, and answering it two different ways in two tabs is the drift this
unification exists to undo. What that name *is* differs by carrier, which is the one thing the two
callers still resolve for themselves — a `.prcl.txt` has only its file name to be named by, while a
run's protocol carries `ProtocolName.txt`.

### Editing a protocol (`components/protocol/`)

A protocol is editable when it is a **draft**: a standalone `.prcl.txt`, or a *pending* experiment's
protocol. Every other carrier of the same text (`protocol.md` §2) is a record of a run that already
happened — there is no honest way to edit one.

- **The editor never touches text.** `ProtocolEditor` edits core's `ProtocolBuilder`
  (`protocol.md` §10), which owns serialization, step numbering, `END`'s position and what a
  legal `GOTO` target is. There is no free-text mode: a protocol is typed at the instrument
  directive by directive (§7), so a file that can hold something the grammar doesn't is a file
  that fails halfway through a run being set up. The consequence for this layer is that the UI
  has no validity rules of its own — the fields, their units and their limits all come from
  `validateStepDraft`/`PROTOCOL_LIMITS`.
- **The listing is a decode of the builder's own output**, not a second rendering of the model,
  so what is on screen is the text that would be sent. A modifier (`BEEP`, `INC`, `RATE`, …)
  therefore appears on its own line as it does in the file, while *editing* it means editing the
  step it rides on.
- **The unit of editing is the group, not the line** (`groupDirectives`). `METHOD`/`HOTLID`/
  `VOLUME` are one settings form, and a step is its directive plus the modifiers riding on it, so
  each group is drawn as a run of lines inside a single click target with a single +/− pair: one
  highlight rather than three lit at once, a delete that takes a step's modifiers with it, and a
  form that opens below the whole group. The pair sits in a fixed-width gutter to the *left* of
  the step numbers — on the right it sat against the panel edge, leaving the popover it opens
  nowhere to lay its fields out.
- **− marks a group; + marks the gap below it.** They act on different things, so they sit at
  different heights: − beside the group's first line, + pushed to the group's bottom edge and
  raised half its own height so it straddles the boundary the new step would land on. Read that
  way, every boundary carries exactly one + — the header block's is what puts a step *before*
  step 1, the last step's is what appends past it, and `END` carries none, since a + of its own
  would be a second button for the gap the last step's already fills.
- **Reading and editing are the same listing** (`EditableListing`, `interactive={false}` while
  reading), with the gutter reserved and empty until Edit is pressed. Pressing it lights up rows
  that are already where they will stay, rather than reflowing the program sideways.
- **The group's form is a native `popover`** (`StepForm.tsx`), which is where Escape, light
  dismiss and top-layer stacking come from rather than a document-level listener. It is positioned
  from the group's own rect, since anchor positioning isn't broadly supported yet, and pulled back
  inside the viewport (flipped above the group if need be) once it is up. Enter commits, ✓ commits,
  clicking away discards.
- **Done is not Save.** Edits are written to the file as they are made, via
  `ZpcrStore.setProtocolText` — the Edit/Done button only switches the listing between reading
  and editing. Undo/redo (buttons, Ctrl-Z/Ctrl-Y) are a stack of run definitions held by the
  editor; the stack restarts when the file changes underneath it, judged against the *whole*
  stack rather than the last value emitted, because effects run after their render and a prop
  routinely lags one edit behind.
- **A protocol the builder can't represent gets no editor**, with the reason on the disabled
  button. Refusing is the honest answer: the alternative is rewriting bytes we didn't understand.

### Editing a plate (`components/plate/`)

The plate-side counterpart of the protocol editor, and deliberately the same shape as it:
`PlateEditor` wraps the ordinary `PlateViewer` grid, adds an Edit pencil that becomes a worded
Done, edits through core's plate primitives rather than text (`plateEdit.ts`,
[`pltcsv.md`](../../docs/pltcsv.md) §5), and saves as it goes (`ZpcrStore.setPlateText`, the same
write-behind throttle a protocol edit uses). Undo/redo work the same way too, over a stack of
plates compared by their serialization — the store hands back a *re-parsed* plate, never the
object the editor emitted, so identity comparison would restart the history on every edit.

**A `.plt.csv` is editable and a `.pltd` is not**, which is a fact about writers rather than about
permissions: there is no encrypted-`.pltd` writer (`pltcsv.md`), so an edit to one would have
nowhere to go. A `.pltd` gets the same grid with no pencil, and the clone button beside it turns
it into a `.plt.csv` that does edit.

**A run's own plate edits in place too**, in the same editor — `PlatesView` hands it
`ZpcrStore.setRunPlateText`, which rewrites the archive entry through core's `attachPlate` and
throttles the write exactly as `setRunProtocolText` does for a run's protocol. What a plate says is
a setup, and correcting a sample name in it should not mean downloading the plate, editing it
elsewhere and attaching it back. `PlatesView`'s `editableEntry` holds the conditions: there is an
archive to write into (a `.pcrd` has none), the entry is a `.plt.csv`, and it is the run's only
plate — since `attachPlate`'s contract is that a run ends up with one plate entry, running it on an
archive holding two would drop the other. Anything else keeps the read-only grid.

- **One grid, two modes.** `PlateViewer` takes an optional `PlateGridSelection`; having it *is*
  what edit mode means for the grid. There is no second plate grid to keep in sync, which is the
  same rule "One Protocol view" states for the protocol listing.
- **Selection is a spreadsheet's** (`usePlateSelection.ts`, which is the one place the rules are
  written down): click selects a well and anchors there, Cmd/Ctrl-click adds or removes,
  Shift-click takes the rectangle from the anchor, dragging sweeps one out, the row letters /
  column numbers / corner take a whole row, column or plate, arrows and Shift-arrows move and
  extend, Cmd-A and Escape select everything and nothing. Selection is state about the *grid*, so
  it survives an edit — which is what makes a run of edits to one group of wells bearable — and
  dies with edit mode. Only the left button drives any of it, and a `contextmenu` ends a drag:
  the context menu swallows the `mouseup` that would otherwise end one, which left the sweep armed
  and painting under a mouse nobody was pressing. Both are workarounds for mouse events not saying
  when a gesture is over — there is a `TODO` in `usePlateSelection.ts` to move the app onto pointer
  events, where `pointercancel` says it directly.
- **The grid takes focus when it is clicked** (`PlateViewer`'s `gridRef`, `tabIndex={-1}` while
  selectable). The selection handlers `preventDefault` so a drag doesn't select the cells' text,
  and that suppresses the focus change with it — so the last panel field typed in kept focus, and
  since the keyboard and clipboard handlers below stand aside for a focused text field, Cmd-C,
  Cmd-V, Delete and the arrows all silently did nothing from the first name typed onwards.
- **One field per fact, across the whole selection** (`PlateEditPanel.tsx`, the right-hand panel
  that only edit mode has). A field shows the selected wells' shared value or `‹mixed›`, and
  typing sets that one fact on every selected well: select a column, set the sample, and twelve
  wells get the sample while their targets stay put. That is `WellPatch`'s absent-means-leave-alone
  rule surfaced as UI, and it is the whole reason the panel isn't a well-at-a-time form. The dye
  list sits at the bottom, apart from the per-well fields, because it is the one control there
  that isn't about the selection.
- **The two fields whose value has to match something outside the app are menus, not text boxes.**
  Vessel offers `BR Clear` and `BR White` — the two plates every sample's calibration set is cut
  for — plus "unstated", and keeps an unrecognized value as an option of its own for as long as it
  is selected, so opening someone else's plate and editing another field can't silently rewrite it.
  Adding a dye offers the dyes `lib/fluorColors.ts` has colours for, with "Other…" opening the free
  text box behind one extra click. Both lists are open in the file and closed in the UI on purpose:
  a typo'd vessel matches no `.Dcal`, and a dye typed "fam" is a dye no other plate lines up with.
- **The clipboard is the system's**, not an in-app one: `copy`/`cut`/`paste` events (so Cmd-C/V
  need no permission prompt) carrying the tab-separated block of `pltcsv.md` §5.1 — which means
  wells copy between plates *and* to and from a spreadsheet. A single well pasted onto a
  selection fills all of it; a block lands with its top-left corner on the selection's. The last
  copied block is also kept in the component, for a browser that hands us a paste event with no
  readable text.
- Those window listeners read their state through a ref rather than through their closures.
  They are registered once per edit-mode entry while the selection changes on every click, so a
  copy arriving between a click and the effect that would re-register it would otherwise copy the
  *previous* block — reproducible, not theoretical.

## Standalone plate entries and attach

Two more `LoadedFile` kinds, `"pltd"` and `"platecsv"` (a bare `.csv` upload is treated leniently as
zpcrweb's own `.plt.csv` format — see root `ARCHITECTURE.md`'s "Plate CSV + attaching a plate"),
alongside `"zpcr"`/`"pcrd"`:

- **Standalone entries** — a `.pltd` or `.plt.csv` dropped with no run selected becomes its own
  top-level file, resolved via `plateFiles`/`activePlateFile` (a `PlateFileResult`, parallel to
  `runs`/`activeRun` but with no `Zpcr` involved). `App.tsx` detects `active.kind === "pltd" |
  "platecsv"` and enables only three of the tabs (`enabled={["overview","plates","raw"]}`; the rest
  grey out) routing to `StandalonePlateOverviewView`/`StandalonePlateView`/`StandaloneRawView`
  instead of the normal `Zpcr`-gated branch — `PlatesView`/`RawFilesView` get thin, `Zpcr`-free
  counterparts operating directly on the file's own bytes and the `PlateFileResult`, while Overview
  is the *same* `OverviewPanel` a run uses (see "One Overview panel" below), given the plate
  setup's own rows (dimensions, vessel, encryption) and its target/sample chips. It has no run to
  report on, so no Cq tally comes with those chips — there's no analysis to tally against. A standalone
  `.plt.csv` states no channel and carries no calibration of its own, so its channels are simply
  **unknown** — no `channelForFluor` is passed. Nothing is inferred from column order, and the
  mapping isn't borrowed from some other run that happens to be loaded, since that would be a
  guess about a different instrument's optics. It costs nothing visual: the dyes are coloured
  from their own names (see "A dye's colour is the dye's", below), and the chips just carry no
  `Ch<n>`.
- **Attach (replace a run's plate)** — `PlatesView`'s `AttachPlateMenu`
  (`components/plate/AttachPlateMenu.tsx`), enabled only for a run that has a file archive to add
  an entry to (so: a `.zpcr`; a `.pcrd` gets the control disabled with an explanatory title, since
  it has no archive). Unlike the plain file-picker `DropZone` it replaced, it is a `<details>`
  menu (styled like `PlateDownloadButton`'s) offering every plate the browser is holding, plus an
  "Upload…" row for a fresh file from disk. **Plates, not plate files** — see "What the attach
  menus offer" below. When the run already
  has a plate (`confirmReplace`), picking either doesn't attach it right away — the menu swaps
  its list for a "replace with this?" prompt first, since attaching overwrites the current layout
  with no undo; a run with no plate yet skips the prompt, as there's nothing to lose. The menu
  also closes on an outside `mousedown`, like any other dismissable popover, rather than only on
  a second click on its own toggle — worth having regardless, but especially so once it can be
  showing a destructive confirmation. **The trigger has two shapes** (`iconOnly`, shared with
  `AttachProtocolMenu`): a bare upload icon in a `raw__download` box wherever it rides a view's
  toolbar next to download and clone — three peers in one row, each a box around an icon with its
  words in the tooltip — and the labelled `dropzone` chip wherever it stands alone, which is
  Overview's "Experiment parts" cards and the Plates/Protocol empty states. The rule is the
  context, not the caller's taste: an icon among icons reads as one of a set, an icon by itself on
  an otherwise empty panel is the only thing on screen to find and needs its label.
  Either path ends by wrapping the chosen bytes in a `File`
  and calling `store.attachPlate(fileName, file)`, which rewrites the run's own archive via core's
  `attachPlate` (see root `ARCHITECTURE.md`) and re-persists it under the same name.
  There is **no separate override state** — once
  attached, the plate is just part of the run's `.zpcr` bytes, so `zpcr.plates()` picks it up the
  same way it would an originally-embedded `.pltd`, and `CurvesView`'s
  `zpcr.plates(pltdPassword)[0]` labeling updates with no code path of its own to keep in sync.
  This is also how "download the run with its attached plate" works — `FileBar`'s per-chip
  download button just downloads `LoadedFile.bytes` as-is, which already includes anything
  attached.
- **What the attach menus offer** (`lib/attachSources.ts`) — an `AttachSource[]`, built once in
  `App.tsx` and handed to all three views that show one of these menus, so they cannot drift into
  offering different things. The list is **every plate (or protocol) in the browser, not every
  plate file**: a plate embedded in a loaded run appears beside the standalone `.pltd`/`.plt.csv`
  files, labelled by its own name with the run it lives in on a second line. Offering only
  top-level files meant re-using last week's layout took opening that run, cloning its plate out
  to a file, and coming back — ceremony around bytes that were already here. The active file's own
  plate/protocol is excluded, since attaching a file its own plate back is a no-op behind a
  confirmation prompt.

  A source names the item and defers the bytes: `file()` is called only for the one that gets
  picked, so a menu of a dozen plates renders a dozen labels rather than serializing a dozen CSVs.
  What it hands back is the same two forms `attachPlate` already accepted — the original `.pltd`
  bytes when the run's archive has them (verbatim, encrypted or not: re-encoding through
  `plateToCsv` would drop what the CSV form doesn't carry), else a `.plt.csv` written from the
  decoded plate, which is what a `.pcrd`'s embedded `plateSetup2` gives. A protocol source is
  always the one-line run definition wrapped as `.prcl.txt`, named after the *protocol* rather
  than its containing file, because that name is what `attachProtocol` stores as
  `ProtocolName.txt`. Both menus therefore take one `onAttach(file: File)` rather than a
  select/upload pair: by the time bytes exist, where they came from stops mattering.
- **`PlateDownloadButton`** (`components/plate/PlateDownloadButton.tsx`) is the two-option
  download menu (`.pltd` / `.plt.csv`) shared by `PlatesView` and `StandalonePlateView`: "Download
  .pltd" is only enabled when real `.pltd` bytes exist (a real archive entry, or a standalone
  `.pltd` upload) — never for a `.plt.csv`-sourced plate or a `.pcrd`'s embedded plate, neither of
  which has raw `.pltd` bytes to hand back. "Download .plt.csv" is always available, serialized
  from the current `PlateDefinition` via `plateToCsv`. `PlatesView` (not `StandalonePlateView`,
  where the plate is already its own file) also passes an `onClone` handler, rendered as a
  sibling "Clone" button: same `plateToCsv` encode, but the resulting bytes are wrapped in a
  `.plt.csv` `File` and handed to `store.addFiles` instead of triggering a download — extracting
  the run's plate into its own independent `LoadedFile`, which is what populates the "Attach"
  menu above with something to pick besides an upload. **`ProtocolView`'s "Thermal protocol" block
  carries the same three controls in the same order** — replace, download, clone — because a
  protocol and a plate are the two halves an experiment is assembled from, and one of them offering
  all three while the other offered two was drift rather than a distinction. Download and clone go
  to a `.prcl.txt` (`downloadText` vs. an `addFiles` call); they appear whenever the protocol has
  directive text at all, editor or not, riding the heading line through the editor's own `tools`
  slot the way `PlateViewer` takes its `toolbar`. Replace is `AttachProtocolMenu`, the same menu
  Overview's "Experiment parts" uses and the same `store.attachProtocol` call. Where it differs
  from the plate's: it is offered only for a **pending** experiment, never for a run that has
  happened (attaching a plate to a finished run labels results that arrived without a map; swapping
  its protocol would rewrite the record of what the block was asked to do), and never for a
  standalone `.prcl.txt`, which *is* the file — replacing its contents from another file is just
  opening that other file, the same reason `StandalonePlateView` has no attach control.

## Open files and the one selection

**Open or gone: there is no third state.** A file the app is holding has its bytes in memory, is
decoded, has a chip on the file bar and a row in the Files table, and has a record in IndexedDB.
Closing it takes all of that away at once — `ZpcrStore.closeFile` drops the bytes *and* deletes the
records. The app is a set of open documents, not a library with a loaded subset.

| Set | What it is | Where it shows | Where it lives |
| --- | ---------- | -------------- | -------------- |
| **open files** | every file the app is holding | the **Files** tab (`FilesTableView`), one row each; the **file bar** (`FileBar`), one chip each | `ZpcrStore.files` (`FileEntry[]`, metadata) and `ZpcrStore.loaded` (`LoadedFile[]`, with content) |
| **the selection** | exactly one open file, or none | the cyan chip; every tab of the **view bar** | `ZpcrStore.activeName` / `active` |

`files` and `loaded` are two views of the same set, and come apart only while a file's bytes are on
their way in, or when they can't be got at all — a disk-backed file whose folder is waiting on its
permission back is a row with no content behind it yet, and reads itself in as soon as the app can
reach it (`retryUnread`, called when a folder is granted, and by `setActive`). Such a row says so
where its type icon goes, with a red badge (`ZpcrStore.unreadableIds`), and **clicking it is what
asks for the permission back** — a click is the user gesture `requestPermission` requires, and the
row is the thing in front of the person who wants the file.

That ask is the **folder's**, not the file's: `App.tsx`'s `selectFromTable` routes it to
`useDiskTree`'s `grant`, the Grant access button's own implementation, because permission is not
granted per file. It is not really granted per folder either — one handle is asked, but Chrome's
restore-permission prompt answers for the **origin**, handing back every directory the site was
granted before. So a grant re-reads *everything*: all cached listings dropped, every node on screen
re-listed, every watch re-armed, and every open file the app couldn't get at read back in
(`retryUnread`). One click recovers the whole session, rather than leaving other folders showing a
Grant access button and other files wearing a read-error badge that stopped being true the moment
the dialog was answered. The click also stays in the Files view rather than going to the file's
Overview, since until the browser's question is answered there is nothing to show there.

A lapsed permission is therefore **not** an error the app reports. It used to be, and the banner it
raised sat over the folder's own **Grant access** button quoting the platform at the reader
("Failed to execute 'getFileHandle' … not allowed by the user agent") — a message about the call
that failed rather than about anything they could do. Only a read that fails for some *other*
reason — a file deleted underneath us, bytes that no longer decode — reaches the error banner
(`useZpcrStore`'s `noteReadFailure`).

The banner itself (`App.tsx`'s `ErrorBanner`) has a ✕. It is fixed over the bottom-right corner of
whatever is on screen, so a message nobody can clear goes on hiding the controls underneath it for
the rest of the session — which is how the lapsed-permission error came to be sitting on top of the
button that fixed it. Dismissing clears `ZpcrStore.error` and does nothing else: nothing is retried,
nothing is undone.

Outside the set entirely are the files sitting in a **granted folder** on disk that the app has not
opened. They appear in the Files view's lower pane and nowhere else, they have no record anywhere,
and the app knows nothing about them beyond a name, a size and an mtime read from the directory
listing. Ticking one opens it. That pane is the only way in for a folder file, which is why the
table above it has no checkbox column: the table lists what is open, and its ✕ is how something
stops being. See "Disk-backed files and folders" below.

The two bars are named after those sets and are referred to by those names throughout the code:
the **view bar** is the tab strip (`components/ViewBar.tsx`), the **file bar** is the row of chips
under it (`components/FileBar.tsx`).

### The invariants

1. **A file is decoded exactly once, as it is opened.** Unzipping, decrypting and parsing happen in
   two places — `addFiles`/`addDiskFiles`/`addRunArchive` (the bytes are already in hand) and
   `loadOne` (which reads them from IndexedDB or off the disk) — and the derived
   `runs`/`plateFiles`/`protocolFiles` maps are built from the loaded set alone. Nothing else may
   open an archive.
2. **Everything shown about a file is derived live from the decoded file.** There is no cached
   per-file summary: every row of the Files table reads its cells out of `runs`/`plateFiles`/
   `experiments` (`FilesTableView`'s `rows`), which are the same values every other view is drawing
   from. That is affordable precisely because the set is what is *open* rather than everything the
   browser has ever seen, and it removes a whole class of staleness — a rename or an attached plate
   changes the row as it happens, rather than when a summary write lands.
3. **The view bar is tied to the selection, exactly.** Every tab but Files is a lens on the one
   selected file, and `App.tsx`'s `enabledViewsFor` decides which of them that file can answer.
   Three situations produce the same empty answer, because they are the same fact — no tab has a
   file to be a lens on: nothing selected, the selected file's bytes still arriving, or a run that
   hasn't decoded (locked behind the password prompt, or failed). The strip still renders; it is
   simply all disabled but **Files** and **Instrument**, a lens on a machine — the two tabs that
   were never about the selection. So are the wordmark (About) and the load button, which are not
   lenses on a file at all — with nothing selected, those are the ways out.
4. **The selection is an open file, or nothing.** Closing the selected file moves the selection to
   another open file or clears it. "Nothing selected" is a real, reachable state — every file
   closed, or a `#file=` naming a file this browser doesn't have — and the app renders it as itself
   rather than substituting some other file.
5. **A session reopens holding exactly what it was left holding.** The catalog is read as metadata
   on startup and then every file in it is read in, selected file first. A file that can't be read
   keeps its row rather than being dropped: a folder whose permission has lapsed is the ordinary
   case, and deleting the user's own bookkeeping over a dialog they haven't answered yet would be
   the app losing their work for them.

### Closing a file

One control, two places, one component (`components/CloseFileButton.tsx`): the chip's ✕ on the file
bar and the row's ✕ in the Files table. For a file that is a copy of something on disk, one click —
nothing is at risk. For one carrying edits that exist nowhere else (`modifiedIds`) the first click
**arms** (a red waste bin) and the second does it; moving the pointer away disarms. See "Closing an
edited file" below.

The two used to disagree — the chip released without asking, the table always asked twice — which
meant the same file answered "is this safe?" differently depending on where you clicked.

Clicking a **row** anywhere else selects the file and lands on **that kind of file's own view** —
`App.tsx`'s `defaultViewFor`, keyed on core's `fileCategory`: a run opens on Curves, a plate on
Plates, a protocol on Protocol, and an `.alf` report on Protocol (the protocol it records, with the
wall-clock profile of what it cost). That is what each file is *for*, and the same destination a
double-click in the folder list below goes to, so one gesture-independent rule answers "go look at
this file" everywhere. Overview is the fallback rather than the answer: the preferred view has to be
one this file actually supports, so a run still recording — no plate reads, no Curves — lands on its
first enabled tab instead. The Protocol/Plate/Reads cells override it with their own view.

### Instrument is not a file view

The Instrument tab has a group of its own at the far end of the strip, beside — not among — the
lenses, and is **always enabled**, like Files. What it shows is the machine on the other end of
the cable: a connection, a status, a filesystem, a traffic log and the run being driven, none of
which stop existing because the selection moved.

It spent a while inside the file-view group, on the argument that starting a run needs a protocol
and a protocol comes from a file. Both halves of that are still true — but *needing a file as
input* is not *being a lens on the selected file*, and only the second belongs in that group. The
difference showed up as two contortions in `App` whose only job was to hide it: `activeLocked`,
which stopped the file bar switching files while a run was live, and an effect that snapped the
app's selection to the running file on arriving at the tab. Both are gone, and **nothing replaced
them**: the file bar is still the only file picker, the experiment this view starts is still simply
the selected one, and when the selection isn't a run the view shows no run at all. See "The
Instrument view" below.

## State & persistence

`state/useZpcrStore.ts` is the single store hook. It holds the open files (`FileEntry[]`, metadata)
and their content (`LoadedFile[]`, bytes in memory), the active file id, a per-file settings map, the derived
`runs`/`plateFiles` maps over the loaded set (see "The `.pcrd` password gate" above and "Standalone
plate entries and attach"), and the globally-selected view (`view`/`setView`, plain `useState` —
not persisted, and not part of the per-file settings map, so switching files never changes which
view is showing). `state/db.ts` is a minimal IndexedDB wrapper with **two** object stores:

- `content` — the bytes, keyed `[name, entry]`: **one record per archive entry**. A `.zpcr` has
  ~40 of them, one per entry; every other kind has a single record under the `WHOLE_FILE` sentinel
  entry (U+0000). Files survive reloads and are re-parsed (`parseZpcrArchive`/`parsePcrd`/
  `parsePltd`/`parsePlateCsv`, by the catalog's `kind`) when loaded. **Read one file at a time**
  (`getContent`, a range read over that file's keys), never in bulk: this store is the expensive
  one, and only opening a file touches it.
- `catalog` — everything else the app knows about a file, one small record each
  (`StoredFile`), read whole on startup by `getAllFiles()`:
  - **identity** — `{ name, size, addedAt, lastModified, kind }`. The **name is the key**, in both
    stores — see "A file is its name" below. `size` is reported only; nothing is keyed on it.
  - **`modified`** — not display state: whether this file's *content* has been edited since it was
    opened and not since downloaded (see "Closing an edited file" below). Written straight through
    rather than debounced.
  - **`view?`** — display state (`StoredView`): `{ enabledChannels[], enabledWells[],
    enabledRefCols[], baseline, curveView, drawBaseline, scale, … }`, so each file remembers its
    enabled wells/channels/reference columns. `baseline` (Reference view's factory-relative
    ΔRFU/Drift %) and `curveView` (the Curves view's display mode — baselining itself is never
    stored, since it's always the auto-detected linear fit) are independent settings — see "Two
    baseline concepts" under Reference view. Writes are debounced by 300 ms.

**Content is the only thing worth a store of its own.** `getAllFiles()` reads the whole catalog in
one `getAll()` on startup, and IndexedDB has no way to fetch part of a record — a store holding the
bytes too would clone every archive in the database on that call. Everything that *isn't* bytes is
one record per file, so identity can't disagree with itself.

**Closing a file deletes both records.** `view` therefore lasts exactly as long as the file is open,
which is the right lifetime for it: everything that changes a reported number lives in the run's own
archive and travels with the file (see "Analysis state lives in the file" below), while which wells
you had hidden is a property of *looking at* the run.

**A write costs what changed, not what the file is.** `putFile` takes the set of entries the caller
actually touched (`fileContent.ts`'s `changedEntries`) and leaves the rest of the records alone, so
appending a plate read is *one* ~22 KB put rather than forty. The set is derived **by reference**:
entry bytes are never mutated in place — a run being followed grows by the entries the instrument
just wrote laid over the ones its file already held, and every writer in `packages/core` builds a
new archive by spread — so an untouched entry is the same `Uint8Array` object it was, and a cycle is
~41 pointer comparisons and one real change. It is derived rather than declared on purpose: each caller does know what it
touched, but a caller that forgot to mention something would silently fail to persist it.

It is an optimization and only an optimization. *Which entries exist* is read from IndexedDB itself
(`getAllKeys` over the file's range — keys only, no values cloned), so an entry the store is missing
is written whatever the change set says, and being wrong can only cost a redundant put. A run
downloaded whole — because the app wasn't holding it — writes every record, since every array is
genuinely new.

`addRunArchive` flushes any pending analysis write before installing a snapshot — otherwise a
threshold edit flushing afterwards would be working from an archive without the plate read that
just arrived. Same precedent as `renameFile` and `setRunProtocolName`.

### A run's file grows by what the instrument wrote

A pass of the run watcher hands the store **the entries the instrument just wrote**, not the run
re-assembled: one plate read, and at the end of a run the last read plus `ended`, the `.alf` report
and the three files the instrument rewrites (`useRunWatch`'s `REFETCH_AT_END`). `addRunArchive`'s
`merge` lays them over the file of that name and leaves every other entry as it stands.

It used to hand over the whole folder — which is the instrument's copy of the run, and knows
nothing of what the app has added on top. Anything the user changed about a run *while it ran* was
therefore reverted by the next cycle: swap the plate for a corrected one and the instrument's
original came back, most visibly at the end of the run, where the final pass is forced and so lands
even if nothing else would have. Sending only what the instrument wrote means an entry it never
touched cannot be overwritten by it, and the end of a run does what it says — adds the last plate
read and the run's own closing files.

**The file is also the record of what has been downloaded.** The watcher keeps no copy of the run:
each pass reads back the archive the app is holding (`App.tsx`'s `heldRun`) and fetches what the
folder has that it lacks (core's `runFilesToFetch`). It used to keep its own name→bytes map of the
folder — the same ~400 KB held twice, and free to disagree with the file the user actually has —
so deleting a run mid-way left the watcher believing it still had every byte, and the file never
came back. Now "what do we have?" has one answer: delete the file and the next pass downloads the
run from the top, finished or not; keep it and the pass costs one plate read.

Two questions follow from having no memory of its own, and both are answered by ~8 KB: **which
file is this folder's run in?** and **is the file we have still that run?** The entries that name a
run — `RunInfo.xml` and the `zpcrweb.json` this app deposits (`runIdentityFileNames`) — are read
first whenever the answer isn't already known, and `RunInfo.xml` has to match the file's copy byte
for byte (`isSameRun`) before anything is appended to it, since the instrument clears the folder
when a run starts. That question is re-asked on every connection and whenever a name disappears
from the listing, which is what stops one run's reads being appended to another run's file.

A pass sends the whole folder when there is nothing to merge into: a run the app isn't holding, or
one whose file has just been renamed out from under it (the derived name can move when
`RunInfo.xml` is re-read at the end of a run). Then everything the pass has goes over — including
whatever the user had added to the file it was reading from.

Every write here is a read-modify-write — a catalog write merges into what is stored, and a content
write reads back the entry keys it should delete — and several fire at once on one file: an edit
writes the modified flag and the view from two places in the same tick. `db.ts`'s `serializeWrites`
chains them per file so a later write can't read a stale "before" record and undo an earlier one.
Deletes are on the same chain, or a delete racing a put would leave the row it just removed
resurrected by the put's merge.

Closing a file removes its whole `content` range and its `catalog` record, and drops it from both
lists in memory — see "Open files and the one selection" above.

### A file is its name

A file's **name is its identity**, and its key in both stores. There is no id.

The app has always required names to be unique: adding a file supersedes whatever held its name,
`lib/cloneName.ts` invents `(2)`/`(3)` precisely to avoid a collision, and `#file=` addresses a file
by name. A separate id was a second identity layered over one the app already maintained — and the
id it derived, `name:size`, hashed the file's *content size*, so a run being written to took a new
key on every plate read. Each cycle therefore deleted the whole previous record, wrote a fresh one,
and dropped everything else keyed by the old id: the run's display settings reset once per read, and
a threshold edit inside the 60 s write window was discarded outright.

What a same-name arrival *means* is now stated rather than derived. `useZpcrStore`'s `install` takes
a `replacing` flag:

- **a snapshot** (`addRunArchive`) keeps the record's summary, view settings and modified flag —
  they belong to the file, not to this snapshot of it;
- **a drop** (`addFiles`) is a different file that happens to share a name, so all of that is reset.

A rename is the one edit that *moves* a file's records rather than rewriting them; `renameFile`
writes the content under the new name and deletes the old, carrying the settings across.

**A folder's file is named for its folder.** `runs/2026-07/a.zpcr` — the granted folder's label,
then the file's path inside it (`db.ts`'s `DiskSource` and `diskFileName`); a bundled sample is
`samples/run.zpcr` by the same rule, though it is a copy rather than the file itself
(`lib/samples.ts`). Nothing about identity
changes: it is still one unique string, still the key in both stores, still what `#file=` addresses.
It just isn't a bare filename any more, which is what makes two runs called `plate.plt.csv` in
different directories two different files. The folder label is made unique with the same `(2)`
counter — against the other granted folders *and* against the names already in the open-files table
above them, since everything in the Files view is addressed by name — so the whole name is too. Two
consequences worth knowing:

- What the run is **called** comes from the last path component, not the whole name
  (`lib/experiment.ts`'s `baseName`) — `runs/2026-07/a.zpcr` is the run *a*.
- **Rename is refused** for a disk-backed file. Its name is a real path, so renaming it would have
  to rename the file on disk, and the File System Access API has no rename — only copy-then-delete,
  with a window in between where a failure loses someone's run. `ZpcrStore.canRename` says so and
  the Overview name editor doesn't offer it.

### The schema is not migrated

A change to any stored shape bumps `DB_VERSION`, and `openDb`'s upgrade **drops every store and
rebuilds them empty**. No migration path, and no compatibility shims — none of the optional fields,
renamed-field fallbacks and "records written before this existed" defaults that a migration path
grows into every type in `db.ts`.

This is safe because nobody's data lives only here while the app is in development: a run is a file
the user has on disk, and everything the app adds to one is written back into that file
(`zpcrweb.json`, the archive rewrite). Wiping the database costs the user re-dropping their files
and re-picking their view settings, and costs them nothing that isn't recoverable from disk. That
goes double for a disk-backed file, whose bytes were never in here to begin with — a wipe costs it
the folder grant, which is one click to give back.

> **Future:** once the app ships to people who keep files only in the browser, this becomes a real
> upgrade path, and the stored types go back to tolerating older shapes.

### A `.zpcr` is stored as its entries, never as a ZIP

A `.zpcr` is a ZIP of ~40 entries, and the app *writes* to it: a plate read arrives every cycle of
a live run, an experiment is named, a protocol is typed at, a threshold is dragged. Held as ZIP
bytes, each of those edits costs an unzip of the whole archive, a change to one entry and a re-zip
of everything else, on the main thread — a 45-cycle run paying that once per cycle to append files
it was handed already decompressed.

So a `.zpcr` is held as its entries and stored as its entries, one `content` record each. Appending
a plate read is `{...files, [name]: bytes}`; parsing it (`parseZpcrArchive`) decompresses nothing,
because nothing is compressed. `state/fileContent.ts` owns the whole of it — the `FileContent` union
a `LoadedFile` holds and the conversions to and from what is stored. The union's discriminator is
what the file *is* (`archive: true` for a `.zpcr`, `false` for everything else), not what state its
run is in: there is no longer a rule about when a run changes form, because it never does.

**Nothing is stored zipped, including finished runs.** A run used to collapse into a single ZIP
record once it carried `ended`, on the reasoning that a finished archive is worth compressing. The
browser does that itself now: since Chrome 129 IndexedDB compresses stored values, including the
large ones that previously went to disk as plain files
([announcement](https://developer.chrome.com/docs/chromium/indexeddb-storage-improvements)). Our
DEFLATE was a second compression pass over data the platform was about to compress anyway, and the
**JS inflate on every load** was the expensive half of it. Storing entries hands both to the
platform: no zip at the end of a run, no inflate when a file is opened, and one less rule.

What it costs is disk — the browser's compressor optimizes for speed over ratio, so it will not
match DEFLATE — and, for a loaded *finished* run, memory: its entries are held unpacked (~1.9 MB for
the RVP sample) where the ZIP bytes used to be (~410 KB). Both are bounded by the loaded set.

**None of this is visible to the user.** `contentBytes` zips on demand, which is what download,
clone and any hand-off to `addFiles` get, so a `.zpcr` leaving the browser is an ordinary `.zpcr`.
The one place it shows through is the size the app reports for a `.zpcr`, which is what its entries
add up to uncompressed — the zipped length is not knowable without doing the zip that storing
entries exists to avoid, and the unpacked number is the honest answer to what the file costs here.

The core library is the other half of this, and it made the same choice: its one currency is the
unpacked archive (`ZpcrArchive`), every writer takes and returns one (`attachPlate`,
`attachProtocol`, `writeZpcrwebSettings`, `markExperimentBegun`, `buildExperimentArchive`), and
zipping is a separate step — `zipArchive` — that only a caller wanting a *file* takes. `parseZpcr`
is the one byte-level entry point kept, since bytes are how a `.zpcr` arrives from disk;
`parseZpcrArchive` is what this app uses. A run being followed therefore goes from the wire into
the store without ever being packed: `useRunWatch` hands the store the entries the instrument just
wrote, `addRunArchive` merges them into the run's file, and a cycle's cost is the one plate read
that arrived.

### Editing what has already happened

**A run that has happened is a record, and the app treats it as one.** Nothing about it may be
changed except through an affordance the user deliberately reaches for — a button clicked, a menu
opened, a confirmation answered. What may still be changed freely is everything that is *about
looking at* the run rather than about the run: which channels are shown, log or linear, a threshold,
the Cq range. Those describe the reader's view, they are undoable by putting them back, and demanding
a click to arm each one would make the app tiresome to use for its main purpose.

**A pending experiment is the opposite, and deliberately so.** It has not run, so it has no record to
protect: it is a thing being assembled, and every part of it — its name, its protocol, its plate — is
meant to be edited directly, with no gate in front of any of it. The two states want opposite
defaults, which is why "pending" is a state the app names rather than a detail of one archive.

Where this shows up today:

| Surface | Pending | Once it has run |
| ------- | ------- | --------------- |
| Experiment name (`ExperimentHeader`) | a live input, marked required while unnamed | a heading, plus an edit button that opens it |
| Protocol (`ProtocolView`) | the editor, writing into the archive as you type | the read-only listing; no editor at all |
| Plate / protocol attach | offered on Overview as ordinary controls, and on each half's own tab | plate only, from the Plates tab, behind a menu *and* a replace confirmation |
| Filename (`OverviewPanel`) | behind the toolbar's Rename button | behind the toolbar's Rename button |
| Analysis + display settings | direct | direct — see above |
| Deleting the file | ✕ on the chip, twice if unsaved | ✕ on the chip, twice if unsaved |

The name field is what this rule was written down for: it used to be a permanently-live text input
sitting at the top of every finished run, one stray keystroke from rewriting the archive of a run
that happened weeks ago. Correcting a typo afterwards is legitimate — it is the app's own field, not
the instrument's — so the answer was a gate rather than a refusal.

Note that the filename row was already built this way, and analysis settings deliberately are not:
they change reported numbers and do reach the file (see "Analysis state lives in the file"), but they
are the app's reading of the run rather than the run's own record, and they are what the Curves view
exists to let someone try. If that distinction ever needs revisiting, this is the paragraph to argue
with.

#### Assembling one, and the hand-off to the instrument

Assembly is an Overview job and starting is an Instrument job, so the round trip between the two
tabs is stated on each end rather than left to be discovered:

- Overview's pending banner says what is still missing, in the order it is supplied: a name first,
  then a protocol. Once both are there it stops asking, and a **"Ready to run"** box appears under
  the "Experiment parts" cards (`OverviewView`'s `ReadyToRun`) whose "Instrument tab" is a link to
  that tab. A plate is deliberately not one of its conditions — it is optional, and an experiment
  without one still runs (it just labels nothing).
- The Instrument tab hands back the other way: the click on Start switches to the started
  experiment's Overview, which is where the "still going" banner and the arriving results are. The
  switch happens after the run has been *sent*, not on the click, and not at all when the deposit
  had something to report — that report lives in the rail (`InstrumentRail`'s `startNote`) and
  would go with the view.

### Closing an edited file

An open file is normally disposable: it came off the user's disk and is still there, so its ✕ closes
on the click. Once its content has been edited it isn't — the edits live in the archive bytes in
IndexedDB (thresholds, the experiment name, an attached plate) and the copy on disk is stale until
the user downloads again. So the chip changes in two ways:

- an amber dot under the ✕, in space the button had spare, saying "this has changes that aren't on
  disk". The dot's row is reserved on every chip whether or not it shows one, so becoming modified
  never reflows the bar;
- the ✕ arms rather than closes: it turns into a waste bin on solid red, and the *next* click is
  the one that closes the file. Moving the pointer off it disarms — it is a warning, not a modal,
  and a red button must not be left sitting in the bar waiting for a stray click.

A **disk-backed** file is never in this state: its edits are written back to the file on disk, so
there is no second copy to go stale (`updateSettings` skips the flag for one), and closing it only
means the app stops holding it. What it *does* do first is flush anything the write throttle still
owes that file, so closing it a second after a threshold drag doesn't lose the drag.

`ZpcrStore.modifiedIds` is the set the file bar and the Files table read. It is set by `updateSettings` whenever the
patch touches an **analysis** key — precisely what a download writes into the file, so display
state (which channels are shown, log vs. linear) never counts — and by `attachPlate`, which
rewrites the archive outright. It is cleared by `markDownloaded`, called from the Overview view's
download button: the one control that writes the whole file including its `zpcrweb.json`
(`exportBytes`), and so the only one that actually gets the edits out of the browser. The flag is
persisted because what is at risk outlives a reload; a record written before the flag existed
loads as unmodified, since only a download clears it and a wrong `true` would never go away.

### Analysis state lives in the file, not in IndexedDB

Anything that changes a **number** the app reports is stored in the run's own archive, as a
`zpcrweb.json` entry (`zpcrweb-json.md`, `packages/core/src/zpcrwebSettings.ts`) — not in the
catalog record's `view` above. That is `thresholdOverrides` (manual per-fluorophore threshold RFU),
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
  never overrides it.
- **Writing** is rate-limited to one archive rewrite per file per minute, plus a flush on active-
  file change, `visibilitychange` → `hidden`, and `pagehide` (`state/analysisPersist.ts`; the
  first edit to an idle file writes immediately). The scheduling itself is
  `state/writeThrottle.ts`, shared with protocol edits (`setProtocolText`, which uses the same
  policy on a 2-second window — a `.prcl.txt` is a few hundred bytes, not a re-zipped archive);
  `analysisPersist.ts` keeps only what is specific to `zpcrweb.json`. The rewritten bytes go to IndexedDB only —
  never back into `files` state, where they would re-parse the run and rebuild every derived
  value on each save. `size` is deliberately left at the loaded file's size: it is what the UI
  labels, and re-adding the same file should still read as the same file.
- **Every other write carries them too.** Because the in-memory archive never holds the settings
  entry, a write made for some *other* reason — a rename, a protocol edit, a plate read arriving —
  would otherwise store an archive with `zpcrweb.json` missing and silently drop the run's name and
  thresholds. So the single write choke point, `useZpcrStore`'s `persistFile`, layers the file's
  current settings in on the way out (`contentToStore`), and skips the work entirely when there is
  nothing to write. Naming a pending experiment is the case that made this necessary: the name is
  itself a file-backed setting, and typing it renames the file in the same breath (`nameExperiment`),
  so the record written under the new name has to carry the settings from the old one.
- **Downloads** go through `ZpcrStore.exportBytes`, which re-zips on demand, so a copy saved from
  the Overview view carries the thresholds it was read with. It is also what clears the file's
  `modified` flag ("Deleting an edited file", above) — the edits are on disk now. Otherwise a
  download deliberately changes *nothing* about the session: it does not re-seed, does not swap the in-memory bytes, and does
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

## Disk-backed files and folders

Everything above describes a file the app holds a **copy** of: uploaded, unpacked into IndexedDB,
and stale on disk from the first edit — which is what `modified` exists to nag about. On browsers
with the File System Access API there is a second mode. The user grants the app a **folder**, and a
file opened out of it is read from disk when it is loaded and written back to the same file when it
changes. The file on disk *is* the file, so `modified` never comes on for it.

`state/diskFolders.ts` owns the handles and every operation on them (a module singleton, like
`db.ts`); `state/useDiskTree.ts` owns the tree's expansion and listings;
`components/FolderSection.tsx` draws them in the Files view's lower pane; the store branches
in exactly one place, `persistFile`. `db.ts` stores the granted folder handles — they are
structured-cloneable, which is what lets a grant outlive a reload — and `FileIdentity.source`
(a `DiskSource`) is the whole definition of "disk-backed".

**Whether a disk-backed file has `content` records is the interesting part.** Normally it has none:
its bytes are on disk and IndexedDB holds only its catalog row. The exception is a run the
instrument is still writing.

**A run started from a file in a folder stays that file.** Starting an experiment marks the file it
was started from `begun` (`beginExperiment`) and the watcher then appends the instrument's plate
reads to it — to *it*, not to a second file beside it — for the whole run. Two things make that
work, and both are about the file's name, since a name is a file here:

- A disk-backed file is named by its path within the granted folder (`db.ts`'s `diskFileName`), so
  the name the run is pinned under (`App.tsx`'s `startedRun`) is a path, and core's
  `zpcrNameFromRunFiles` hands it back whole rather than reducing it to a bare file name. A
  stripped path named a file the store didn't have, and every snapshot installed a new one.
- `addRunArchive` carries the file's `DiskSource` onto each snapshot, which is what keeps
  `persistFile` treating it as disk-backed: the reads buffer into IndexedDB while the run is going
  (above), and the finished run is written back to the original file on disk, once.

The file's name therefore doesn't move over a run, which is also why `beginExperiment` doesn't
restamp its date the way it does for a browser-held experiment — a disk-backed file can't be
renamed from here at all (`renameFile`).

### The Files view is two panes

The open-files table and the folders answer different questions — what this browser is
holding, and what is on the disk — and are different lengths, so they are two panes that scroll
independently rather than one long column. The folders pane takes a **fixed 40%** of the view and
the table takes the rest: a fixed share rather than one sized to its content, because a panel that
grew as a branch was expanded and shrank as it was collapsed would move the table above it on every
click. Nothing in either pane decides where the boundary sits; both scroll inside their own half.
With no folder granted the pane holds just the bundled `samples` group (below).

The folders pane is itself **two columns**: every folder's **directory tree** in the left one, one
group per folder under its own heading (name, ↻, ✕), and the **files of whichever directory is
picked** in the right one. Side by side once `.filesview` is wide enough (a container query at
700px), stacked — trees above, files below — when it isn't; that is a layout switch and nothing
more, with one interaction model at both sizes. Clicking a directory's name selects it *and* opens
it in the tree; its chevron opens it without changing what the file column shows.

There is **one file column for every folder**, not one per folder, which is what lets the left
column be a single scrolling list of every folder at once: five granted folders cost five headings
rather than five stacked panes with five scrollbars. `DiskTree.activeFolder` is the folder that
column is showing — set by clicking a heading or a directory row, by adding a folder (picking one is
asking to look in it), and, until the user picks for themselves, by whichever folder holds files
already open. `DiskTree.selected` stays per folder, so a folder that opened itself on the branch
holding the work in progress keeps that branch marked while another folder is being read.

Over that column sit the **type chips** (`KindFilter.tsx`), one per kind of file the directory
holds, each carrying how many and narrowing the list to that kind. A filter rather than a selection:
nothing on is the whole listing, which is the state it opens in and the state turning the last chip
off returns to, so there is no "All" control to keep in step. They are over the *folder's* list and
not the catalog table deliberately — the folder list is a directory on disk, possibly a very long
one, and narrowing it to "just the plates" is how you find the file you came to open; the table
above is what you already chose, one file at a time. The kinds come from the file **names**
(`fileKindFromName`, core), because nothing in a listing has been read yet — the loader's content
sniff is still the authority once a file is actually opened. The filter is held across directory
changes (hunting for a `.pltd` spans subdirectories) but only ever applies to kinds the current
directory has, so it can never empty the list with no chip left to turn off.

A **file** row in that pane answers a different question from the table's, so its click means
something different: a click is the row's checkbox — it opens the file off disk, or closes it
again — and stays in the Files view, while a **double-click** opens it and goes there, on that
kind's own default view (`defaultViewFor`, above). That divergence
is deliberate. The table's rows are files already open, so clicking one to go look at it is the
whole point; the folder pane is something you read *through*, deciding what the app should hold, and
a click that left the view every time would make a folder of a hundred runs unbrowsable. Closing on
a click is safe because these files are written back to disk as they change, so an unticked file has
lost nothing.

The click acts immediately rather than waiting to see whether a second one follows, so the two
gestures compose instead of one deferring to the other: a double-click's first click has already
ticked the file open, and the `dblclick` only follows it to Overview — waiting on the promise that
click returned, since the file is still being read when it arrives. The consequence is that
**double-clicking an already-open file just closes it**: the click unticks it and there is then
nothing to go to. That is accepted rather than worked around; the gesture that matters is the other
one, on a file being opened for the first time. `FileRow` keeps the click's outcome in a ref because
`dblclick` arrives after `open` was last rendered, so the prop is a render behind by then.

The folder's heading stands in for the tree row its own root doesn't have — clicking the name shows
the files at the top level — which is why it is a plain heading with buttons rather than a
`<summary>`: it carries three separate actions (collapse, select the root, and the refresh/remove
buttons) and a `<summary>` would swallow all of them into "toggle". Only one heading is ever marked,
since only one folder can be the one the file column is showing.

### The bundled samples folder

The last group in the tree column is not on the disk at all: `samples`, the example files the app ships
with. It is drawn by `FolderSection` alongside the granted ones rather than in a panel of its own,
because it is the same thing — a list of files the app isn't holding yet, each with a checkbox that
opens it — and a second component would drift from the first the moment either changed.

Being built in rather than granted, it differs in exactly five ways, and each is a consequence of
that one fact:

- **It is always last**, after however many folders the user has granted, so the app's own files
  never sit above theirs. `useDiskTree` appends it to `folders` after `listFolders()`.
- **It cannot be removed or re-read** — no ✕, no ↻, no permission to ask back for. Its listing is
  fixed when the app is built.
- **It has no tree under its heading**, being one flat directory — the heading is the whole group.
- **It keeps its name.** Every group in the tree column has a distinct label, because a label is an
  identity: the tree keys its nodes by it, and the file names inside it begin with it. `samples` is
  the app's, always — a folder the user grants under that name gets `samples (2)` instead, from the
  same `(N)` counter as `lib/cloneName.ts` (`addFolder`'s `reserved`). Because no granted folder can
  hold the label, `useDiskTree` can go on telling the app's folder from a disk one by comparing
  against it, which is what the ✕ and the directory lister both do.
- **Opening a file gives a copy.** A disk-backed file *is* the file on disk and is written back to;
  there is nothing to write back to inside the app's own bundle, so a sample goes through `addUrl`
  — the same fetch → `addFiles` path `#load=` uses — and lands as an ordinary file in the browser's
  storage. Edits stay there; the sample is what it always was. Its **name** is folder-rooted all the
  same — `samples/run.zpcr` (`lib/samples.ts`'s `sampleFileName`, see "A folder's file is named for
  its folder") — because the app keys everything by name, and a bare `run.zpcr` would mean opening a
  sample silently replaced a file of that name the user had dropped in themselves. `addUrl` applies
  the prefix by recognizing the URL as a sample's (`sampleNameFromUrl`) rather than by being told,
  so the welcome screen's example — which is one of these, opened through `#load=` — lands under
  the same name as the folder row, and that row shows as ticked while it is open.

It is also present on browsers with no File System Access API, where `DiskTree.supported` is false
and there is nothing else in the pane — which is why the pane is gated on `folders.length`, not on
`supported`. The one place this is deliberately *not* counted as "the browser is holding something"
is `App.tsx`'s welcome-screen test: `samples` is in that list on every browser, so counting it would
mean the welcome screen never appeared again.

**Nothing about the list is written in source.** `vite.config.ts`'s `zpcrweb-samples` plugin reads
the repo's `samples/` directory at build time and produces both halves from that one read: a
`virtual:samples` module naming the files (with size and mtime, so a row reads like a disk row) and
the bytes themselves, emitted verbatim to `dist/examples/` in a build and served from the same paths
by a middleware in dev. `lib/samples.ts` is the app's view of it. Adding a file to `samples/` and
rebuilding is the whole procedure; the filter for *which* files is core's `matchesSupportedExtension`
— the same list the picker and the disk lister use — so a format the app can't open is left out here
exactly as it would be in a folder on disk. This replaced a `public/examples/` directory holding one
symlink per offered file, which could only ever list what someone had remembered to link.

### Nothing is walked up front

A folder handed to the app may be an entire lab archive, so there is no recursive scan anywhere.
`listDirectory` reads **one** directory level and caches it, and the tree calls it as nodes are
opened. It also de-duplicates listings in flight, because selecting a directory and expanding it are
now one click and both want the same read. What opens by itself is derived from the open files, not from the disk: the ancestors of the
disk-backed ones, so the work in progress is in front of the user and every other branch stays shut
and unread. A directory row therefore shows no child count — counting means
descending, which is the thing being avoided.

The cost is that a file newly written into a folder does not announce itself. The tree re-reads when
the Files view is opened, when a node is expanded, and on the folder's ↻. Loaded files *do* refresh
by themselves, because those are watched one by one.

### Watching is per file, and has to re-arm

`watchDiskFile` puts one `FileSystemObserver` on each open disk-backed file. There is no directory
observation at all — recursive or otherwise — because that would mean caring about a subtree the app
has deliberately not read.

Two behaviours measured against Chrome 151 shape the implementation:

- Writing through `createWritable` fires `modified` at the app's own watch. Without suppression the
  app would re-read what it just wrote, re-persist it, and write again, forever. So every write
  records the resulting `{size, lastModified}` in an **echo map**, and a record matching it is
  ignored.
- Deleting an observed file emits `disappeared`, then `errored` — and **the observation is then
  dead**: recreating the same path delivers nothing. An external tool saving atomically (write a
  temp file, rename it over the original) looks exactly like delete-then-recreate, so a watch that
  doesn't re-observe silently stops working after the first such save, while still looking live.
  `rearmWatch` re-resolves the handle after ~300 ms and observes again, which does work.

An external change re-reads the file and keeps its **display** state — hidden wells, log vs. linear
— because it is the same file. It deliberately drops its **analysis** state and re-seeds from the
new bytes: thresholds and the run's name live in the file's own `zpcrweb.json`, so the bytes that
just arrived are the authority on them. Anything of the app's own still waiting to be written is
flushed out first, so a pending edit wins over what is currently on disk rather than being
discarded by it.

### Writing

`persistFile` stays the single choke point. For a disk-backed file it writes the catalog row and
marks a third `WriteThrottle` dirty (`DISK_WRITE_INTERVAL_MS`, 3 s), whose write re-zips the archive
with `zpcrweb.json` layered in exactly as a download does and hands the bytes to `writeDiskFile`. A
disk write is always the *whole* file — there is no per-entry delta to exploit the way there is in
IndexedDB — which is what the throttle is for.

Three things this had to be careful about, each of which was a bug first:

- **Opening a file must not write it.** `install` would otherwise re-zip a `.zpcr` the moment it was
  read and write it straight back: different bytes, a moved mtime, an edit nobody made. `install`'s
  `diskInSync` flag says "the disk already has this" and only the catalog row is written.
- **`AnalysisPersister` is the one writer that reaches `putFile` without going through
  `persistFile`.** For a disk-backed file it is skipped entirely, and `updateSettings` marks the
  disk throttle instead — otherwise a copy of the run would accumulate in IndexedDB and be read in
  preference to the disk on the next load.
- **Closing a file must write what it already owed, and nothing more.** `closeFile` flushes the disk
  throttle first — the edit was made, and it is only the throttle that hasn't got to it — and then
  `forget` drops the entry so a *later* write can't fire against a file the app has stopped holding.
  Nothing here ever deletes anything on disk: closing a disk-backed file is the app forgetting about
  it, and the file stays exactly where it is.

### A run in progress is the exception

While the instrument is writing a run, its plate reads go to IndexedDB exactly as any other file's
would — one small record per read, the cheap append `changedEntries` exists for — and the file on
disk is left alone. Writing a whole archive to disk forty-five times over a two-hour run would be a
great deal of churn for a file nobody can use until it is finished.

The moment the `ended` marker arrives the run stops being in progress, and an effect watching
`inProgressIds` writes the finished run to disk once and drops the IndexedDB records with
`deleteContent`. Disk sees a single write; a reload mid-run still recovers, because the buffer is
there. `loadOne` therefore reads IndexedDB *first* even for a disk-backed file: if there are records,
they are a run in progress and they are the current copy.

### What this cannot do

The API never discloses an absolute path. A directory handle knows its own leaf name (`runs`) and
nothing above it, so a disk-backed file's name is folder-rooted rather than absolute — see "A file
is its name". Rename is refused for the same family of reasons, recorded there. And a handle
restored from IndexedDB usually comes back with its permission reset to `prompt`, so a folder's
header carries a **Grant access** button: `requestPermission` needs a user gesture, and the click
supplies one.

## Views

- **Overview** — the shared file toolbar (download/edit/clone, see "The Overview toolbar" below)
  beside a single info table (file identity, run metadata from `zpcr.metadata` — including
  a "Protocol" row with just the protocol's name, from `zpcr.protocol()`; the full thermal
  protocol lives on its own Protocol tab, see below — and an "Encrypted" row, see above) plus a
  "Plate" section listing the plate's targets and samples as chips. The Encrypted row shows
  green "No" when nothing in the file is encrypted, orange "Yes" with the password used when
  encrypted content was successfully decrypted, or red "Yes" when it wasn't. The file bar's
  per-chip icon (`components/FileBar.tsx`) mirrors the same three states/colors, computed the
  same way for `.pltd`/`.csv` chips via `lib/encryptionStatus.ts`'s
  `plateFileEncryptionStatus`.

  Each target/sample chip carries that group's positive/negative curve tally — how many of its
  well/fluor curves got a Cq and how many didn't — as two counts either side of a small track
  filled to the positive fraction (`CountChip`/`.chipcount`). The numbers come out of
  `useRunAnalysis`'s single Cq table (`@zpcrweb/core`'s `computeRunAnalysis`), the same one the Curves view reads,
  so a chip can't disagree with the Curves table about the same well; the tally is per *curve*,
  so a duplexed well contributes to each of its dyes. That's why Overview takes `settings` —
  thresholds and calibration options change the Cq table. Unloaded wells are skipped, and the
  chips render bare (name only) whenever the Cq table is empty: an uncalibrated run, or a plate
  still behind the password prompt.
- **Protocol** (`components/views/ProtocolView.tsx`) — the thermal protocol itself: the
  structured step table (`ProtocolStepsTable`) when the format provides one, otherwise the
  annotated `ProtocolDecoded` listing of `zpcr.protocolText`, plus the replace/download/clone
  toolbar described under `PlateDownloadButton` above. Reads only `zpcr.protocol()`/
  `zpcr.protocolText`, so it works identically for a `.zpcr`, a `.pcrd` or a Biomeme run — the
  same format independence `OverviewView` has. Split out of Overview so a run's protocol detail
  doesn't crowd the summary. **The same component serves a standalone `.prcl.txt`** — see "One
  Protocol view" below for what it varies and what it doesn't.

  Beneath the step table, when the run carries a `.alf` report (`zpcr.runReports()`), the
  **thermal profile as run** — `ThermalProfileChart` over core's `alfThermalProfile`
  ([`alf.md`](../../docs/alf.md) §7.6). The pairing is the point: the table states what was asked
  for, the plot states what it cost, and a 30 s hold that occupied 46 s is only visible in the
  second. It's the one section here that isn't format-independent — a `.pcrd` carries no report
  ([`alf.md`](../../docs/alf.md) §1), so the section simply doesn't render for one.

  A **third uPlot builder** (`lib/uplot/thermalChart.ts`) for the same reason `calChart.ts` is a
  second one: it shares neither axis with either of the others — the only plot in the app whose x
  is wall-clock time and whose y is a setpoint rather than a reading. The trace is **one solid
  line**: ramps and holds were separate series once, dashed against solid, and it read as two
  competing traces rather than one temperature over time — the split is already in the geometry,
  a ramp being the sloped part and a hold the flat part, so the phase survives only in the
  tooltip. Straight segments throughout, because `took − hold` gives a ramp's *duration* and
  nothing about its shape, and curving it would invent data the report doesn't have. Plate reads
  all get a point, but only as many *numbers* as clear a pixel gap are drawn, first and last
  always — thinning the labels rather than the points keeps the count on screen honest.
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
  (replicate, quantity, the fluor→channel→target mapping) is in each cell's **hover card**, and
  the 320px column it needed was one a narrow container could only stack below the grid. That card
  is the Curves view's `HoverCard` (`PlateViewer`'s `wellCard`), so a well reads the same in both
  views — same title, same sample-type/sample subtitle, same dye-coloured swatch per fluor —
  minus the Cq column, since a plate definition is a setup with no run to quantify. Wells are
  therefore not clickable; the hover outline stays, as a reading aid pairing with the card.
  Cells: each well cell writes the well's `sample` and each loaded fluor's `target` directly
  into the cell, the target text colored by that fluor's dye (`fluorColor`) — trading
  grid density for being able to read sample identity and target at a glance. Every cell is the
  same fixed set of lines: one for the sample name, then **one per optical channel**, in the
  channel order `PlateViewer.fluorOrder` computes (unknown channel last — the same order the
  fluor chips above the grid use). Two dyes in one emission band, such as the mixed-vessel
  plate's ROX and Tex 615 on Ch3, share a line instead of each taking one: no well can be read
  for both, so the second line was blank in every cell and pushed the channels below it down a
  row. `PlateViewer.fluorLine` keys a line by the dye's **colour**, which needs no channel
  lookup — the dye palette *is* the channel palette (`lib/fluorColors.ts`), so band-mates already
  share a hue — and so groups a `.plt.csv` opened with no run beside it (no `.Dcal`, hence no
  channel stated at all) the way the same plate groups inside its run. A dye the palette doesn't
  name keys on its own name and keeps its own line. A well that carries nothing on a channel
  renders that line blank rather than pulling the ones below it up, so a target always sits on
  its own channel's line and a column of cells can be read down. On the rare hand-authored plate
  that does load two dyes of one channel into one well, the line names both (` · `-joined)
  rather than hiding one. The line count is published as the
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
- **Instrument** — a live instrument over USB, pointed at an experiment it names itself; always
  enabled, and not a lens on the selected file. See "The Instrument view" below.
- **About** — `AboutView` (`components/views/AboutView.tsx`): one card carrying both the credits
  (name, the "nothing leaves your device" line, author and GitHub links) *and* the large
  `DropZone` plus the "Load an example file" link. About and the welcome screen used to be two
  separate screens; they're one now, so a first-time visitor sees what the app is and where their
  data goes on the same screen that asks for a file, and there's a single place to keep current.
  It's the one view with no tab in `ViewBar` — the header wordmark is a `<button>` that
  switches to it — and the one that renders with no file loaded, so the empty state's
  `app--empty` branch shows it unconditionally. `onBack` is what distinguishes the two uses:
  `App` keeps the last non-About view in a ref and passes `onBack` only when a file is loaded, so
  "← back" returns where the user was and the welcome screen (with nowhere to go back to) omits
  the button; with a file loaded the tab strip stays visible (no tab selected) as a second way
  out. Being file-independent, it is also exempt from the standalone-plate view fallback — which
  is why picking a file chip from About is a third way out: `selectFile` sends that click to
  Overview, since a selection change on its own would leave About on screen and make the click
  look like it did nothing.

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
- **`ProtocolRunDefinition.txt`** → `ProtocolDecoded`, one directive per line with its step
  number and, in the right-hand column, the library's plain-English reading of it ("Return to
  step 2 (TEMP 95.0,10) — 45 passes in total"). It renders `parseRunDefinition()`'s directives
  and **parses nothing itself**: the verbs, the step numbering `GOTO` counts in, and the
  `PLATEREAD` scan mask are all core's, per [`protocol.md`](../../docs/protocol.md). Takes plain
  `text`, so `ProtocolView` and the Instrument view's protocol panel reuse it unchanged — the
  latter with `annotated={false}`, which drops the reading column and leaves the program itself
  (plus the scan mask's channels and sweep mode, on a sub-line — a packed operand no text says).
- **`.prcl`** → `DecodedProtocol` (`components/raw/DecodedProtocol.tsx`), which decrypts the
  entry and renders `ProtocolDetail`: when the XML `protocol2` payload parsed into a step list,
  a settings panel (lid/shutoff/volume/real-time — flags the text grammar has no directive for)
  plus a numbered step table via the shared `ProtocolStepsTable` +
  `describeProtocolStep` (`components/raw/ProtocolSteps.tsx`, core) — reused verbatim by
  `PcrdRawView`'s **Protocol** node and `ProtocolView`'s thermal-protocol block, so all three
  format the same `ProtocolStep[]` identically (GOTO-target-friendly numbering, a `●` read
  marker). Falls back to `ProtocolDecoded` on `runDefinition` for the plaintext `.prcl` variant
  (`prcl.md` §1.1), which carries no XML step list — and *without* the settings panel, since
  there the lid and volume are directives the annotated listing already explains, so showing
  them twice would be two views of one line.
- **`.alf`** → `DecodedAlfFile` (`components/raw/DecodedAlf.tsx`) — the instrument's own run
  report ([`alf.md`](../../docs/alf.md)), rendered whole per the everything-the-file-holds rule under
  "Raw views" below: one block per line role the format has (§2).

  - **Run header** — all 15 fields of line 1 in the file's own order (§4), including the two that
    are empty in every sample seen. Field 1 is the run name for a PC-started run and the selected
    protocol's *path* for one started at the touchscreen, so both it and its basename are listed.
  - **Protocol as executed** — line 2 through the shared `ProtocolDecoded` listing. Post-expansion,
    with the scan mask the run really used (§5), which is what makes it a different document from
    an archive's authored `.prcl` rather than a second copy of one.
  - **Errors** — the summary string, then all 8 fields of line 3 (§6), the code list included
    whatever it says: only the empty `0:` has ever been observed, so its grammar is unknown and it
    stays text.
  - **Execution log** — one row per logged step, all nine of its fields, under a heading counting
    the steps, stages and plate reads it holds (none of the three is a field — a stage boundary is
    where the repeat counter went backwards, §7.2, and a read's index is its position among the
    `Plate Read` lines, §7.5). Twelve columns: the derived stage, then field 1 (`Cycle`, the
    constant `-1`), repeat, step number, `RAMPTIME` (CFX Manager's own name for field 4 — §10 for
    where the name comes from, §8 for why it doesn't measure a ramp; the heading names the field,
    the note under it says what the field isn't), the directive that step number names (joined from line
    2, §5), setpoint, nominal hold, the full timestamp, the derived **Took** (= the next line's
    timestamp minus this one's, §7.4 — the only measurable ramp cost), the paused pair (fields 8
    and 9, meaningless apart), and the read index. A rule marks each stage boundary; the sentinel
    becomes the end-of-run row (§7.3).

  The Protocol tab plots this same log as a thermal profile. That is not duplication of the kind
  two protocol listings would be: the plot is the shape of the run, prettified to be read at a
  glance; the table is what each line literally says.

- **other `.xml`** (e.g. `runlog.xml`) → the shared collapsible `XmlTreeFromString`
  (`lib/xmlTree.tsx` — see "Raw views" below).

XML rendering is a *presentation* concern (not `.zpcr`/`.pcrd` decoding), so it lives in the
app, not the library.

## The run's name

The file bar and the Overview view lead with what a run is **called**, not with its file name: a
chip is the run's name over a compact local timestamp, and the file name moves to the hover card
and to a "Filename" row of the Overview's info table. A name like `20260726_S183-S185_RVP.zpcr`
is three facts glued together (a date, a machine, a name) in a form that is wide, hard to scan,
and mostly redundant with the rest of the table.

No format carries a name except Biomeme's (see `zpcrweb-json.md` §1.1 for the evidence), so the
app resolves one — stored name, else the format's own, else derived from the file name —
in `@zpcrweb/core`'s `experiment.ts`, with the app-side half (where the stored name comes from,
how a `Date` renders) in `lib/experiment.ts`. The date is always **local**: the instrument writes
`RunStartTime` in GMT, which is the wrong answer to "when did I run this?" by a whole day for an
evening run west of the meridian.

Two placement decisions worth keeping:

- **`ZpcrStore.experiments`, not a per-view lookup.** The bar needs an identity for *every* file
  while `store.settings` is assembled only for the active one. Resolving them all in the store
  also means the chip shows a rename immediately, from the same live state the Overview header
  edits, rather than after the archive's next rewrite.
- **`experimentName` rides in `AnalysisSettings`** despite not being analysis. That interface is
  what routes a settings key into the file rather than into IndexedDB (`ANALYSIS_KEYS`), and a
  name belongs to the run for exactly the reasons the thresholds do. On disk it is a *top-level*
  `zpcrweb.json` key, since it changes no reported number — `analysisSettings.ts` is the one
  place that conversion happens.

The Overview header's name field is where a run's *name* is edited, and clearing it is
meaningful: the stored name is removed and the run falls back to its derived one. A derived name
is never written back, so renaming the file on disk still renames the run. For a `.pcrd` or a
Biomeme run there is no archive to write into, so the edit lasts the session — the field says so
in its tooltip rather than losing it silently.

## One Overview panel

There is **one** Overview component, `components/views/OverviewPanel.tsx`, not one per file kind.
What an Overview *is* — what the file is, what it's called, and the tools to save/rename/copy it —
is the same question for a run, a standalone plate and a standalone protocol alike, and three
panels answering it separately is exactly how they drifted: download existed only for a run, the
rename control only as a lone button, and each kind kept its own copy of the info table and the
edit-in-place filename logic.

The panel owns everything shared and unconditional: the `Type`/`Filename`/`Last modified` rows
every kind leads with, the filename's edit-in-place behaviour (`useFilenameEditor` — commit on
blur/Enter, Escape reverts) including the auto-open a fresh clone arrives with, and the
**download / edit / clone** button column down the right of the info table (`OverviewToolbar`).
Those buttons act on the *file*, which is the one thing every kind has in common, so every kind
gets the identical set — there is no longer anywhere for one to have a tool another lacks.

A kind varies it through four optional slots and nothing else:

| Slot | What it's for | Who passes one |
|------|---------------|----------------|
| `rows` | info-table rows appended after the three shared ones | a run (block/serial/channels/…), a plate (dimensions, vessel, encryption) |
| `header` | above the table | a run's editable experiment-name headline |
| `banner` | under the header | a run's "still going" notice |
| `children` | sections below the table | plate chips; a plate's password prompt |

So the three views are now thin: `OverviewView` computes the run's rows and passes all four slots,
`StandalonePlateOverviewView` passes rows and children, and `StandaloneProtocolOverview` is a
one-line pass-through — a protocol file has nothing of its own to add, so the bare panel *is* its
Overview. Each takes the panel's file-tool props straight through via
`Pick<OverviewPanelProps, …>` rather than redeclaring them, so a new tool reaches every kind at
once.

The plate's target/sample chips are likewise one component, `OverviewPlateSection`, used by both
the run and the standalone-plate panels. A standalone plate simply passes no `cqTable`: `CountChip`
already falls back to a plain name chip with no tally, and the count-descending sort is a stable
no-op when everything counts 0/0, leaving the plate's own order. Keeping the two apart is what let
the run's chips gain colours and tallies the plate's never got.

**Clone** (`App.tsx`'s `cloneActiveFile`) copies the active file under the next free
`name (N).ext` — incrementing an index the name already carries rather than nesting a second one,
see `lib/cloneName.ts` — and opens the copy with its filename field focused, ready to be typed
over. It goes through `addFiles` like any other new file, so the copy is validated, persisted and
activated by exactly the path a dropped file takes; the bytes are `exportBytes`, so a run's clone
carries the analysis settings currently on screen and an edited `.prcl.txt` its edits. The copy
lands `modified`, since it exists nowhere but the browser until it is saved. The `(N)` naming is
load-bearing rather than cosmetic: `addFiles` *replaces* a same-named file, so a clone that reused
the name would silently eat the original.

The "open it ready to be renamed" half is a request held in `App.tsx` (`editNameFor`, keyed by
file id and cleared by the panel once acted on) rather than a flag, because the clone is added
asynchronously — by the time the new file is active and its Overview renders, the id is what says
*that* one was just made, and a file selected some other way meanwhile doesn't inherit the request.

The Edit button is a separate control from the run-name field above it, for a separate field: it
turns the info table's "Filename" row into an edit-in-place input (the same commit-on-blur/Enter,
Escape-reverts pattern as the name field), and calls `ZpcrStore.renameFile`. For a `.prcl.txt` or
a standalone plate it is the *only* identity there is to edit, neither kind having a stored name.
Renaming the *file* is a bigger operation than
it looks: the name **is** the key (`db.ts`'s `FileIdentity`), so a rename re-keys the file, and
`renameFile` migrates every name-keyed map (`settingsMap`, `analysisMap`, `activeName`, the analysis
persister's pending writes) rather than just patching `LoadedFile.name` in place — the same
supersede-by-name logic `addFiles` uses for a same-named re-upload handles a rename that collides
with an
already-loaded file. It marks the file `modified`, since a download now writes different
bytes-under-a-name than what's on disk under the old one.

An experiment's name is asked for in exactly one place, this field, and only while the experiment is
**pending** — where it is required, since an experiment cannot be started without one (see "The
Instrument view"). It used to be a second name field on the Instrument tab, for a run that did not
exist yet; now the run exists as a file before it is started, so there is nowhere else the question
needs asking. Naming a pending experiment also renames its *file*, to the `<YYYYMMDD>-<name>`
convention every run's file follows (`App`'s `nameExperiment` over core's `runFileBaseName`) — the two
are one action here and nowhere else, since leaving the placeholder file name in place while the run is
called something else would have the file bar, the download and the instrument's own deposit disagree
about which run this is.

## Raw views

**The rule, everywhere: a raw view shows absolutely everything the file contains, at exactly the
detail the file holds it in. Every other view is allowed to prettify and simplify in order to be
useful.** That is the division of labour the app is built on. Overview answers "how did this run
go", Curves answers "what did well A1 do", Protocol answers "what was going to happen" — each of
them chooses, summarises, and leaves things out, and each is better for it. Raw is where that
choosing stops. Someone opens it precisely because a prettified view left out the thing they need,
so a field skipped there has nowhere left to appear, and the app becomes less capable than a text
editor on the same bytes.

In practice this means: no field is dropped for being empty (it is shown as `∅` — that the file
carries it and left it blank is itself a fact), and none is dropped for being uninterpretable. A
column nobody can explain gets a neutral heading and its literal contents, never a guess and never
silence — `.alf`'s fourth step column and its constant `-1` first column are both shown for exactly
this reason. Decoding into named fields, joining a step to the directive that numbers it, and
deriving what the file implies but never states (a step's duration) all *add* to the file; they may
never subtract from it. Where a decode needs a field core doesn't parse yet, core grows the field —
that is why `AlfStep.cycleField` exists.

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
(`.xml`/`.txt`/`.alf`/`.json`/`.log`/`.plt.csv`, plus the traffic log below), else **Hex**
(`archive.hexDump`, paginated). Text
mode renders the collapsible XML tree whenever the content is XML (`RunInfo.xml`, `runlog.xml`,
`GlobData.xml`, and the decrypted `.pltd`/`.prcl` payloads, which label the mode "XML") and the
plain dump otherwise. Switching files resets the mode **during render** rather than in an effect,
so the new file never paints a frame in the old file's mode (picking `runlog.xml` from a
`RunInfo.xml` left in Text mode used to flash its XML before snapping to the decoded table).

**The download button saves whatever the current mode is showing**, and the mode decides both the
bytes and the name (`RawFilesView.handleDownload`):

| Mode | What it writes | Name |
| --- | --- | --- |
| Decoded | the rendered table flattened to CSV (`decodedToCsv`), or every well/channel of a `.Plateread` (`plateReadToCsv`) | `<entry base>.csv` |
| Text | what the text pane holds — the decrypted `.pltd`/`.prcl` XML, the rendered traffic log, the file's own text | the entry's name, or `<base>.xml`/`.txt` where the text isn't the stored form |
| Hex | the entry's stored bytes, verbatim (`downloadBytes`) | the archive entry's own name |

Hex is the mode that gets a file *out* of a run unchanged: no re-encoding, no extension swap, and
no truncation to what the paginated dump happens to have drawn. `zpcrweb.json` is the one entry
whose "stored bytes" are the synthesized live ones (below), which is what the dump on screen shows
too. `StandaloneRawView` has the same button, always saving the whole file — there is no archive to
pick an entry out of. The Hex download is asserted end to end by `uitest`'s `rawHexDownloadChecks`.

**`usb-traffic.bin`** — the wire log the Instrument view records for a run it drove itself (see
"The Instrument view") — groups under **Metadata** and opens in **Text**, the one entry that is
binary and yet does. Its stored form is records (`usb-traffic.md`); the text is what a reader wants,
and **this view is where that rendering happens** (`formatUsbTrafficBytes`), which is also why it
downloads under the text name `usb-traffic.log` rather than the entry's own. There is no *Decoded*
mode because the text already is the decode — one line per message with the payload bytes on it —
and no XML tree, since it isn't XML. A `.zpcr` written before the binary format carries a plain-text
`usb-traffic.log` instead, which needs none of this and reads as ordinary text.

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

### `StandaloneRawView` (one file, no archive)

The third raw view, and the smallest: a viewer with no file list beside it, for a top-level entry
that *is* a single file — a standalone `.pltd`/`.plt.csv`, a `.alf` run report, and a Biomeme
`.bmrun`. Same toolbar and Text/Hex modes as `RawFilesView`, with the text tab named for what it
holds ("XML" for a `.pltd`'s decrypted payload, "JSON" for a Biomeme run, "Text" otherwise), and
the same `looksLikeXml` sniffing deciding between the XML tree and the flat dump.

A `.alf` additionally gets **Decoded**, and opens on it, exactly as it does inside an archive: same
`DecodedAlfFile`, same everything-the-file-holds rendering. A report's own text is a `*`-delimited
wall of numbers, so a raw view without the decode beside it would make the app *less* useful for a
file it owns outright than for the same file zipped inside a run. The other standalone kinds have
no decoder to offer here — a plate's is the Plates tab's, a protocol's the Protocol tab's — so for
them the toggle stays two buttons wide.

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

## One analysis per run: `@zpcrweb/core`'s `runAnalysis.ts`

**The rule: analysis is computed once, by the library — and every other module, in this app or
any other consumer, is downstream of it.** Nothing in the app calls `baseline.ts`/`threshold.ts`,
and no view derives a baseline, noise estimate, threshold or Cq of its own, not even for something
as apparently cosmetic as where to draw a line. A curve's analysis travels with it as one record
(`CurveAnalysis`), and a view's job is to project that record onto the screen.

The derivation itself — fluorophore/target grouping, calibration matching, color separation and
the Cq table — lives in `@zpcrweb/core`'s `computeRunAnalysis` (`packages/core/src/runAnalysis.ts`),
not in this app. It moved there from a web-only `useRunAnalysis` once a second, non-React consumer
(`tools/zpcr.mjs`, a CLI that prints a run's results table as CSV) needed the identical
derivation: the alternative was copying the ~450-line hook body by hand and hoping the copy never
drifted from the original, which is exactly the failure this section exists to rule out for
*every* consumer, not just the ones inside this app. `apps/web/src/lib/runAnalysis.ts` is now
just the React face of it — one `useMemo(() => computeRunAnalysis(zpcr, settings, activeStep,
password), deps)` — kept only because the derivation genuinely has nothing to do with rendering
and doesn't need re-running on every render.

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

`computeRunAnalysis(zpcr, settings, activeStep, password)` (called through `useRunAnalysis` in
this app) is that single run-level derivation, shared by the Curves view's chart, hover cards and
table mode: plate + password state, fluorophore/target groups (`targetGroups()`, same module), the
calibration matrix and `calibration.md` §4 corrections, the color-separated `allFluorCurves` —
and, on top of those, the run's **Cq table**.

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
  channel space (`dyeSpace`, a fifth parameter) since a pseudo-inverse per well per cycle was real
  work. It no longer is, twice over: the target thresholds and the CSV export are target-based in
  *every* view mode and both read `cqTable`, which is empty without it — `OverviewView` already
  pays for the same solve on every run — and the pseudo-inverse is now taken once per calibration
  matrix rather than once per well per cycle (`calibration.md` §5), leaving the solve itself a dot
  product.

## A third format: Biomeme

`@zpcrweb/core`'s `parseBiomeme` decodes a Biomeme handheld instrument's `.bmrun` run export into
the same `Zpcr` shape `parseZpcr`/`parsePcrd` produce (see the root
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#a-third-non-cfx-input-biomeme) and
[`biomeme.md`](../../docs/biomeme.md)), so `useZpcrStore` routes it through the exact same
`RunResult`/`useRunAnalysis` pipeline every other run uses — `.bmrun` names the format, so
`fileKind()` (`state/useZpcrStore.ts`) routes on the extension like every other format bar `.txt`,
and from there on almost nothing in the app
needs to know it isn't a `.zpcr`. Two real differences do surface, both because they're
capability checks rather than format checks:

- **Fewer live view tabs.** `App.tsx`'s `BIOMEME_VIEWS` enables only
  Overview/Protocol/Curves/Plates/Raw — Reference has no reference row to show and Calibration has no
  `.Dcal` set. The same pattern `isStandalonePlate` already used for a bare `.pltd`/`.plt.csv`
  entry. Raw *does* appear, but not through `RawFilesView`: the run has no archive to browse
  (`Zpcr.archive` is honestly empty, the same "nothing here" `.pcrd` already models) and yet is
  very much a file to read, so it renders through `StandaloneRawView` — the same one-file, no
  file-list viewer a standalone `.plt.csv` gets, which labels the text tab "JSON" and shows the
  document verbatim. Nothing is re-indented on the way to the screen; the point of a raw view is
  the bytes as written.
- **It names its own run** — top-level `name`, which no Bio-Rad format has an equivalent of; see
  "The run's name" below.
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
- `allFluorCurves` comes from `@zpcrweb/core`'s `dyeSpaceFluorCurves()` instead of
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
  whose row and column headers toggle whole rows/columns, plus an all/none corner. Hovering and
  double-clicking follow the same grain as clicking: a cell highlights or isolates its own well,
  a row/column header every well it would toggle (outlining them in the grid and peeking at them
  on the chart, as one `"wells"` `HighlightMatch` — see "Rail hover highlight" below). Once the
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
  - **The Targets/Fluorophores and Samples lists follow the enabled wells.** Both bars are
    filtered to what the currently enabled wells can actually show: `visibleChipItems` keeps only
    chips whose key some enabled well produces (its loaded dyes run through `labelForFluorCurve`,
    or every plate dye when "Unloaded" is on), and `visibleSampleList` keeps only sample names
    sitting in an enabled well — so narrowing the plate selection narrows the rail with it, and
    the Samples section disappears entirely when no enabled well names a sample. Double-click
    solo still works off the *unfiltered* `chipItems`/`sampleList`, so isolating one chip also
    disables the ones currently hidden rather than leaving them to reappear when wells come back.
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
  which is shown (`@zpcrweb/core`'s `ANALYSIS_BASELINE_MODE` constant, fixed at
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
  fitted line itself, e.g. `"2000 + 4c"` (`c` = cycle number), via `@zpcrweb/core`'s
  `formatBaselineFormula()` over `CurveBaselineResult.baselineFit` (`{ slope, intercept }`,
  `packages/core/src/analysis.ts`), not a single diagnostic RFU number.
- **Number formatting:** `@zpcrweb/core`'s `runAnalysis.ts` owns two helpers used by every analysis-facing readout, so the
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
  distinct `WellDefinition.sample` name assigned to an *enabled* well on the plate (`pltd.md`'s
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
  `"refcol"` match variants join the pre-existing `"target"`/`"wells"`/`"channel"` ones —
  `"wells"` carries a *list* of well labels, so one hovered cell and a hovered row/column header
  take the identical path, differing only in how many labels they send — the
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
  Both sets of rows take their Cq from the run's single Cq table (`@zpcrweb/core`'s `computeRunAnalysis`) by
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
  Double-clicking a chip/cell (`onSolo`/`onSoloWells` on each of the four components) isolates it
  within its own dimension — `CurvesView`'s `soloChannel`/`soloFluor`/`soloWells`/`soloSample`
  reset that dimension's enabled/disabled set so only the double-clicked item remains on. In
  `WellMatrix` that gesture runs at the same grain as click and hover do: `onSoloWells` takes a
  *list* of well keys, so a cell sends its own and a row/column header sends the whole row or
  column, isolating exactly the wells its click would have toggled. `uitest.mjs`'s
  `wellHeaderChecks` covers both headers.
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
  "View" in the rail, distinct from the baseline `CurveView` toggle above): `@zpcrweb/core`'s
  `matchFluorCalibrations()`
  matches the plate's fluorophores to this run's `.Dcal` data, builds a calibration matrix per step
  (restricted to the scanned channels, so its RFU scale factors are measured over the right rows —
  one matrix for the whole plate unless the plate mixes vessels or dye sets), and solves every
  well/cycle against the pseudo-inverse that matrix carries — see
  [`calibration.md`](../../docs/calibration.md). `CurvesView`
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
  (`@zpcrweb/core`'s `NO_TARGET`/`targetGroups()`, shared with table mode) — on by
  default like every other target, so a partially-annotated plate's remaining curves stay
  labelled and toggleable rather than showing up under their dye name with no chip. That
  catch-all is only added *alongside* real targets: on a plate with no `geneName` anywhere,
  target mode is already de facto fluorophore mode, and one lumped group would merge the dyes'
  per-group Cq thresholds — so those curves keep falling back to their fluor name (the same
  reason table mode falls back to fluorophore grouping there; see `usingTargets` below).
  Both modes keep the same dye-derived color (`FluorChip.fluor`, via `fluorColors.ts`) — target
  mode does not introduce a new color scheme, just a different grouping/label built by
  `CurvesView`'s `labelForFluorCurve`/`targetInfos`. A group spanning several fluorophores
  (`"(none)"`, or a target loaded as more than one dye) has no single dye to borrow from, so its
  chip takes `NEUTRAL_COLOR` rather than one member's hue.

### Table mode

The former standalone **Analysis** view, folded into the Curves view as the fourth option of the
rail's "View" toggle (`fluorViewMode: "table"`). It replaces the chart with a table of one row per
visible (target, well) pair — Cq, endpoint ΔRFU and §7's End RFU — while the whole rail
(targets, wells, samples, background, thresholds) keeps driving it. It was a separate tab with a
near-identical rail of its own; the two disagreed about Cq (see "One Cq per well/target" above) and
about which targets were filtered, so the tab is gone and its two unique controls — the threshold
overrides and the CSV download — moved into the Curves rail, where they apply to the chart too.

Rows come from `@zpcrweb/core`'s `analysisRows.ts` (`buildAnalysisRows`/`analysisCsv` — also what
`tools/zpcr.mjs`'s `results` command calls directly, with no app in the loop), rendered by
`components/curves/CurveTable.tsx`. Table mode is dye-space-only, for the same reason "Target" mode
is: a per-target curve needs channel→dye color separation (`calibration.md`).

- **One row per (target, well) — or (fluorophore, well) with no targets assigned:** built from
  `PlateDefinition.wells[].fluors[]`, for `loaded` wells only — an unloaded pair can still be
  *plotted* ("Unloaded") but has no real measurement to tabulate. Grouping keys on
  `RunAnalysis.groupOf`: `WellFluor.target`, the shared `"(none)"` catch-all `@zpcrweb/core`'s
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
- **Six cells per row are pickers, not just values** (`PickCell` / `.atbl__pick`): clicking one
  isolates what it names and swaps the table for the **Target** view charting it, which is the
  table's answer to "what does this row actually look like?". Well, Sample and Target each isolate
  their own dimension — the same thing double-clicking that chip in the rail does, leaving the
  other two dimensions as they were. The three *result* numbers (Cq, ΔRFU, End RFU) instead isolate
  the single curve they were measured on: well **and** target together, since all three describe
  that one curve rather than a group of them. `CurvesView`'s `pickWell`/`pickTarget`/`pickSample`/
  `pickCurve` do the work, so the isolation goes through the same `enabledWells`/`disabledFluors`/
  `disabledSamples` settings every other control writes; nothing about the selection is special to
  the table. The button carries no chrome of its own — the value keeps its chip, and the affordance
  is the pointer cursor plus a hover brightening — because six buttons' worth of borders would bury
  the numbers they sit on. Covered by `tools/uitest.mjs` (`tablePickChecks`): which mode is active
  and which chips survive a click is state no screenshot can show.
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

  **The chart edits back: a Cq ring is a drag handle for its own curve's threshold.** `buildChart`
  returns the rings it draws (`CqMarker`, carrying the index of the curve each belongs to);
  `CurveChart` hit-tests them against the pointer (`hitTestCqMarker`, a 9px grab radius around a
  4.5px ring, skipping curves the rail has dimmed) and, on a grab, turns each vertical mouse move
  into a threshold with `thresholdAtPixel` — `posToVal(y) − plotDelta`, the exact inverse of the
  projection the dotted threshold line is drawn with, so the ring rides *to* the pointer while
  sliding along its curve to the new crossing. `CurvesView`'s `dragCq` writes it to
  `curveThresholdOverrides` like any typed value, so a drag and the row's own input are the same
  edit, and `threshold.md` §5.3's precedence needs no special case for either.

  Three details make the gesture work:

  - **The drag opens the row it is editing** (`beginCqDrag`): the Threshold `<details>` is forced
    open, `ThresholdSection`'s `revealCurve` prop expands that fluorophore and scrolls the curve's
    row into view (`block: "nearest"` — the pointer is mid-drag, and a rail that jumps reads as the
    app losing its place), and the row is marked (`.is-revealed`) for the duration. The same
    `hoverThreshold` state a rail hover sets is set too, so the threshold line and the curve's
    baseline-region diagnostic are drawn while the drag lasts. A threshold set invisibly would be
    indistinguishable from the chart misbehaving.
  - **The plot stops watching the mouse for the duration** (`pointerEvents: "none"` on `u.over`,
    re-applied to each rebuilt instance, plus a tooltip that refuses to raise while
    `cqDraggingRef` is set). uPlot sees only a mouse crossing a chart and tracks it — a vertical
    rule, a hover point on every series, the tooltip — and under a drag all of that is re-created
    on every frame, so it flickered. It is also answering a question ("what is under the
    pointer?") nobody is asking while the pointer is holding a handle. `pointerEvents` rather than
    a uPlot cursor option because the whole apparatus has to stop at once and the switch has to
    survive being re-applied to a fresh instance; the `mouseout` it triggers is what clears the
    cursor already on screen.
  - **`mousedown` is taken in the capture phase on the chart host**, an *ancestor* of uPlot's own
    `.u-over` listener, so grabbing a ring can `stopPropagation` and suppress uPlot's drag-to-zoom.
    Two listeners on `.u-over` itself would fire in registration order — uPlot's first — whatever
    phase we asked for.
  - **The drag outlives the plot it started on.** Setting a threshold re-runs the run's analysis and
    rebuilds the whole uPlot instance, so the listeners live on the component (bound once) and on
    the window, and every move re-reads `plotRef`/`metaRef`/`cqMarkersRef` and re-resolves the
    curve by well label + fluorophore rather than trusting an index captured at grab time. Moves
    are coalesced to one threshold per animation frame, since they arrive faster than an analysis
    is worth re-running.

  Only dye space has rings to grab — channel curves carry no Cq (`channelAnalysis`) and have no
  per-curve threshold to set — so the handles are simply absent there rather than present and inert.
  One gap, since the per-curve list is the plate's *loaded* wells: a curve plotted only because
  "Unloaded" is on has no row to reveal, so dragging its ring sets a real override with the chart as
  the only feedback.
  Driven by `cqDragChecks` in `tools/uitest.mjs`, which is the only place any of this can be
  checked: a screenshot can't show that a ring is grabbable, and the core suite has no DOM.

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

They take effect in exactly one place, `@zpcrweb/core`'s `runAnalysis.ts`'s `blendWithFileAnalysis`, called
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
baseline fit against the instrument's own Cq call (or the reverse) is a real, useful combination, not
an edge case to prevent. Picking "file" baseline with "computed" Cq means the chart's marker sits
at this library's threshold against the *file's* corrected curve, which won't necessarily land
exactly on a crossing — an honest picture of two independent analyses compared piecewise, not a
bug. `biomeme.md` §3 has the measured numbers motivating why this is a toggle rather than one
pipeline reproducing the other: 19/27 curves on the committed sample agree on amplified-or-not,
median 4.0 cycles apart where both report a Cq. Both sides are 1-indexed by the time the toggle
sees them — a Biomeme export's `cq` is 0-indexed and `parseBiomeme` shifts it at the parse
boundary (`biomeme.md` §2.1), so nothing in this app compensates for it.

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
  `matchFluorCalibrations` matches on (this plate's fluorophores, the tube type(s) its wells sit
  in, both compared case-insensitively), and those are what's shown; everything else is one
  chip-click away. A plate that mixes plastics (`pltcsv.md` §3.1) marks *both* groups in use,
  because such a run really does read both halves of the set — one calibration matrix per vessel
  (`calibration.md` §3.1). `inUse` decides the default selection and **nothing else** — in particular it doesn't
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

### A dye's colour is the dye's, not the channel's

`lib/fluorColors.ts` maps a **dye name** to a colour, and everything dye-shaped reads it: plate
well dots and per-fluor target text (`PlateViewer`), dye/target chips (`FluorBar`, via
`FluorChip.fluor`), target chips on file cards and Overview, dye-space curve strokes, baselines,
Cq markers and hover-card rows (`curveColor` in `chart.ts` and `CurvesView`). `channelColors.ts`
keeps colour only for views whose subject really *is* the channel: raw `.Plateread` tables, the
reference-calibration panel, the crosstalk chart, per-channel curve rows.

The table is also the **list the plate editor offers when adding a dye** (`KNOWN_FLUORS`), which is
why its keys are written in each dye's own spelling rather than in lookup form — a picker that
offered "cal gold 540" would put that spelling into the user's file. Lookup stays case- and
spacing-insensitive, so a plate that spells a dye otherwise still finds its colour.

The table is the channel palette redistributed dye by dye — each dye takes the hue its channel
already used — so nothing changed colour on screen; what changed is what the colour *depends on*.
Colouring a dye by its channel made the UI's colours contingent on a `.Dcal` being loaded and
covering that dye, so a hand-authored plate or one opened with no run rendered every dye a
featureless grey. A dye emits what it emits; the table is seeded from every dye the committed
samples name (14 across the `.zpcr`/`.pcrd` `.Dcal` sets, all agreeing dye-for-dye on channel,
plus the Biomeme sample's three). Dyes sharing a channel share a hue — honest, since they sit on
one channel *because* they emit in one band, and a run can't use two of them and still unmix.

**Unknown is not a warning.** The dye set is open: an unrecognized name simply gets
`NEUTRAL_COLOR`, and that is a plain "no colour for this one", not a problem to report. Likewise
a fluor's channel is still optional (`PlateFluor.channel?`) — a `.plt.csv` states none, so a dye
no `.Dcal` covers, or any plate CSV opened standalone, has none — but it now costs only the
`Ch<n>` label, which `components/plate/FluorChannelChip.tsx` omits rather than marking. The
dashed outline, `Ch?` marker and explanatory `title` are gone with the reason for them. Nothing
is ever guessed. The rest of the pipeline still treats `undefined` as "not in any channel" rather
than channel 0: `fluorCurves.ts` propagates it, and `chart.ts`'s dark-overlay `presentChannels`
set filters it out. That costs grouping only — the color-separation solve keys off `.Dcal`
response curves, not channel numbers.

## Styling & responsiveness

- `theme.css` holds the dark-only design tokens (surfaces, ink, neon accents, channel
  palette, fonts). `app.css` holds layout + component styles.
- Layout is **container-query driven** (`app__main` is the query container): the Curves rail
  sits beside the chart on wide screens and stacks above it under ~720px (a tighter step at
  ~560px trims padding and drops Overview's info table and definition lists to one column); the
  Raw list collapses similarly. Fluid type/padding via `clamp()`/`cqi`; chart cells use
  `min-inline-size: 0` and overflow guards so the page never scrolls horizontally.
- The **app shell** is the one place that can't rely on container queries, because it *is* what
  sizes the container: `.app__header` is a non-wrapping flex row, so the view-tab strip's
  intrinsic width used to stretch the whole `.app` grid past a phone viewport and push every
  view into horizontal overflow. The tabs therefore live in their own `.app__views` scroller
  (`min-width: 0; overflow-x: auto`) and the logo/drop button are `flex: 0 0 auto`.
- **The view bar is the same eight file views for every file.** A tab a file has no answer for is
  *disabled*, never dropped (`ViewBar`'s `enabled` prop, fed by `App.tsx`'s
  `enabledViewsFor`). A strip that changed shape per file moved every other tab out from under
  the pointer on each selection change, and read as a per-file menu rather than as the app's
  fixed set of lenses; greying a tab out says "not for this file", while removing it says
  nothing. A run still behind the password prompt greys out *every* file tab for the same reason:
  the prompt gates the content area, not the app's chrome. For a run, which tabs those are comes
  from what the archive **holds** rather than from its extension (`App.tsx`'s `runViews`): Curves
  needs a plate read, Reference needs readings *and* a `FactoryRefRowCal`, Calibration needs
  readings *and* a `.Dcal` set. A finished run has all of it and nothing changes; a run in progress
  — and especially a pending experiment, which may hold nothing but a protocol — does not,
  and each tab switches itself back on as the data arrives, since every snapshot re-parses. Protocol
  is the exception that is always on for a pending experiment: there it is the editor the protocol
  comes from in the first place (see "The Instrument view"). The
  alternative was three views drawing empty frames, which reads as broken rather than as absent.
  It also makes the header's width independent of the active file, which is why
  `useHeaderFit`'s only dep is the selected view. Which view the *content* area falls back to
  when the current one is disabled is still `App.tsx`'s job (the first enabled tab).
- The header **goes iconographic when it stops fitting** rather than scrolling, in four steps
  driven by a `data-fit` attribute that `state/useHeaderFit.ts` sets by measurement: 0 is the
  full `zpcr//web` + nine labelled tabs (each with its line icon from `components/ViewIcons.tsx`)
  + "load file"; 1 drops the wordmark's `//web` tail and the load button's word; 2 drops every
  tab label *but the selected one's*, so the current view still reads as a word for as long as
  there's room for it; 3 is all icons. Nothing is lost at any level — each control keeps its word
  in `title` + `aria-label` (hence `Logo`'s split spans and `ViewBar`'s explicit labels), so
  hover, screen readers and `tools/uitest.mjs`'s name-based tab lookups all still work. Only
  `.app__header` carries `data-fit`, so the welcome screen's `.app__brand` — no tabs, plenty of
  room — keeps the full mark unconditionally.
- **Why measurement and not a media query.** The header's natural width depends on what it
  currently holds: level 2's width depends on which label happens to be selected ("Calibration"
  is nearly three times "Raw files"). Any single breakpoint therefore either collapses
  a header that still fits or lets one truncate — the old `@media (max-width: 599px)` rule let
  the tab strip scroll away about a third of its width before it fired. `useHeaderFit` instead
  probes a **hidden clone** of the header pinned to the real one's width, writing each candidate
  `data-fit` onto the clone and reading the resulting flex layout back, and takes the first level
  whose content fits the real header's content box (re-run on a `ResizeObserver`, on a view
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
- **`cursor: pointer` means "this does something when you click it"** — a button, a link, a
  `<summary>`, an element with an `onClick`. Never put it on decoration, on a container merely
  because some of its children are clickable, or on a class that a non-interactive element also
  wears: a pointer over inert content promises a control that isn't there. `.instrument__panelhead`
  is the shape of the mistake — it styles both the collapsible panels' `<summary>` heads and "Run
  to start"'s plain `<div>`, so the pointer rule is scoped `summary.instrument__panelhead`. Use
  `cursor: help` for a hover explanation, `not-allowed` for a disabled control, and leave
  everything else at the default.
- Touch targets are enlarged under `@media (pointer: coarse)` only, and safe-area insets
  (`env(safe-area-inset-*)`, with `viewport-fit=cover` in `index.html`) pad the header and file
  bar. Both are no-ops for a desktop mouse on a notchless screen.
- **Desktop is the regression baseline.** Every mobile rule lives inside a narrow-only
  container/media query, so `node tools/uishot.mjs --views overview,curves,plates,raw --width
  1400 --height 900` renders byte-identically before and after — worth diffing the PNG hash when
  touching anything here.
- `prefers-reduced-motion` is respected (the drawer animates with a `transition`, which
  `theme.css`'s global reduced-motion rule already disables).

## The Instrument view

A view of the machine rather than of a file: it connects to a CFX96 over WebUSB and shows the
instrument — identity, live status, its filesystem, and the decoded protocol traffic — in the
service of starting an experiment and following the run that comes out of it. Everything it
knows about the protocol comes from `@zpcrweb/core`'s `CfxDevice` (see the root
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#talking-to-an-instrument-not-a-file-srcusb) and
[`usb.md`](../../docs/usb.md)), per the standing rule that logic lives in the library — the app side is
`state/useCfxDevice.ts`, which owns only what a browser session adds: obtaining the instrument through
`navigator.usb`, a poll timer, the traffic recording and its bounded display window, and the React
state the components render.

**A dropped connection is retried, because the run isn't dropped with it.** The library reports the
pipe dying and stops there; deciding what to do about it is this hook's, since re-obtaining a
device handle is the browser-specific part. A close carrying an error, with `connect` not having
been undone by `disconnect`, puts the session in `reconnecting` and retries `getDevices()` on a
backoff — for as long as it takes, since the instrument goes on cycling either way and a run is
hours long, and since an attempt while the cable is out costs one resolved promise returning
nothing. A replug fires `navigator.usb`'s `connect` event, which short-circuits the wait. The
picker (`requestDevice()`) is never used here: it needs a user gesture, and the only reason it
isn't needed is that WebUSB permission persists across the outage. The rail shows the state with a
pulsing amber dot and says what is and isn't affected, and its button still ends the session —
which is what stops a retry loop the user no longer wants.

**Its tab stands apart, and is always enabled** — a group of its own at the end of the strip, in
the magenta the view itself uses, never greyed out (see "Instrument is not a file view" above for
the argument; `enabledViewsFor` no longer answers for it). It renders with nothing selected, and
with nothing loaded at all. Starting a run does still need a protocol, and a protocol still comes
from a file, since the instrument has no library of its own to pick from (`usb.md` §5.1) — but
*needing a file as input* is not *being a lens on the selected file*.

**Which experiment it would start is the selected one, and that is the whole rule** (`App`'s
`instrumentExperiment`): the selected file when it is a decoded run, otherwise none. There is no
picker here to say it a second time — the file bar is the app's one file picker, and a control
beside it could only agree with the chips or contradict them — and no fallback to a *different*
run when the selection isn't one, which would be the single answer guaranteed to be wrong.

Showing nothing costs nothing, which is what lets the rule stay this plain: connecting, status, the
instrument's filesystem, the traffic console and every action but Start live in the rail and need no
file at all. Plug in a cycler with an empty browser and you can still open the lid; Start disables
itself with "Select or create an experiment first."

Earlier versions resolved this through as many as four rungs — a live run, a pick made in the view,
the selection, the last thing resolved — each defensible alone and adding up to a view whose subject
you could not name by looking at the file bar. What made them seem necessary was the tab pretending
to be a lens; once it stopped, the plain answer was enough. Nothing needs pinning at the click on
Start either: the run watcher activates the file it started (`AddFilesOptions.activate`), so the
selection *is* that run.

One consequence of the tab being reachable with nothing loaded: the welcome screen's "Connect an
instrument over USB" button just **goes there**, creating nothing. It used to have to invent an
experiment first, because the tab was a lens and so unreachable without a file — connecting is its
own act, and the experiment to run is made from inside the view ("New experiment") if and when
there is one to make.

**One experiment, one file.** This is the model the whole view rests on, and it replaced a
considerably larger one. A run used to be assembled here from a **three-slot staging selection** — a
run plus a protocol override plus a plate override, chosen by clicking chips that meant something
different on this tab than on any other, with magenta "auxiliary" selections alongside the cyan
primary one (`state/useRunStaging.ts` and `lib/protocolSource.ts`, both removed). It could pair one
run's protocol with another's plate, and the run it would start existed *nowhere* until Start was
clicked — at which point a file was invented from the staged parts and a name typed into this panel.

What replaced it is an ordinary file. An experiment is created deliberately ("New experiment" on the
About page, "Clone experiment" on a run's Overview), named on its Overview, filled in there and on
its Protocol tab, and started here — in place, without creating anything. Everything the old model
could express, it can still express, in a way that survives a reload and can be downloaded: pairing
a protocol with a different plate is *attaching* that plate to the experiment, not overriding half of
some other run's identity. The three-slot selection, the override badges, the release/promote rules
for tapping a chip, the typed name and its lock/phase machinery (`state/useRunNaming.ts`) are all
gone with it.

**What this view can do is a property of the experiment it is pointed at**, and there are exactly
four cases (`InstrumentView`'s `InstrumentExperiment`, built by `App` from the resolved target,
`lib/experiment.ts`'s `isPendingExperiment` and `runProgressFromNames`):

| The experiment | This view |
| ----------- | --------- |
| a **pending** experiment — no results, never started | starts it; Start arms once it has a name and a protocol |
| a run **in progress** — `begun`, not `ended` | won't start it; says it is running and its results are still arriving, and offers a clone for the *next* run |
| a run that is **over** | won't start it, and offers the clone that is the way to run it again |
| nothing to point at — nothing loaded, or a selection that is a standalone plate or protocol or a run that hasn't decoded | says so, and offers the "New experiment" that is where one comes from |

Refusing the two started cases is the point of it rather than a limitation: re-running a file that
already holds results would either overwrite them or contradict them, so the fix is a new experiment,
and the panel offers exactly that. Nothing needs to record "already run" — a plate read or a `begun`
marker in the archive *is* the record (see "A pending experiment" below). The two are kept apart in
what they *say*, though: telling someone watching their run that it "has already been run" is false
while the block is still cycling, and the in-progress wording is derived from the file's own markers,
so it survives a reload and holds for a run this app never started.

**A plate is optional.** `planRun`'s `plate` is optional and its absence is a `warning`, never an
`error` (`usb/runPlan.ts`), so an experiment can be started without one — the curves simply carry no
target or sample names. Both this panel and Overview say so where it is missing, in the two places it
matters: before the run, as a thing to fix; after it, as why the wells are unlabelled.

The protocol is rendered by the same `ProtocolDecoded` with `annotated={false}` — the
directives and their step numbers, no plain-English column. The gloss belongs to the protocol *as
a document* (the Protocol tab); here the protocol shares half the panel with a plate map, and the question
is what would be sent, not what the language means. A **scan mask** survives that cut, in smaller
type on a line below its `PLATEREAD`: `#h3F` is a packed byte (`usb.md` §3.1), so which channels
are read and how the head sweeps the plate are not in the text at all — and they are what someone
checks before starting a run.

The `CfxDevice` lives in a **ref**, not state: it is a long-lived object with a background read
loop, and a re-render must not be able to look like a new connection — `open()` on an
already-claimed interface fails.

**The connection is held by `App`, not by this view.** It used to live in `InstrumentView`, which
meant leaving the tab released the USB interface — fine while the view was the only thing that
talked to the instrument, and wrong once a started run has to keep being followed while you sit in
Curves watching its amplification curves arrive. The connection is a property of the session.

### What the instrument last ran

**The instrument's `.alf` report is read on connect, unasked** — `useCfxDevice.refreshLastReport`,
once per connection, into `lastReport`; `InstrumentLastRun` is the panel that shows it, between the
experiment and the file browser.

`\Storage Card\PCRunReport` is the only place that answers "what did this machine last do?" for
*every* kind of run. `CurrentRun` exists only for a run with a `PLATEREAD` and otherwise still holds
whatever the last such run left behind (`usb.md` §7.10), so a thermal-only run — or one somebody
started at the touchscreen with no computer attached — is invisible in it. A report is written for
all of them (§5.2). The read costs one listing and one `GETFILE` of 386 bytes to ~14 KB, which is
why it happens on sight rather than behind a button.

It is also the only chance to keep it. The report **survives until a new run's pre-flight deletes
it** (`CfxDevice.clearRunReports`, §7.1 — CFX Manager's own behaviour, deleting a six-day-old report
in the reference capture, which this app copies deliberately). So the panel offers "Open report",
which files it through `App`'s `openReport` — the same callback the run watcher uses for a
thermal-only run's report, so a report collected by hand and one collected automatically are the
same kind of file. Starting a run clears `lastReport` in the same breath as the deletion, and the
watcher re-reads it when a run finishes, so the panel describes the run that just happened rather
than the one before it. `fetchRunReport` — the watcher's collection path for a thermal-only run — is
that same read rather than a second one: there is one report directory, so whatever comes out of it
is by definition the current last report.

The six summary lines are `lib/alfSummary.ts`, shared with a standalone report's Overview
(`StandaloneReportOverview`) so the same file reads the same way whether it is in the file bar or
still on the instrument. The panel adds one row those don't need — **who started it**, which is the
report's empty `user` field for a touchscreen run (`alf.md` §4) and the only way to tell a run this
browser drove from one someone walked up and started.

What this is *not*: a collection path for a run being watched. The report a watched run produces
arrives on its own (see "Following a run"), and for a qPCR run it also travels inside the `.zpcr`,
since the instrument copies it into `CurrentRun` too.

### Starting a run

`planRun()` (core, `usb/runPlan.ts`) reduces the staged pair to exactly what would be sent — the
command lines, the `RemoteRun` line, the files to deposit — and `CfxDevice.startRun()` sends it
(`usb.md` §7, §10). `InstrumentView` computes the plan on every render and hands the *same object*
to both the panel and the rail, so the warnings shown between the two halves and the state of the
Start button can never disagree.

**The name is not typed here.** It is a property of the experiment's file, given on its Overview
before the instrument is involved at all (see "A pending experiment" below), and this panel shows it
read-only. That is the largest single simplification of this refactor: the name used to be typed on
this panel and held in `state/useRunNaming.ts` (removed) with a three-phase state machine
(`idle`/`starting`/`running`) locking the field while the run was on the block and clearing it after,
plus a pinned copy so the watcher could keep naming snapshots once the field had emptied. All of that
existed because the name lived nowhere but this input until the run started. A file that already
exists can simply be asked what it is called.

The **experiment name** is still the run's identity, and still travels the same two channels. It
reaches `planRun()` as the run name, i.e. `RemoteRun`'s fourth operand (`usb.md` §7.3) — what
`STATUS?` echoes and what the `.alf` report is filed under — *and* it is deposited into the run folder
as a `zpcrweb.json` carrying nothing but `experimentName` (§7.4, `zpcrweb-json.md` §7). That second
channel is the load-bearing one: the operand reaches the instrument's composed filenames and nothing
else, and no field of `RunInfo.xml` records what a run is called, so without the deposit the name
would be gone by the time the run's archive came back.

It is **required, and never inferred**. An experiment still carrying the bare-date file name it was
created under has no name of its own (`ExperimentIdentity.named`), and `InstrumentView` passes the
blank that makes `planRun` raise its `no-experiment-name` error — so Start refuses it through the same
check mechanism a scan-mask mismatch uses, and the rail's reason points at the Overview tab where the
field is. The one plausible default, the protocol's name, is the wrong one: a protocol is run many
times, so every run of it would share a name, and the name is what the run's file is called and how it
is told from yesterday's. The instrument cannot supply it either — its echo comes back uppercased and
cut to eight characters.

A run that has already happened is passed the name it actually goes by, derived from its file name if
nothing stored one, rather than that blank: it is not being started, and demanding a name for it would
accuse a finished run of missing something it does not need.

**Starting creates no file.** `App`'s `startExperiment` calls the store's `beginExperiment`, which
writes the `begun` marker into the experiment's *own* archive (core's `markExperimentBegun`) and then
`instrument.startRun(plan)` sends the run — the same order the old seeding used, and for the same
reason: the run is about to exist whether or not every upload lands, so the file has to say so first.

This is where the old flow wrote a whole new `.zpcr` from the staged parts (core's `zpcrSeedArchive`,
removed): a "seed" file, created at the click, existing for the minutes of lid preheat and first hold
before the first plate read so that there was *something* to look at. A pending experiment is already
that something, deliberately made and named minutes or days earlier, so the seed had nothing left to
do. The window it covered is now covered by the file the user is already looking at.

Two things still happen at the click. The file's **date is restamped** to today if it still carries one
in the standard form (`lib/experiment.ts`'s `restampExperimentDate`, applied through the ordinary
`renameFile` so ids and IndexedDB stay consistent), so an experiment cloned last week and run today is
filed under today — and `beginExperiment` returns the possibly-new id and name. And that name is
**pinned** in `App`'s `startedRun` and the new id **adopted** by the watcher (`runWatch.adopt`), which
together are what make the first real snapshot *supersede* this file rather than land beside it: the
watcher names its snapshots from the pin (core's `runFolder.ts` naming precedence) and the store
supersedes by name. The pin survives the selection moving while the run cycles, which is all that is
left of what `useRunNaming` used to guard.

The two **deposited** files keep the names of the things they *are*:The two **deposited** files keep the names of the things they *are*: the protocol's own name, and
(for an overridden plate) the plate file's, else what the plate says about itself via
`identityKey`. Protocols and plates are reused across runs and carry their own identities; an
experiment name belongs to one run, and stamping it on both copies would overwrite that identity
for no gain.

The order is `usb.md` §7's, not the one §5's upload machinery suggests: the protocol is typed in as
ASCII directives, `RemoteRun` starts it, and the files are deposited **afterwards**, into a run
already cycling. Two things follow that would otherwise read as bugs. There is **no confirmation
step** — §7.5 measured `PROCEED` as "skip the current step", so sending it after `RemoteRun` would
silently skip the run's first step — which is why the button's own footnote says the run starts on
the click and to close the lid first. And a **deposit failure is reported, not thrown**: by then
the run is going, and the files are provenance (they are what let the archive open later with its
plate map intact), so the rail says the archive may be incomplete rather than pretending the run
failed.

**The click is answered locally, before the wire.** `useCfxDevice.startRun()` sets a `runPending`
flag synchronously, and only then begins the §7 sequence. Authoring the protocol is dozens of
round trips, and the status poll stands back for the whole of it (it skips while `busy`), so
without this the seconds between the click and the first `STATUS?` show an instrument that still
says *Idle* next to an armed Start button — an invitation to click twice on the one control in the
app that heats a block. Nothing is asked of the instrument to know a start was requested: the rail
reads **Run pending** in both its *Status* and *Current run* sections, the button dims immediately
(the 150 ms anti-flash delay on the dimmed look applies to short commands, not to this) and relabels
itself, and the panel badges *pending*.

There is nothing to look at between the click and the first plate read — minutes of lid preheat and
first hold — except the experiment's own file, which is exactly what it is for: it is already a chip
in the bar with its protocol and plate readable, and each cycle's pull grows that same file. Nothing
downstream distinguishes a just-begun experiment from a run in progress; the difference is only which
entries the archive happens to have yet.

The pending flag lasts exactly until the instrument's own answer replaces it — the `STATUS?` read at the end of
`startRun()`, taken *whatever it says*. A successful start reports `running` and every live readout
moves on to the real running state on its own, in the same render; a start that failed reports idle
and releases the button, so a pending state can never outlive the attempt that set it. Cleared on
teardown too, so a disconnect mid-start doesn't strand it.

**What blocks a start.** `checkRunPlan()` compares the plate against every `PLATEREAD` scan mask in
the protocol. A mask omitting a channel the plate carries dyes on is an **error**, not a warning:
that run completes, reports nothing wrong, and yields an archive in which those dyes are flat zero
— afterwards indistinguishable from a failed reaction. The reverse (reading channels the plate
doesn't use) costs only time and is a warning. The messages render between the protocol and the
plate rather than in the rail, because the fix is to change one of those two files.

A protocol with **no `PLATEREAD` at all** is a warning too, not an error: an incubation or a
reverse-transcription hold uses the block as a heated surface on purpose, and the instrument runs
it happily. Such a run produces no `.Plateread` files, so its `.zpcr` has no curves — `runViews`
(`App.tsx`) then leaves Curves, Reference and Calibration disabled, and the rest of the app treats
it as the finished run it is. A missing plate is only worth mentioning when the protocol would
actually read one, so that warning is suppressed for these.

### Following a run

`state/useRunWatch.ts`, and it follows `usb.md` §7.5 rather than polling the filesystem hopefully:
`STATUS?` is already being polled for the rail, its current-step field carries the running step's
command text verbatim, and a completed `.Plateread` appears when a `PLATEREAD` step *ends* — so the
watcher lists the run folder on that transition. Listing is **edge-triggered, never on a timer**: a
periodic listing here used to flicker the Instrument rail's Start-run button, since a
`GETFILESLEN`+`LISTALLFILES` round trip holds the `busy` flag the button disables on. The one case
the transition rule structurally can't catch — the **final** read, whose transition is `PLATEREAD`
→ `IDLE` — is caught by the §7.6 acknowledgement instead: when the run finishes (`STATUS?` reports
`IDLE` with the run's name still attached) it goes out automatically, because the last read and
`ended` only appear after it, and that is the one instrument-actuating command the app sends on its
own, with `useCfxDevice` re-checking the status immediately before sending it since the same
`CANCEL` aborts a run still cycling. It goes out only for a run **this page session watched
cycling**, remembered by name in `watchedRuns` — an instrument left holding a run that finished
yesterday presents an identical status, and acknowledging that one would send an unasked-for
command and drag a 400 KB archive nobody requested into the file bar. That memory deliberately
**survives a disconnect**: a run that finishes while the cable is out comes back as exactly this
status, and treating the reconnected session as a stranger left the run held forever — no final
plate read, no `ended`, no `.alf`, and a file permanently reading as in progress with nothing in
the app able to release it. What a disconnect does clear is the *listing* state (the last listing,
the last step, and which file the folder's run belongs to), so the next connection re-establishes a
baseline rather than diffing against a folder it stopped watching — and asks again which file this
run is, since a different run may have been started and finished while the cable was out. A page reload is still a stranger, by design: memory is all there is
to go on and a reload has none. One further listing establishes a baseline when the connection
is made — see "The first listing is never pulled" below for why that one is pulled immediately
rather than diffed against, on the one path where it isn't a stale finished run. Nothing lists on a
run merely *starting*: `STATUS?`'s `running` flag already says that live, and the marker files
(`begun` etc.) are a property of the archive this watcher assembles rather than of the rail's live
state, so they can wait for whichever real edge lists next. That flag's false→true edge is watched
anyway, though, purely to tell a run *starting* apart from one *found* already going on connect —
the two listings are identical, so only the live transition tells them apart — which is what the
`activate` flag below rides on.

#### A run that writes no run folder

**The end-of-run pass is the one place a stale folder gets mistaken for a run**, because it is
forced: it pulls whatever `CurrentRun` holds without waiting for the listing to change. That is
fine for a qPCR run, whose finish always adds the last read, `ended` and the report in the same
moment — and wrong for a **thermal-only** one, which leaves the folder completely untouched
(`usb.md` §7.10, measured). The previous run's complete folder is then sitting exactly where the
pull would find it, which is how one committed sample came to be a two-minute incubation carrying
another run's 45 plate reads and its `.alf`.

So an **unchanged listing at the finish is treated as proof the folder is not this run's**
(`check`'s `finalAssembly` branch, reported through `staleAtFinish`), and the watcher collects the
run's own `.alf` from `\Storage Card\PCRunReport` instead — `collectReport`, which adds it as an
ordinary file through the same `addFiles` path a drop takes, and selects it, because it is the only
record that the run happened at all. `CfxDevice.clearRunReports` empties that directory at the
start of every run (§7.1), so the report waiting there afterwards is unambiguously this run's.

Deriving it from the listing rather than from the protocol is what makes it hold for a thermal-only
run started at the instrument's **own touchscreen**, which this app never planned. When the app
*did* plan it, `startExperiment` says so in advance via `expectReportOnly` — that only skips the
listing that would otherwise discover the same thing, and stops the run's last moments being spent
fetching a folder already known not to be ours.

On each changed listing the watcher reads back the run's file, fetches what the folder holds that
the file lacks, checks and names the result with `zpcrFromRunFiles`, and hands what it *fetched* to
`store.addRunArchive` as entries to merge into that file — the same validate → IndexedDB path a
drop takes, minus the ZIP: the store holds a `.zpcr` as its entries (see "A `.zpcr` is stored as
its entries, never as a ZIP"), so a cycle's cost is the one plate read that arrived rather than a
re-zip of the whole run. The passes are all one file under one name, so they are one record,
rewritten in place. Both halves of that — the file being the only copy of the run, and only the
instrument's own writes going back to it — are in "A run's file grows by what the instrument
wrote", along with what they fixed.

**What the snapshot is called** is decided by `core`'s `runFolder.ts`, in three rungs: the file
name typed in the Instrument view, then `<YYYYMMDD>-<experiment name>` derived from the folder's
own deposited `zpcrweb.json`, then `RunInfo.xml`'s `DataFile` as before. The first two apply only
to a folder carrying that deposit — i.e. a run *this app started* — so a run begun at the
touchscreen keeps the name the instrument gave it no matter what is typed here, and the first rung
additionally requires the deposited name to still match the pinned one, so a later experiment's name
cannot rename the run still finishing. The second rung is what a reloaded browser falls
back to, and it dates the name from the run's own `RunStartTime` rather than from the moment of
the pull.

Three economies make the once-a-cycle refresh affordable:

- **Only what the run's file lacks is fetched.** 28 of a `CurrentRun`'s ~40 files are the `.Dcal`
  set and never change during a run; re-pulling them every cycle would push megabytes over a
  64-byte-packet bulk endpoint for nothing. The archive the app is holding for the run says what
  has already been downloaded (core's `runFilesToFetch`), and an entry it has is not fetched again
  — what the instrument has written is final, and a new plate read arrives under a new name — so a
  cycle's update is exactly one 22 KB plate read. The three files that *are* rewritten as the run
  goes (`REFETCH_AT_END`: `runlog.xml`, which reaches 31 KB, `lastplatereadstatus`, plus
  `RunInfo.xml` for the reason given there) are re-read once, on the end-of-run pass, which is the
  only one that has to be complete; mid-run the file carries the copy first seen. A plate is the
  one exception in the other direction: it is never fetched into a run that already has one, since
  the folder's copy is the one this app deposited and re-reading it would put back a plate the user
  had replaced. (A name *disappearing* means a different run, and sends the watcher back to asking
  which file the folder's run belongs to.)
- **The first listing is never pulled — unless it's already running.** `CurrentRun` usually still
  holds the previous run when you connect — finished, `ended` and all — so the first sighting
  ordinarily only records a baseline to diff against, rather than surprising the user with a
  400 KB transfer and an unrequested file. But a browser reload mid-run, or a connect that happens
  after the run had already started, presents a first listing that is itself `begun` and not yet
  `ended`; `runProgressFromNames` tells the two cases apart, and an in-progress first sighting is
  pulled right away instead of waiting for the next transition or the 30 s backstop.

  **Not pulling it is not the same as not mentioning it.** That rule used to make connecting after
  a run had finished a dead end: the rail reported `finished, 45 plate reads` and the only way to
  actually get the run was **Open run**, inside a collapsed panel titled as a storage browser. So
  the first listing now also asks whether the run in the folder is one this browser *has* — the
  same ~8 KB identity read a pass does (`runIdentityFileNames`, then `isSameRun` against the file's
  own `RunInfo.xml`, so the answer is exact rather than a guess from the name) — and when it isn't,
  `RunWatchState.available` names it and the rail offers **Download run** beside its plate-read
  count. Offered, not taken: it is a ~400 KB transfer over a slow channel that lands a file in the
  bar. Clicking it runs an ordinary forced pass, which downloads the whole run because the app is
  holding none of it. The offer is a property of the connection — it clears when the run lands, and
  on disconnect — so a run deleted later reappears as an offer on the next connect rather than
  being watched for continuously.
- **The refresh doesn't steal the selection — except for the run's first file.** `addRunArchive`
  takes an `activate` option: ordinarily the refreshed file becomes active only if the user was already on the one it
  supersedes, which is what makes the Curves view grow a cycle at a time without dragging anyone
  back from whatever else they had open. But the pull that follows a run *starting* during this
  session — the `running` false→true edge above — always activates: `useRunWatch` passes `onRun` an
  `activate` flag, set on that edge and consumed by the next successful pull (typically the first
  plate read's), and `App.tsx` ORs it into the store's own `activate` decision. Someone watching a
  run start wants it on screen, and there is no prior view of *that* run to preserve. (A run
  *found* already going on connect, which looks identical in the listing, does not set the flag —
  only the live transition does.) A run pulled by clicking **Download run** sets it too, for the
  same reason: it is a file the user just asked to exist.

**The whole bar locks to the running file, but only inside the Instrument view.** `App.tsx`'s
`runActive` (`instrument.connection === "connected" && !!instrument.status?.running`) scopes both
halves of this:

- A chip click in the Instrument view that would switch away from the run in progress is a no-op
  while `runActive`: `selectFile` refuses it, and `FileBar`/`FileChip` grey the cursor on every chip
  but the active one (`is-locked`, `activeLocked` prop). This used to also cover toggling a
  protocol/plate override, locked together with it on purpose —
  an override staged over the run in progress isn't "the next run" the way it is once this one
  finishes, it's a claim about the plate or protocol *this* run is using, so leaving it toggleable
  would let the panel show something other than what the instrument is actually running, exactly
  the confusion the run-side lock exists to prevent. Everywhere else — Overview, Curves, any other
  tab — switching files is never blocked: reading Curves while a run cycles is the point of the
  connection staying open across tabs, and pinning the selection there would defeat it.
- Since the selection can roam freely elsewhere, an effect in `App` snaps it back on *arrival*:
  switching to the Instrument view while `runActive` sets `activeName` to `runWatch.fileName` (the
  watcher's own record of what it last put in the store), not `store.activeName` — the two can have
  drifted, since a snapshot pulled while the user was elsewhere doesn't activate itself
  (`AddFilesOptions.activate`). The effect is keyed on `store.view` alone so it fires once on
  arrival rather than on every later snapshot of the same run.

**"In progress" is stored nowhere.** The `begun`-without-`ended` markers travel *inside* the
assembled archive, so `runProgressFromNames` (core, `runFolder.ts`) reads the answer out of the
file itself. `ZpcrStore.inProgressIds` derives it per render; the file chip glows and the Overview
banner appears from that alone. Which is why both are still correct after a page reload, on a copy
opened on a different machine, or with the instrument unplugged — and why nothing has to be
notified when a run ends: the next snapshot simply contains `ended`.

**"Incomplete" is derived the same way, from the read count.** A run that was *cancelled* looks
exactly like one that finished — same `ended` marker, same clean `.alf` — so `ZpcrStore`
`incompleteIds` asks core's `runCompleteness` whether the archive holds fewer plate reads than its
protocol implies (see the root `ARCHITECTURE.md`). The file chip then shows a red **Incomplete**
*in place of* the run's date — the date is the least load-bearing thing on a chip and this is the
most — and the Overview grows a banner stating the arithmetic it is accusing on, since the app
cannot tell a cancel from an instrument-initiated stop. The two states are mutually exclusive: a
run still in progress is unfinished, not incomplete, and the in-progress banner wins.

**"Pending" is the third of the same family, and had to be carved out of "incomplete".** An
experiment that has never been run holds a protocol calling for reads and no reads — the exact
arithmetic above — so it was flagged as a cancelled run. `runCompleteness` therefore refuses to
accuse an archive that has not started (marker files present, no `begun`); a format that keeps no
markers at all, a `.pcrd` or a Biomeme export, is finished by construction and still judged on the
count, which is what keeps a run cancelled in CFX Manager recognisable. `ZpcrStore.pendingIds`
(over `lib/experiment.ts`'s `isPendingExperiment`) then names the state positively, and the chip
says **Pending** in the instrument's magenta where an incomplete run says **Incomplete** in red:
both take the date's slot, because which of the three states a file is in is the thing to notice
about it, and the distinction that matters is that one was started and stopped short while the
other has not been started. The three sets cannot overlap.

Four components, under `components/instrument/`:

- **`InstrumentRail`** — the left rail, reusing the Curves view's `.rail__*` vocabulary so the two
  read as the same kind of surface. Connection, the identification block, live status, and the
  action buttons — **Start experiment** among them, at their head. It sits with the lid and indicator
  commands rather than beside the experiment panel because that is what it is: the control that
  actuates the instrument. It is disabled until the experiment is startable at all (named, with a
  protocol, and not already run — `unstartable`), the instrument is
  connected and idle, and every check passes, and it names the **first** missing piece rather than
  a generic refusal, so the tooltip is always the next thing to do — including the pending window
  after a click (above), where the next thing to do is wait. A *Current run* section carries
  what the watcher is doing and a `follow` switch to stop it. Status fields the protocol doesn't
  name are either omitted or footnoted rather than labelled with a guess (the sample temperature is
  the live example). While a run is going, elapsed and estimated-remaining (`usb.md` §3.2 fields 8
  and 10) lead the section as a pair of larger timers — remaining is labelled and tooltipped as an
  estimate rather than corrected for what it doesn't count (plate reads, lid preheat), per that
  section's own caveats — with `LiveThermalChart` right below them, then the step/ramp/hold clocks,
  the decoded status-register flags (e.g. "Preheating lid"), and `RTSTATUS?`'s shuttle/ambient
  temperatures filling out the rest of the section as ordinary stat rows.

  **`LiveThermalChart`** plots block temperature against elapsed time for the run in progress —
  the live counterpart to `ThermalProfileChart` below, drawn from the poll loop instead of a
  finished run's `.alf` report. `useLiveThermalHistory` is the one place that turns the poll loop's
  overwrite-each-tick `CfxStatus` into a series: it appends a sample whenever `status.running` and
  starts a fresh one when `runName` changes or `elapsedS` goes backwards, either of which means a
  new run has begun. It is called **from `useCfxDevice`**, and the rail only renders what the
  handle hands it (`instrument.liveThermal`). Buffering it in the rail instead meant the history
  belonged to a mounted component: opening Curves, or picking another file, unmounted the view and
  the chart came back empty on a run that was still going — a history is worth having only if it
  spans the whole run, so it lives with the connection, which `App` mounts once for the session.

  **The x-axis spans the whole expected run, not the part that has happened.** The hook latches an
  `estimatedTotalS` alongside the samples — `elapsedS + remainingS` from the first poll of the run
  that reported a remaining time — and the chart's x scale is pinned to `[0, that]`. So the trace
  advances across a still frame, and where it has got to reads as progress; letting uPlot fit the
  data instead redrew a full-width line every poll, which showed nothing about how far along the
  run was. The estimate is latched rather than recomputed because it is the drifting one described
  above (it doesn't count plate reads or lid preheat), so `elapsed + remaining` creeps upward and a
  per-poll reading would give back the stretching axis in slow motion. Two escapes: the data's own
  max wins if the run outlives its estimate, since a trace leaving the plot would be worse than a
  late-growing axis, and a 10-minute placeholder span covers the polls before any remaining time is
  reported. There is no ramp/hold/read decomposition to draw, since `STATUS?` reports a
  temperature and an elapsed second, not a step or a phase — `lib/uplot/liveThermalChart.ts` is a
  one-line chart sharing only axis styling and the time-tick spacing (`timeSplits`, exported from
  `thermalChart.ts`) with the after-the-run version.

  **Stop and Pause are not action-grid buttons**, and they appear only while there is a run to act
  on. Both are stateful operations rather than one word on the wire, which is why core keeps them
  out of `CFX_COMMANDS` and gives each a named `CfxDevice` method (see `usb/commands.ts`). Stop
  drives `CfxDevice.cancelRun`, i.e. the whole of `usb.md` §7.8 — it lets a plate read in flight
  finish so the cycle isn't thrown away, resumes a paused run first, and above all *keeps
  watching*: a `CANCEL` sent in the measured ~6 s between `RemoteRun` and the block actually
  starting is answered `0000` and ignored, so a fire-and-forget button reports success over a run
  that goes on cycling. `useCfxDevice` supplies the two things only the browser session knows —
  `runPending`, which is how the cancel recognises that window at all, and an `onStatus` callback,
  since `withBusy` stands the status poll down for the duration of an operation the user is
  especially keen to watch. The stop deliberately stops at §7.6's finished state and leaves the
  acknowledgement to `useRunWatch`, so the partial run is still collected and filed by the one
  component that owns that. Pause toggles to **Resume** off the status register's pause bit
  (`isPaused`, which per §7.9 accepts either indicator); the rail also explains that a run armed
  to start from the touchscreen reports itself paused in the same way, because that state is
  otherwise indistinguishable and looks like a fault.
- **`InstrumentRun`** — the experiment that would be started, as its two halves side by side: the
  thermal protocol and the plate map, each headed by what it is. Both come from the one active file,
  so there is no second source to name and no "override" badge — the halves used to be resolved from
  a three-slot selection where either could supersede the run's own (see the model note above), which
  is what those badges existed for. It renders a file it does not own, and it has no
  start button — that belongs with the commands that actuate the instrument, in the rail. What it
  does carry is the plan's **checks** (above), between the two halves they are about, and — for a run
  that already has results — the **Clone experiment** button that is the way to run it again.

  What is shown for the protocol is the **ASCII run definition**, not a decoded step table — the
  same `ProtocolDecoded` the Raw and Overview views use, directives as they would go on the wire
  with core's reading of each beside it. That text is the artifact that would
  actually be sent (`prcl.md` §3), so reviewing anything else would be reviewing the wrong object;
  the annotations are what make reviewing it possible without knowing the language, which is also
  why the lid/volume summary line this panel used to carry is gone: `HOTLID 105,30` now says what
  it means on its own line;
  it also makes a `.prcl.txt` and a run's embedded protocol render identically, since by then they
  are the same thing. The Overview tab's protocol section is where such a file comes from.

  A plate **attached** to an experiment resolves its channels through that archive like any other,
  since by then the plate is *in* the file (`Zpcr.plates()`), not paired with it. This is what the
  removed `resolveStagedRun` had to do by hand: a `.plt.csv` names its fluor columns by dye alone — a
  channel is a fact about the optics, not about the plate — so a CSV sitting in the file list beside
  unrelated files parses with every channel unknown, and staging it against a run was the only
  statement that could supply the mapping. Attaching writes it into the archive instead, so the
  question answers itself and there is no pairing to keep track of. Since colour now comes from
  the dye name, what that mapping still buys is the fluor ordering and the `Ch<n>` labels — not,
  as it once did, whether the plate renders in colour at all.

  The plate uses the shared `PlateViewer` in its `compact` variant — no vessel/scan-mode metadata
  and wells shrunk to coloured cells, so a 96-well plate fits the column instead of scrolling out
  of it. A loaded well still carries one dye-coloured dot per fluor it holds
  (`.plate__welldots`, hidden in the full-size grid where the per-fluor target text says the same
  thing), so the cell answers "what is loaded here?" without a hover; everything else is one hover
  away in the well card. The question this preview answers is "is this the right plate?", not
  "what is in well F7?".
- **`InstrumentFiles`** — the instrument's storage, grouped by kind the way the Raw view groups a
  `.zpcr`. A *single* retrieved file is **saved to disk, not loaded into the app**: what lives on
  the instrument are the *parts* of a run — individual `.Plateread`s, the `.Dcal` set, the
  `.pltd`/`.prcl` pair — where every format this app opens is a whole run in one container.

  A whole directory is different, and is what **Open run** does: a `.zpcr` *is* a ZIP of a run
  directory (root `ARCHITECTURE.md`, "A run directory is a `.zpcr`"), so the button pulls every
  file — sequentially, since the command channel carries one request at a time, with the busy
  label counting them off — hands them to the library's `zpcrFromRunFiles`, and drops the
  result into `store.addRunArchive`. From there it is an ordinary loaded file: the same validate →
  IndexedDB path as a drop, under the name the run calls itself, then a switch to Overview so a
  successful open goes somewhere. It is offered for any directory whose listing contains a `RunInfo.xml`
  (what makes a directory a run, and what `parseZpcr` refuses an archive without) — in practice
  `CurrentRun`. `addRunArchive` returns the id it left active precisely so this caller can tell a
  rejected archive from a loaded one and stay put, with the error banner, in the first case. When
  `GETFILESLEN` answers with a status code instead of a length, the panel distinguishes the two
  the instrument actually sends (`usb.md` §5): *empty* — which `\Storage Card` is, holding only
  the two directories below it — reads as an ordinary empty listing, while *no such directory* is
  called out as a failure. Either way no names are shown, because the protocol's failure mode is
  to return *another directory's* contents, and showing them under the wrong heading would be
  worse than showing nothing.
- **`InstrumentConsole`** — every decoded message in both directions, at the level of logical
  messages rather than USB packets, which is where the protocol is legible. Channel is on every
  line: a reply arriving on channel 2 rather than 1 is exactly the thing that would otherwise be
  invisible. Polling is hidden by default (it would otherwise be all there is to see).

  **"Hide polling" suppresses at capture, not at render.** The check lives in `useCfxDevice`'s
  `pushLine`, which decides whether a line reaches the `traffic` state at all; the console just
  renders what it is given. Filtering in the component instead meant the 1.5 s poll pushed six
  lines a minute into React state only for the render to discard them — a re-render and a
  follow-scroll per poll, visible as a flash on an idle console. A poll reply carries no copy of
  its request, so each line is classified on arrival (`poll: boolean`) against the outbound
  message before it, which is the one point where the answer is cheap. The recording below takes
  every line either way, so the downloaded log and the copy embedded in a run's `.zpcr` are
  complete regardless of the toggle. Toggling it rebuilds the display list from `rebuildFrom`, a
  capped buffer of console lines kept for exactly this — hidden lines were never in `traffic` to
  un-hide, and decoding the session-long recording to recover the last few hundred of them would
  be work proportional to the whole session for a window of 400. `Clear` empties that buffer,
  which is how the rebuild honours it without tracking an offset.

  **A long reply is cut to one line of bytes.** A `GETFILE` response is a whole file, and putting
  it in a console line verbatim swamped the panel with a single line the size of its scrollback —
  in exactly the case the surrounding lines matter most — besides parking megabytes of unreadable
  hex in React state. Lines are built through core's `usbTrafficPreview` (`usb-traffic.md` §4),
  the same cut the text rendering applies, so the console and a downloaded log agree on where a
  payload stops. Only responses are cut; a request is a short command. The recording is untouched
  by any of it and keeps every byte.

  **Recording is unconditional; "save log" decides only what is *kept*.** Every message and
  transfer error goes into core's `UsbTrafficRecorder` (`usb-traffic.md`) for the whole session,
  regardless of the display toggles, so the download button always has the complete conversation
  behind it and a problem noticed after the fact is still recoverable. That is affordable because
  the recorder stores *records*, not the text they render to — payload bytes plus the three facts
  about a message that aren't in them — at ~16 bytes per message against an ~85-byte line. The
  console's `save log` switch (off by default) decides one thing: whether the finished run's
  `.zpcr` carries that log, which is the copy that outlives the session. `useCfxDevice`'s
  `trafficLogForRun()` is where both conditions live — the switch, and "the recording isn't
  empty" — so `useRunWatch` just asks for bytes or nothing. It is read at the moment of
  attachment, at the end of the run, so switching it on part-way through still saves the *whole*
  run, and switching it off leaves the file without the entry rather than with half of one.

  **Read-only, deliberately.** It used to carry a prompt that sent whatever was typed into it;
  that is gone, and the library no longer offers the call it was built on (`usb.md` §10). The
  vocabulary is reverse-engineered rather than specified, a mistyped line is indistinguishable
  from an intended one, and the thing on the other end heats a block and moves a lid — so what the
  app can ask an instrument to *do* is the fixed set of buttons below, each an entry in
  `CFX_COMMANDS`. The debugging value was in watching the traffic, which is unchanged.

The lower two panels are `<details>`, **collapsed by default**: browsing the instrument's storage
and watching the wire are both deliberate acts, and a listed `CurrentRun` is 42 entries long — open
by default they buried the protocol panel, which is the one thing on this view that is about the
run you already have. Their header controls need no toggle guard: a `<button>` or checkbox inside a
`<summary>` is its own activation target, so clicking one never folds the panel. The content column
is a flex column rather than the fixed three-row grid it was, because a closed `<details>` must
shrink to its header — no `grid-template-rows` track can express that; open panels claim the slack
(`.instrument__panel--collapsible[open]`), with the console keeping its ~40% share.

**Action commands carry their provenance.** `CFX_COMMANDS` tags each action with how it is known
to do what it says. All five currently offered — `BLOCKID 1` (flash the indicator), `LID OPEN`,
`LID CLOSE`, `PROCEED` (skip step), `CANCEL` — are `observed` in a capture. Anything tagged
`unverified` is badged `?` with a dashed border and an explanatory note, so a guess is never
presented as a feature; the instrument's result code is reported either way. The badge and its
footnote are driven off the tag rather than hardcoded, so adding an unverified command surfaces
the warning on its own.

**Anything that would disturb a cycling run asks twice.** Stop, Pause, Skip step and Open lid arm
on the first click and act on the second (`InstrumentRail`'s `ActionButton`, styled like the file
table's armed delete so "the next click does it" looks the same wherever the app asks it); moving
the pointer away cancels the question, and a run that ends takes it with it. The cost of a misclick
here is hours of cycling and a plate of reagent, and these buttons sit in the same grid as ones
that cost nothing — Flash indicator, Close lid — which is exactly why the *same* button asks
nothing when the block is idle. Resuming a paused run asks nothing either: it puts the run back the
way it was.

Which commands warrant it is the command table's own answer, not a list kept in the view:
`CfxCommandSpec.disruptsRun` marks `PROCEED` (advances the protocol past the step it is on, §7.5)
and `LID OPEN` (takes the seal off a plate mid-cycle, §3). A new action command has to answer the
question to be added at all. Start is not in this scheme — it is already gated by every check in
`RunPlan` and can't fire while a run is going, and its footnote says plainly that there is no
second confirmation.

That provenance is for whoever maintains the table, though, so **the buttons carry no tooltip**:
each spec's `note` cites `usb.md` sections, which mean nothing to an operator, and the labels say
what the buttons do. `CANCEL`'s reads just **Cancel run** for the same reason — its other job,
acknowledging a run the instrument has finished but is still holding, is done automatically by
`useRunWatch` (`usb.md` §7.6), so it is never something to ask an operator for.

Two of these were briefly shipped *as* guesses, which is why the mechanism exists — and then a
re-read of the `usb-basic` capture against the operator's account of it (flash, then open, then
close) found both: `LID CLOSE` verbatim, and `BLOCKID` as the indicator flash. See `usb.md` §3.

**Testing.** The protocol logic is unit-tested in the library against a mock instrument scripted
with the real instrument's replies (`packages/core/test/usbDevice.test.ts`) — the read pump, command
serialization, the atomic listing pair, and `GETFILE`'s verbatim bytes. The *browser* connect path
can't be automated: WebUSB permission can't be granted to a headless Chrome, so `uishot`/`uitest`
only ever see the disconnected state, and the connected UI is checked by hand or by stubbing
`navigator.usb`. **Open run**'s substance is in the library for the same reason: what a browser
can't reach — that a run directory's files zip into an archive `parseZpcr` accepts, byte for byte
— is covered by `packages/core/test/runFolder.test.ts`, leaving only the button wiring untested.
