# Architecture

Key design points for the zpcrweb project. For the `.Plateread` binary format itself, see
[`plateread.md`](./plateread.md); for the `.pcrd` XML format, see [`pcrd.md`](./pcrd.md).

## Format documentation

Every reverse-engineered Bio-Rad file format (or sub-format, like the shared ICFF container)
gets its own top-level `*.md` doc — [`plateread.md`](./plateread.md), [`dcal.md`](./dcal.md),
[`pltd.md`](./pltd.md), [`pcrd.md`](./pcrd.md), [`icff.md`](./icff.md). The one non-format
exception is [`calibration.md`](./calibration.md), which documents the channel→dye
color-separation algorithm built on top of `.Dcal` rather than a byte layout, and
[`zpcrweb-json.md`](./zpcrweb-json.md), which documents the one entry we *write* into a `.zpcr`
rather than one we decode. Each doc is
self-contained and ends with a pointer to the `packages/core/src` module that implements it, so
the doc is always the entry point for understanding *and* changing a decoder. See
[`README.md`](./README.md) for the full doc ↔ code table.

## Goals

- One parsing library, usable **unchanged** from both a Node app and a browser web app.
- Well-typed output: the consumer never touches raw bytes unless they want to.
- **Three input formats, one output shape.** `.zpcr` (instrument raw output) and `.pcrd` (CFX
  Manager's saved-experiment document) describe overlapping data through very different
  containers — see "Two input formats" below. `parseZpcr`/`parsePcrd` both produce a `Zpcr`,
  so nothing downstream (pivots, the web app's views) needs to know which format it's holding.
  `parseBiomeme` extends the same rule to a genuinely different instrument — see "A third,
  non-CFX input: Biomeme" below.
- Minimal dependencies. One reputable dependency (`fflate`) for ZIP decompression; nothing
  else at runtime.
- An extensive test suite validated against real instrument samples.
- **One analysis per run, computed by the library, and every consumer downstream of it.** A
  baseline, a noise estimate, a threshold and a Cq are not independent numbers a caller can work
  out for itself: they are one derivation, and re-deriving any part of it somewhere else produces a
  *second, equally defensible* answer that then disagrees with the first. So the library owns the
  computation (`analysis.ts`'s `baselineCorrectCurve`/`computeCqTable`), a consumer runs it **once
  per run over the whole plate** (in the web app, `useRunAnalysis`), and everything else — tables,
  hover cards, exports, and the chart's curves, markers and threshold lines alike — reads the
  result. No consumer, the renderer least of all, calls into `baseline.ts`/`threshold.ts` on its
  own. This is not a style preference: the two places that used to run their own copy drifted
  apart, and the drift was visible on screen as a threshold line that missed the Cq marker it was
  supposed to run through (see `apps/web/ARCHITECTURE.md`, "One analysis per run").

## Monorepo

npm workspaces:

- `packages/core` — `@zpcrweb/core`, the library. No framework, no DOM/Node coupling in the
  core path.
- `apps/web` — the web app, which depends on `@zpcrweb/core`. Scaffolded now, built later
  (see [`TODO.md`](./TODO.md)).
- `samples/` — committed real `.zpcr` files and a matching `.pcrd` (~350 KB) for the same run,
  used by tests as ground truth (see `pcrd.test.ts`'s cross-validation against
  `20260720_FirstQualification.zpcr`), plus a standalone `.pltd` saved outside any run
  (`QuickPlate_96 wells_All Channels.pltd`, the DEFLATE64 container variant). Each encrypted
  sample's decrypted payload is committed beside it as `<name>.xml`, so the structural tests
  parse plaintext and only the pipeline tests need the password.

## Why the web app imports core's source

`apps/web` resolves `@zpcrweb/core` to `packages/core/src/index.ts` rather than to the `dist/`
build its `exports` map advertises — via an alias in `vite.config.ts` plus a matching `paths`
entry in `apps/web/tsconfig.json`. **Both must move together**; the alias alone leaves tsc and
the editor reading a stale `dist/index.d.ts` while the browser runs current source, which
surfaces as type errors for code that demonstrably works.

The reason is developer loop speed: with the `dist/` indirection, `npm run dev` does not react
to library edits at all, so live work on a decoder needs a second terminal running
`tsup --watch` and pays its `.d.ts` rebuild latency on every save. The alias removes both.

The cost is that nothing in the app exercises the packaged artifact any more — the `exports`
map, the dual ESM/CJS output and the generated `.d.ts` are covered only by `npm run build` at
the repo root. That is an acceptable trade while the web app is the sole consumer; **if the
library ever gains an external consumer, revisit it**, since packaging breakage would then be
able to reach someone before a build catches it. Measured when adopted: production bundle
unchanged (239.37 → 239.42 kB), so Rollup tree-shakes the source as effectively as tsup's
bundle did.

To undo, delete the alias and the `paths` entry; `dist/` resolution resumes with no source
changes, and `"node"` can come out of the web `types` array at the same time (it is needed only
because core's entry re-exports `node.ts`, whose `node:fs/promises` import tsc sees directly
once it reads source).

## Isomorphic input strategy

The core entry points, `parseZpcr(data)` and `parsePcrd(data, options)`, accept
`Uint8Array | ArrayBuffer` — the common denominator available in every JS runtime. Everything
downstream is synchronous and environment-agnostic.

Environment-specific *convenience* wrappers are kept thin and isolated so the core stays
portable:

- `zpcrFromFile(path)` / `pcrdFromFile(path)` (Node) dynamically import `node:fs/promises`, so
  bundlers targeting the browser never pull in Node built-ins unless the function is actually
  referenced.
- `zpcrFromBlob(blob)` / `pcrdFromBlob(blob)` use the `Blob` API, available in both browsers
  and modern Node.

## Two input formats, one output shape

`.zpcr` and `.pcrd` describe the same underlying qPCR run through unrelated containers — a
plain multi-file ZIP written incrementally by the instrument, versus a single encrypted XML
document written once by CFX Manager when a run is opened and saved (see `pcrd.md`). Rather
than let that difference leak into every consumer, `parsePcrd` decodes straight into a `Zpcr`
— the exact same public shape `parseZpcr` produces:

- **Reads, curves, metadata, plates()** all come from the same typed structures either way, so
  `pivot.ts`, the web app's views, and any future consumer are format-agnostic. A `.pcrd`'s
  plate reads are decoded from `<PlateRead>` XML elements (`decodePcrdPlateRead` in `pcrd.ts`)
  into the identical `PlateRead` interface `decodePlateRead` produces from the binary
  `.Plateread` layout — same `wells`/`dark`/`temps`, different source bytes.
- **`PlateRead.fields`** — a read's header as one key/value table whatever it was decoded
  from: the binary file's ICFF descriptor dictionary, or the `.pcrd` header element's
  children. Strictly two fields, `name` and `value`, for both formats.

  The formats disagree on *names* (`BLOCKTEMP` vs `BlockTmp`) and on whether a value is typed
  at all — an ICFF field is an untyped byte range — so **the library makes the type guess, once,
  and hands out only the result**: `temps.ts`'s own int-vs-float rule for temperatures, text
  where the field is a string, a byte count for the bulk arrays. This entry used to also carry
  the raw `IcffEntry` (offset, length, flag, every competing scalar decoding) so a consumer
  could second-guess it, and the web app duly did — six extra columns of ICFF layout and
  endianness rendered by a component that is supposed to be format-neutral. The raw index
  entries now live behind `decodePlateReadDetail()` alone, which is honestly labelled as the
  low-level binary view; nothing is lost, it just isn't in the shape both formats share.

  What the interface unifies is the shape, not the instrument's vocabulary; `temps` remains
  where the two vocabularies are actually reconciled to common keys. The binary file itself —
  size and version words — hangs off the optional `PlateRead.binaryFile`, absent for a `.pcrd`
  read, which is an element of a larger document rather than a file. The net effect is that a
  consumer renders one table and never reaches back into `Zpcr.archive` to re-parse the file a
  read came from.
- **`Zpcr.archive`** — a `.pcrd` has no inner files at all (it's one XML document, not an
  archive), so for a `.pcrd`-derived `Zpcr` this is an honestly empty `ArchiveAccess`:
  `entries` is `[]` and the accessors throw. This library does **not** pretend a `.pcrd` has
  files matching `.zpcr`'s names — the web app instead browses the document's real XML
  structure directly (see `apps/web/ARCHITECTURE.md`), using the full raw document text
  returned as `Pcrd.xml` alongside `zpcr`.
- **`Zpcr.protocolText`** — the thermal protocol's one-line program, sourced from the real
  `ProtocolRunDefinition.txt` file (`.zpcr`) or the `protocol2` element's `runDefinition`
  attribute (`.pcrd`) — the one piece of `.pcrd` data that needed lifting into a proper `Zpcr`
  field (rather than a fake archive entry) because a real `.zpcr` consumer (`OverviewView`)
  already depended on reading it by name.
- **`Zpcr.protocol()`** — a typed `ProtocolDocument` (name, lid/volume settings, and — when
  available — the ordered step list), to whatever fidelity each format allows without a
  password. A `.pcrd` embeds the full `<protocol2>` XML unencrypted, so this is a full decode
  via `prcl.ts`'s `parseProtocol2` (name comes from the embedded protocol's own
  `identifier`/`header`, e.g. `Unknown.prcl` for an ad-hoc unsaved protocol — not the `.pcrd`'s
  own filename, which isn't guaranteed to match). A `.zpcr`'s real protocol XML lives inside a
  possibly-encrypted `.prcl` archive entry (see `protocols()` below), so `protocol()` instead
  returns a best-effort document built from `protocolText` alone via
  `protocolDocumentFromRunDefinition` (name from `ProtocolName.txt`, lid/volume recovered from
  the `HOTLID`/`VOLUME` directives, no step list).
- **`ProtocolDocument.program`** — the `runDefinition` text decoded into typed directives, each
  with its operands, its 1-based step number and a one-line description of what it does
  (`runDefinition.ts`, `parseRunDefinition`; the language is [`protocol.md`](./protocol.md)).
  Always present, whatever the source, so a consumer never parses the `;`-delimited text itself
  — which is what keeps the web app's protocol views free of format knowledge. The XML step list
  gets the same treatment from `describeProtocolStep()`, and `parseScanMask()` decodes the
  `PLATEREAD` operand (`usb.md` §3.1) for the text form, `.Plateread`'s `CHANNELMASK` and
  `RunInfo.xml`'s `ScanMask` alike.
- **`Zpcr.plates()`** — a `.pcrd` embeds exactly one plate (`plateSetup2`), already decrypted
  along with the rest of the document. `pcrd.ts` reuses `pltd.ts`'s `parsePlatesetup2` (the
  same `<platesetup2>`/`<plateSetup2>` schema, differing only in root-tag case) and wraps it in
  a `PltdEntry` with no password step, so `zpcr.plates()` behaves the same for both formats
  even though only a `.zpcr`'s *embedded* `.pltd` entries actually need a password.

The one place formats stay genuinely distinct is the top-level decrypt step: `parsePcrd`
returns `{ container, needsPassword?, error?, xml?, zpcr? }` (mirroring `parsePltd`'s `Pltd`
shape) because the whole document — not just an embedded plate — is ZipCrypto-encrypted and
needs a password before any of the above exists. `xml` is the full raw decrypted document,
independent of `zpcr` — the app's only way to browse subtrees this module doesn't decode
(`dataAnalysisParameters`, `PersistedData`, …).

## A third, non-CFX input: Biomeme

`parseBiomeme` (`biomeme.ts`) reads a Biomeme handheld device's run-export JSON (Franklin/
Two3/Three9) into the same `Zpcr` shape as `parseZpcr`/`parsePcrd` — but the source instrument
is different enough that the mapping isn't the field-for-field translation `.pcrd` gets above:

- **No optical channels to unmix, but real ones nonetheless.** A CFX reading is a 6-channel
  vector that `calibration.md`'s solve separates into per-dye concentrations; a Biomeme reading
  is per-fluorophore already — the device did its own separation before ever writing the file.
  `Zpcr.dyeSpace: true` says so. `WellCurve.channel` is still a real optical channel, though, not
  an arbitrary index: `parseBiomeme` recovers it from each target's `emissionColor`
  (green/amber/red → channel 0/2/3, i.e. `Ch1`/`Ch3`/`Ch4` — a physical fact about the device's
  LED/filter pairs, not a per-run naming choice, so it's keyed on color rather than on whichever
  dye name an assay happens to use for that channel this time; the indices are chosen to land on
  the same hues `.zpcr`/`.pcrd`'s own channels 1/3/4 already draw as, per `biomeme.md`).
  `apps/web`'s `useRunAnalysis` checks `dyeSpace` once and skips color separation entirely for
  such a run — see `apps/web/ARCHITECTURE.md`'s "Dye-space sources skip color separation".
- **No plate reads, because the device already pivoted.** `.zpcr`/`.pcrd` both start from a
  `PlateRead[]` — one header-plus-well-grid record per cycle — that `pivot.ts` turns into curves.
  A Biomeme export has no such per-cycle record at all, only each curve's finished
  `rawData`/cycle series; `Zpcr.reads` is honestly `[]` (mirroring how a `.pcrd`'s `Zpcr.archive`
  is honestly empty above), and `curves()` returns the parsed curves directly rather than
  deriving them.
- **A synthesized, single-row plate**, because the export's `targets` array already carries
  per-well fluorophore, sample and (when set) target/gene assignment — the same information a
  `.pltd`/`plateSetup2` plate carries, just shaped as a flat list instead of a `<platesetup2>`
  document. `parseBiomeme` builds one `PlateDefinition` from it — a single row (a handheld
  device's tube positions are one strip of holders, not a grid), with as many columns as the
  file names distinct positions (3, 6 or 9 on the devices this was measured against; an
  arbitrary count, not a fixed shape) — so the web app's Wells/Samples/Targets rails work with no
  format-specific code, the same way `pcrd.ts` reusing `pltd.ts`'s plate schema does above. A
  plate of exactly one row is still addressed as row 0 ("row A") internally — `wellKey`,
  `groupOf` and everything else here work in row/col, never in a display string — but the app
  drops the now-constant row letter from what it shows, since naming a row that can't vary tells
  a user nothing a bare position number doesn't already say more plainly (`biomeme.md`'s "Wells
  are one row, not a grid").
- **The device's own analysis, carried alongside this library's.** Each target in the export
  states its own baseline-corrected curve, threshold and Cq — a second, independent analysis of
  the same measurement (`threshold.md`'s pipeline is `.zpcr`/`.pcrd`-only; nothing about it
  changes for Biomeme). `parseBiomeme` carries that on `WellCurve.fileAnalysis`
  (`FileAnalysis` — region, baseline fit, corrected curve, threshold, Cq, end-point RFU), and it
  is never fed into `computeCqTable` as an input — "one analysis per run" above is about *that*
  pipeline's internal consistency, not a claim that a source file can't also ship its own answer.
  A consumer that wants to compare the two reads `fileAnalysis` and the library's own
  `CqTableEntry` side by side; the web app's Curves view does exactly that behind a pair of
  toggles — see `apps/web/ARCHITECTURE.md`'s "File vs. computed analysis".

What doesn't apply to a handheld device is left honestly absent rather than faked: no `.Dcal`
calibrations, no `.prcl` protocol steps, no per-well gain factors, no reference row. Measured
agreement between the device's own Cq and this library's own algorithm over the committed sample
is in `biomeme.md` §3 — the two disagree substantially (median 4.1 cycles apart where both
report one), because the device's threshold is a per-*curve* value with no stated derivation
while `computeCqTable` resolves one threshold per *fluorophore* (`threshold.md` §5.2); that's the
motivating case for the file/computed toggle rather than a bug to close the gap on.

## Talking to an instrument, not a file (`src/usb/`)

Every other subsystem here decodes bytes someone already saved. `src/usb/` is the exception: it
drives a **live CFX96 over USB**, implementing the protocol in [`usb.md`](./usb.md) — enumeration,
the 5-byte application frame, the ASCII command channel, and file retrieval. Entry point
`CfxDevice`. It gets its own directory rather than a flat module because it is a five-file
subsystem with an internal seam (framing → commands → device), and because "this one talks to
hardware" is worth being able to see in the tree.

**It stays isomorphic, the same as everything else, and for a cheaper reason than expected.** The
obvious design is two backends — WebUSB in the browser, libusb in Node — behind an abstract
transport. That isn't needed: node-usb already ships a WebUSB implementation, so a browser
`USBDevice` and node-usb's expose the same `transferIn`/`transferOut` surface. The library
therefore takes a *structural* `UsbDeviceLike` interface naming just the members it uses, which
both satisfy with no adapter and no `instanceof`, and the environments differ only in how the
device handle is obtained. It is spelled structurally rather than imported from
`@types/w3c-web-usb` so core keeps taking no browser-typing dependency (see [Dependency
policy](#dependency-policy)). `usb` itself is an **optional** dependency used only by
`tools/cfx.mjs`; neither core nor the web app imports it.

Two things about the client are load-bearing and easy to undo by accident, both documented at
their definitions:

- **Reading is one background pump, not a read per command.** The IN endpoint is shared by
  channels the host never asked for, so a per-command reader eventually returns unsolicited
  channel-2 traffic as the answer to a channel-1 query, and every reply after it is off by one.
- **Commands are serialized, and some in groups.** There are no request ids — a reply is matched
  to a request by arrival order alone. Worse, `LISTALLFILES` replays whatever the preceding
  `GETFILESLEN` buffered and ignores its own path argument, so listing is an atomic pair;
  `CfxDevice.sequence` is what holds the channel across it.

Driving the real instrument is also what corrected four claims the packet captures had gotten
wrong — `usb.md` §10 collects them. That is the argument for keeping the CLI: a protocol
reverse-engineered from captures is a hypothesis until something speaks it.

## Why fflate

ZIP decompression is the one thing not worth hand-rolling. `fflate` is tiny (~8 KB), has
zero dependencies, is actively maintained, and runs identically in Node and the browser.
`.zpcr` archives are small (hundreds of KB), so we decompress the **whole** archive into
memory up front (`unzipSync`). That keeps the rest of the library synchronous and lets the
low-level archive API serve any file instantly. `fflate` also writes zips (`zipSync`), used by
the library's three write paths: `attachPlate.ts` (see below), `zpcrwebSettings.ts` (see below),
and `runFolder.ts` (see [below](#a-run-directory-is-a-zpcr-runfolderts)), in an otherwise
read-only library.

## A run directory *is* a `.zpcr` (`runFolder.ts`)

The instrument keeps a run in `\Storage Card\CurrentRun` as loose files — `RunInfo.xml`, the
`Read*.Plateread` series, the `.Dcal` set, the marker files. A `.zpcr` is a plain ZIP of exactly
those entries, so `zpcrFromRunFiles(files)` is a zip and nothing else: no conversion, no
synthesis, and the result parses straight back through `parseZpcr` with every entry byte-for-byte
what came off the wire (`packages/core/test/runFolder.test.ts` checks that against a committed
sample). The archive is named after `RunInfo.xml`'s `DataFile`, which is already the name CFX
Manager would have saved the same run under, and the call throws when `RunInfo.xml` is missing
rather than handing back an archive `parseZpcr` would reject.

This is what lets the web app's Instrument view open a run off a connected instrument as an ordinary
file (see [`apps/web/ARCHITECTURE.md`](./apps/web/ARCHITECTURE.md)).

## Plate CSV + attaching a plate (`plateCsv.ts`, `attachPlate.ts`)

There's no real (encrypted) `.pltd` *writer* — not worth building for a format the app only
ever needs to read. Instead, `plateCsv.ts` defines a small zpcrweb-only plain-text plate
format — CSV, canonical extension **`.plt.csv`** (`plateToCsv`/`parsePlateCsv`,
`isPlateCsvName`) — as the thing the app can actually produce: one `# key: value` header block
of plate-level metadata, then one CSV row per well, column-major (`A1, B1, C1, … A2`), the
order a plate is filled down. Row order is presentation only — `parsePlateCsv` places each row
by its own well label and derives the plate's target/sample lists by walking the wells, so a
file re-sorted in a spreadsheet reads back identically. The fixed columns (`Well`, `SampleType`,
`Sample`, plus `Replicate`/`Quantity` when any well on the plate uses them — most don't, and a
column of empty cells says nothing) are followed by one column per fluorophore, labelled with
the dye name, whose cells hold only that well's target for it (empty = fluor absent, `+` =
present with no target) — so a plate reads as a target-per-fluor grid in a spreadsheet. Those
columns are ordered by ascending channel (unknown-channel dyes last, `pltd.ts`'s shared
`byChannel`), so each well row reads its fluors low channel → high; like row order it's
presentation only, since `parsePlateCsv` keys each cell to its column heading and re-sorts. They
are the plate's whole fluor list; the channel isn't written, since a dye is read on
exactly one channel and the run's own `.Dcal` set says which (`Dcal.primaryChannel`).
The `SampleType` cell holds a normalized type name (`unknown`, `ntc`, …), but a raw CFX
`wellSampleType` code is accepted too and normalized on read — which is how an `other` well
round-trips: since `other` means "a code we didn't recognize" rather than a type, `plateToCsv`
writes the preserved `sampleTypeRaw` instead of inventing a `wcOther` that no CFX tool emits.
`parseZpcr` builds that dye→channel map lazily (via `dcal.ts`'s `dyeChannelLookup`) and hands
it to `parsePlateCsv` as `channelForFluor`; an explicit `FAM Ch1`-style suffix still wins if a
file carries one, and a dye in neither leaves `channel` **undefined** — there is deliberately
no positional fallback, because column order carries no meaning and inferring a channel from it
produces a wrong answer that looks plausible rather than a missing one. `WellFluor.channel` and
`PlateFluor.channel` are therefore optional all the way through, and consumers must render the
gap as unknown rather than substituting a default (the web app shows `Ch?`, a neutral swatch and
a footnote; see `apps/web/ARCHITECTURE.md`). Go through `zpcr.plates()` where an archive is in
hand, so the lookup is wired up; a plate CSV read on its own simply has unknown channels.

For a plate CSV that *isn't* in the archive, `Zpcr.channelForDye(dye)` publishes the same cached
lookup, so a caller pairing a run with an outside plate can hand it to `parsePlateCsv` as
`channelForFluor` and get the channels the run's own optics say. That is not the positional guess
ruled out above and not a guess at all: it is one instrument's calibration set applied to a plate
the caller has stated belongs with that run — the app's Instrument view stages exactly that pair (see
`apps/web/ARCHITECTURE.md`). A source with no calibrations of its own (a Biomeme run) answers
`undefined` for every dye, as it should.
Channels only drive colouring and grouping, never the color-separation solve, so an unknown one
costs presentation rather than correctness. Wells with nothing on them aren't written at
all, and a well missing from the table parses back as empty, so the only header line that
really matters is `vessel` — everything else is an optional display-only passenger. The plate's `identityKey` (its user-facing name) isn't in the file
either: the file/archive-entry name *is* that identity, so `parsePlateCsv`'s `sourceName`
derives it from the name its caller read the text under.

The `vessel` header carries `PlateDefinition.plateName`, and is deliberately *not* spelled
`plateName`: that field is the consumable type (`BR Clear`/`BR White` — see pltd.md "Vessel
type"), which is what picks the tube type the dye response curve is built for, and the similar
name invited reading it as the plate's own name when the file name is that. It also sits next
to a real `plateType` header, CFX's unrelated template category. The plate's extent rides on
the same line — `# vessel: BR Clear 8x12` — since it's one more fact about the physical plate;
absent, it's inferred from the well labels. Header values are read up to the first comma, since
a spreadsheet round-trip pads comment lines with trailing commas. It's
deliberately not a CFX format (no `meta`/`fluorId` fidelity), so it isn't a decoder doc in the
table above.

`zpcr.ts`'s `plates()` treats a `.plt.csv` archive entry exactly like a `.pltd` one — wrapped in
a synthetic `Pltd`-shaped result (`pltdFromPlateCsv`) with a dummy `PltdContainer` and
`needsPassword` always `false` — so every existing plate consumer (the web app's Plates/Curves
views) needs zero changes to read one.

`attachPlate.ts`'s `attachPlateToZpcr(zpcrBytes, plateFile)` is the write side: unzip, drop any
existing `.pltd`/`.plt.csv` entry (at most one plate entry is kept — attaching replaces, not
adds), add the new entry, `zipSync` back to bytes. The web app calls this to "attach a plate to
a run": it rewrites the run's own in-memory bytes and re-persists them under the same file id,
so the plate travels with the file with no separate override state to keep in sync — see
`apps/web/ARCHITECTURE.md`.

## Analysis settings in the archive (`zpcrwebSettings.ts`)

The library's second write path, and the same idea one level up: a run's **analysis** parameters
— thresholds, §5.2's auto-threshold multiplier, calibration normalization —
belong to the run, not to whichever browser opened it, because they are what decide the Cq it
reports. The entry carries one thing that isn't a parameter: `experimentName`, what the run is
*called*. No CFX format has a field for one (`RunInfo.xml`'s name-ish keys are empty on every
sample; the instrument encodes the name into the filename instead), so `experiment.ts` resolves
stored name → the format's own → a derivation from the filename. `writeZpcrwebSettings` adds them to the archive as a `zpcrweb.json` entry;
`parseZpcrwebSettings` reads them back through the already-decompressed `Zpcr.archive`, total and
field-by-field so a hand-edited or newer document degrades instead of failing. Full schema and
rationale in [`zpcrweb-json.md`](./zpcrweb-json.md); the app-side scheduling (why writes are
rate-limited, and what a `.pcrd` does instead) in `apps/web/ARCHITECTURE.md`.

## Decoding pipeline

```
raw bytes ─▶ fflate.unzipSync ─▶ { name: Uint8Array }
                                     │
                 ┌───────────────────┼──────────────────────┐
                 ▼                    ▼                       ▼
          RunInfo.xml          Read*.Plateread          (all files)
        parseRunInfo()        decodePlateRead()        ArchiveAccess
                 │                    │                (bytes/text/hexDump)
                 ▼                    ▼
           RunMetadata          PlateRead[]  ──▶  toCurves()  ──▶  WellCurve[]
```

- **`archive.ts`** — decompress + the low-level `ArchiveAccess` facade.
- **`icff.ts`** — parses the trailing **ICFF index** shared by `.Plateread` and `.Dcal`: a
  footer points at a list of field-name slots, each mapping to an offset/length in the file.
  Every other field lookup in those two formats goes through it, so no offsets are hardcoded.
  See [`icff.md`](./icff.md).
- **`plateread.ts`** — `DataView`-based decoder for the 22037-byte `.Plateread` layout, driven
  by the ICFF index: mixed-endian (big-endian scalars, little-endian WELLDATA / DARKDATA float
  arrays). Scalars are guarded (returned only when they validate).
- **`dcal.ts`** — decodes `.Dcal` pure-dye calibration entries (`zpcr.calibrations()`): one
  dye's fluorescence response across all 6 channels at 4 block temperatures, plus a matching
  empty-plate baseline, also on top of the ICFF index. Also exports `dyeChannelLookup`, the
  one place dye→channel matching (`PRIMARYCHANNEL`, case- and whitespace-insensitive) is
  implemented — see the plate CSV format above. See [`dcal.md`](./dcal.md).
- **`calibration.ts`** — channel→dye color separation built on top of `.Dcal` data: per-dye
  response curves, a channel×dye calibration matrix, and a solve via `linalg.ts`'s
  pseudo-inverse. The matrix's normalization mode is a conditioning choice only — the solve
  undoes it and reports per-dye RFU, so the mode never changes the scale. See
  [`calibration.md`](./calibration.md).
- **`linalg.ts`** — the small dense-matrix routines `calibration.ts` needs, chiefly a
  pseudo-inverse via Jacobi eigen-decomposition of the Gram matrix. Both its convergence test
  and its singular-value floor are **relative**, which is what makes the color-separation
  pipeline scale-invariant.
- **`baseline.ts`** — the baseline stage (`threshold.md` §3–§4) of a dye curve's Cq analysis, and
  now three short functions: `baselineRegion()` (begin at cycle 3; end at the last cycle for a well
  with no Cq, or `round(Cq) − 2` for one that has it — both recovered from CFX's own per-well
  baselines), `subtractBaseline()` (ordinary least squares, no smoothing) and `smoothPlateauTail()`
  (the width-3 tail average `LinearBaseLineNormalizedCurveFit` names, which changes the reported
  plateau and nothing else). `endPointRfu()` — the mean of the last five corrected cycles — lives
  here too. Every constant in the module is measured against the instrument's exported results;
  this replaced two onset detectors, a whiteness start-trim, a validation gate and a smoothing
  stage, all of them inferred. See [`threshold.md`](./threshold.md) §A.7 and §3.
- **`threshold.ts`** — the threshold and Cq stages (§5–§6). `baselineNoise()` is the median
  absolute second difference of the corrected curve over the baseline region, scaled to σ: unlike a
  standard deviation or an RMS successive difference it survives being computed over a region the
  baseline doesn't describe, which the first pass of the region search deliberately does.
  `autoThreshold()` is `multiplier × median noise` per fluorophore — the one number in the pipeline
  with no measurement behind it, and known to be the wrong *form* of rule (§5.2); `resolveThreshold()`
  prefers a manual override, which is the only way to reproduce a reference Cq exactly. `computeCq()`
  is measured exactly: two-point linear interpolation on the cycle index, the crossing followed by
  the longest strictly-increasing run, and `T ∈ [min, max]` as the sole gate — narrowed only to the
  cycles the baseline was fitted to describe, since a corrected value before cycle 3 is an
  extrapolation of a line deliberately told not to model the settling transient there, and reading
  a Cq off one produced a Cq of 1.32 for a flat well. There are no quality
  gates at all: the reference applies none, and letting one veto a Cq is what kept this library's
  Cq population from ever matching. See
  [`threshold.md`](./threshold.md) §5–§6, and `packages/core/test/cfxExport.test.ts`, which asserts
  the Cq stage against CFX's own numbers to 1e-9 cycles. `median()` and `stdDev()` live here too:
  they had their own `stats.ts` while `baseline.ts` also needed them, and it does not any more.
- **`analysis.ts`** — the transforms that sit on top of those two: `baselineCorrectCurve()` (one
  curve's baseline, noise and ΔRFU, iterating region against Cq to a fixed
  point), `correctCurveForDisplay()` (the same for a series that will never be quantified — a raw
  channel trace, a dark overlay) and `computeCqTable()`, **the** Cq entry point. `computeCqTable()`
  takes every curve of a run at once in **two passes** — whole-run baselines to get each group's
  threshold, then every curve re-baselined against it and the thresholds re-resolved — and returns
  one entry per well/fluorophore key, carrying the Cq, the threshold it was taken against and the
  end-point RFU.
  It's deliberately batch-shaped: a Cq isn't a property of a single curve — its threshold is the
  median noise of the curves it was computed *with* — so recomputing over a filtered subset yields
  a different, equally defensible answer for the same well. Consumers build the table once over the
  whole plate and filter it for display; see `apps/web/src/lib/runAnalysis.ts`.
- **`runinfo.ts`** — a small regex scan over the flat `<KeyValuePairs>` list. No XML
  dependency: the structure is regular and self-closing `<Value />` maps to `""`.
- **`temps.ts`** — pulls temperatures out of the `.Plateread` ICFF index. It matches on the
  field *name* (anything containing `TEMP`) rather than a hardcoded list, so a firmware that
  emits a temperature this code has never seen surfaces it with no code change (there are no
  per-row block temperatures, gradient runs included — `plateread.md` §3). Measured floats
  and int set points are told apart by plausibility (see the module comment).
- **`leds.ts`** — the same name-matched extraction for the six `LEDCURRENT*` fields: each
  optical channel's excitation-LED drive setting, in DAC counts (`RunInfo.xml`'s
  `LEDDACValsCal`), with no invented conversion to milliamps.
- **`pivot.ts`** — transforms run-centric reads into well-centric curves, per-channel dark
  curves, per-field temperature series, and per-channel LED-current series.
- **`pltd.ts`** — decodes `.pltd` plate-definition entries into a typed `PlateDefinition`
  (`zpcr.plates()`): each `.pltd` is a single-entry ZIP whose payload is ZipCrypto-encrypted
  and DEFLATE/DEFLATE64-compressed, wrapping a `<platesetup2>` XML plate map. See
  [`pltd.md`](./pltd.md). `fflate` covers neither ZipCrypto nor DEFLATE64, so those are
  handled in-house by **`zipcrypto.ts`** (traditional PKWARE decrypt) and **`inflate.ts`**
  (a small DEFLATE/DEFLATE64 inflater) — no new runtime dependency.
- **`zipsingle.ts`** — the single-entry-ZIP container parse (central-directory driven, both
  container variants) shared by `.pltd`/`.prcl` and `.pcrd` — see `pltd.md` §1/`pcrd.md` §1.
- **`xmlLite.ts`** — minimal hand-rolled XML scanning shared by every CFX XML payload: attribute
  parsing, entity unescaping, and `splitElements()`, a depth-tracking child-element splitter
  used to walk a large `.pcrd` document one level at a time (root → `runData` →
  `plateReadDataVector` → each `plateRead`) without a full DOM parse.
- **`pcrd.ts`** — decodes a `.pcrd` (see `pcrd.md` and "Two input formats" above) into a `Zpcr`.
  Shares its container/decrypt/inflate path with `pltd.ts` via `zipsingle.ts`/`zipcrypto.ts`/
  `inflate.ts`; its own code is XML traversal (`xmlLite.ts`) to build `PlateRead[]`, the
  embedded plate, and `protocolText` — `Zpcr.archive` is a trivial empty stub (see above).
- **`zpcr.ts`** — orchestrates the above into the public `Zpcr` object (the `.zpcr` path;
  `pcrd.ts` builds the equivalent object directly for `.pcrd`).
- **`fileKind.ts`** — the accepted encodings (`FileKind`) and what each one *is*
  (`fileCategory()`: a run, a plate map or a thermal protocol). No bytes: it exists so consumers
  stop re-deriving "a `.pltd` and a `.plt.csv` are both a plate" from file extensions. The web
  app's file-chip icons and its Instrument-view run staging are both driven by it.

## Two output shapes

Both are provided because they serve different consumers:

1. **Run-centric** (`Zpcr.reads`) mirrors the files 1:1 — an ordered array of reads, each
   holding the full well grid with all four floats (mean/std/min/max). This is lossless and
   is the canonical representation.
2. **Well-centric** (`Zpcr.curves()`) pivots into per-well, per-channel mean-fluorescence
   arrays aligned to cycle number — directly plottable amplification curves. It is derived
   on demand from the run-centric data, so there is no duplicated source of truth.

## Low-level archive API

Full visualizers for every remaining `.zpcr` file type (protocol, `.alf`, `runlog.xml`) are
future work. Until then, `Zpcr.archive` lets the UI show the raw `bytes`, decoded `text`, or a
canonical `hexDump` of any real archive entry. This means the app can present *something*
useful for every file from day one, and new typed parsers can be layered in without changing
the low-level contract. This is `.zpcr`-only — a `.pcrd`'s `archive` is empty by design (see
"Two input formats" above); its raw exploration is a real XML tree, not a file list.

## Coordinate convention

Wells are addressed as `(channel, row, col)`:

- `channel` 0–5, scan order. The channel→dye mapping itself lives in `.Dcal` calibration
  files (`PRIMARYCHANNEL`), not `.Plateread` — see [`dcal.md`](./dcal.md).
- `row` 0–7 = plate rows A–H; `row` 8 = the reference row.
- `col` 0–11 = plate columns 1–12.
- Flat WELLDATA index: `channel * 108 + row * 12 + col`.

## Tooling

- **`tools/cfx.mjs`** — a CLI over a live instrument (`info`, `status`, `ls`, `get`, and `--trace`
  for the raw message log). Needs the optional `usb` dependency and a built core. Every subcommand
  is a named `CfxDevice` operation; there is no "send this command line" escape hatch, in the CLI
  or the library (`usb.md` §10).
- **Vitest** for tests — isomorphic, fast, and ready for a future browser-mode test run.
- **tsup** for builds — emits dual ESM + CJS plus `.d.ts` from a single entry point. The web app
  deliberately does not consume this output (see [Why the web app imports core's
  source](#why-the-web-app-imports-cores-source)), so `npm run build` at the repo root is the
  only thing that exercises the packaged artifact.
- **TypeScript** in `strict` mode with `noUncheckedIndexedAccess`.

## Dependency policy

Runtime dependencies are added only when the alternative is re-implementing a well-solved,
security-sensitive primitive (compression). Everything else — binary parsing, XML scanning,
hex formatting — is hand-written and tested. New runtime dependencies should clear the same
bar.
