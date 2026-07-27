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
[`CLAUDE.md`](./CLAUDE.md) for the full doc ↔ code table.

## Goals

- One parsing library, usable **unchanged** from both a Node app and a browser web app.
- Well-typed output: the consumer never touches raw bytes unless they want to.
- **Two input formats, one output shape.** `.zpcr` (instrument raw output) and `.pcrd` (CFX
  Manager's saved-experiment document) describe overlapping data through very different
  containers — see "Two input formats" below. `parseZpcr`/`parsePcrd` both produce a `Zpcr`,
  so nothing downstream (pivots, the web app's views) needs to know which format it's holding.
- Minimal dependencies. One reputable dependency (`fflate`) for ZIP decompression; nothing
  else at runtime.
- An extensive test suite validated against real instrument samples.

## Monorepo

npm workspaces:

- `packages/core` — `@zpcrweb/core`, the library. No framework, no DOM/Node coupling in the
  core path.
- `apps/web` — the web app, which depends on `@zpcrweb/core`. Scaffolded now, built later
  (see [`TODO.md`](./TODO.md)).
- `samples/` — committed real `.zpcr` files and a matching `.pcrd` (~350 KB) for the same run,
  used by tests as ground truth (see `pcrd.test.ts`'s cross-validation against
  `20260720_FirstQualification.zpcr`).

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
  `.Plateread` layout — same `wells`/`dark`/`temps`/`get()`, different source bytes.
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

## Why fflate

ZIP decompression is the one thing not worth hand-rolling. `fflate` is tiny (~8 KB), has
zero dependencies, is actively maintained, and runs identically in Node and the browser.
`.zpcr` archives are small (hundreds of KB), so we decompress the **whole** archive into
memory up front (`unzipSync`). That keeps the rest of the library synchronous and lets the
low-level archive API serve any file instantly. `fflate` also writes zips (`zipSync`), used by
the library's two write paths: `attachPlate.ts` (see below) and `zpcrwebSettings.ts` (see
below), in an otherwise read-only library.

## Plate CSV + attaching a plate (`plateCsv.ts`, `attachPlate.ts`)

There's no real (encrypted) `.pltd` *writer* — not worth building for a format the app only
ever needs to read. Instead, `plateCsv.ts` defines a small zpcrweb-only plain-text plate
format — CSV, canonical extension **`.plt.csv`** (`plateToCsv`/`parsePlateCsv`,
`isPlateCsvName`) — as the thing the app can actually produce: one `# key: value` header block
of plate-level metadata, then one CSV row per well. The fixed columns (`Well`, `SampleType`,
`Sample`, `Replicate`, `Quantity`) are followed by one column per fluorophore, labelled with
the dye name, whose cells hold only that well's target for it (empty = fluor absent, `+` =
present with no target) — so a plate reads as a target-per-fluor grid in a spreadsheet. Those
columns are the plate's whole fluor list; the channel isn't written, since a dye is read on
exactly one channel and the run's own `.Dcal` set says which (`Dcal.primaryChannel`).
`parseZpcr` builds that dye→channel map lazily and hands it to `parsePlateCsv` as
`channelForFluor`; an explicit `FAM Ch1`-style suffix still wins if a file carries one, and a
dye in neither falls back to its column position. Wells with nothing on them aren't written at
all, and a well missing from the table parses back as empty, so only `plateName` and the
`rows`/`columns` extent really matter in the header — everything else is an optional
display-only passenger. The plate's `identityKey` (its user-facing name) isn't in the file
either: the file/archive-entry name *is* that identity, so `parsePlateCsv`'s `sourceName`
derives it from the name its caller read the text under. Header values are read up to the
first comma, since a spreadsheet round-trip pads comment lines with trailing commas. It's
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
— thresholds, §5.1's auto-threshold multiplier, dark subtraction, calibration normalization —
belong to the run, not to whichever browser opened it, because they are what decide the Cq it
reports. `writeZpcrwebSettings` adds them to the archive as a `zpcrweb.json` entry;
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
  empty-plate baseline, also on top of the ICFF index. See [`dcal.md`](./dcal.md).
- **`calibration.ts`** — channel→dye color separation built on top of `.Dcal` data: per-dye
  response curves, a channel×dye calibration matrix, and a solve via `linalg.ts`'s
  pseudo-inverse. The matrix's normalization mode is a conditioning choice only — the solve
  undoes it and reports per-dye RFU, so the mode never changes the scale. See
  [`calibration.md`](./calibration.md).
- **`linalg.ts`** — the small dense-matrix routines `calibration.ts` needs, chiefly a
  pseudo-inverse via Jacobi eigen-decomposition of the Gram matrix. Both its convergence test
  and its singular-value floor are **relative**, which is what makes the color-separation
  pipeline scale-invariant.
- **`baseline.ts`** — the baseline stages (§2–§4, plus the §7 validation gate) of a dye curve's Cq
  analysis: smoothing, automatic/manual baseline-region selection, baseline subtraction, and
  `validateBaselineRegion()`. Curvature-based selection reads onset at the *foot* of the
  second-derivative peak rather than the peak itself, which otherwise sits inside the exponential
  phase and hands back a "baseline" containing part of the rise — the flatness bounds are relative
  to the curve's whole span and so don't catch it on a high-amplitude well. The gate is
  `validateBaselineRegion()`, which re-checks whichever region was actually chosen (including
  `findBaselineByRegression`'s fallback, whose local fit-and-extend can lock onto a region that's
  a good line by itself but a poor description of the whole curve) against §3.2's
  flatness/linearity bounds judged over the curve's full span — extending regions narrower than
  `minValidationWidth` first, since a too-narrow window passes that check trivially regardless of
  the curve. `refineBaselineStart()` then trims the region's *start*, walking it forward until the
  residuals about a fitted line stop being serially correlated — the settling transient of the run's
  first cycles is otherwise absorbed into the fit and inflates every downstream quantity. It is
  bounded (never past ~15 cycles, never below 8 wide) and gives up rather than trimming when no
  start makes the region white, since that means the mis-fit isn't confined to the front. Judged on
  the *unsmoothed* curve: §2's filter is serial correlation by construction. See
  [`threshold.md`](./threshold.md) §3.4.
- **`threshold.ts`** — the threshold and Cq stages (§5–§7) that finish what `baseline.ts` starts:
  per-fluorophore noise/threshold estimation (manual override or auto — the median of a well
  subset times a multiplier whose scale comes from the thresholds CFX itself persisted in a
  `.pcrd`, far above the textbook figure because the noise measured here is a post-smoothing,
  post-baseline-subtraction residual, not raw well scatter; the estimate also skips the baseline
  region's first cycle). The noise statistic is the **successive difference** of those residuals,
  not their standard deviation: a spread about a fitted line measures how far the curve is from the
  model, which is the wrong question when the model is wrong, and made the threshold inflate
  per-well wherever the baseline curved. That change is what makes the two thresholds CFX persisted
  imply a consistent multiplier (85× and 80×, against 90× and 42× before) — see
  [`threshold.md`](./threshold.md) §5.2. Then the §6.1 threshold-crossing Cq (log-interpolated, with a linear
  fallback and the §6.1 edge cases — anchored to the *final* above-threshold run, so baseline noise
  flickering over a low group threshold can't be read as a cycle-1 Cq), the §6.2 curve-shape
  (`NoThreshold`) Cq via
  second-derivative maximum, and the §7 amplification squelch — now gated first by
  `baseline.ts`'s baseline-validation result (`computeCq()`'s `baselineValid` option). `computeCq()`
  ties both algorithms together. See [`threshold.md`](./threshold.md).
- **`stats.ts`** — the statistics `baseline.ts` and `threshold.ts` both need, in their own module
  so neither imports the other: standard deviation, mean squared successive difference, median, and
  `whiteness()` (von Neumann's ratio — mean squared successive difference over variance, ≈2 for
  white noise and →0 under serial correlation). The ratio drives baseline-region *selection* and is
  exposed as a per-curve diagnostic; it is deliberately **not** a validation gate, being scale-free
  and so unable to tell structure that matters from structure below the instrument's resolution.
- **`analysis.ts`** — the transforms that sit on top of those two: `baselineCorrectCurve()` (one
  curve's baseline, noise, amplification verdict and ΔRFU) and `computeCqTable()`, **the** Cq
  entry point. `computeCqTable()` takes every curve of a run at once, resolves one §5.1 threshold
  per group from that group's own noise cohort, and returns one entry per well/fluorophore key.
  It's deliberately batch-shaped: a Cq isn't a property of a single curve — its threshold is the
  median noise of the curves it was computed *with* — so recomputing over a filtered subset yields
  a different, equally defensible answer for the same well. Consumers build the table once over the
  whole plate and filter it for display; see `apps/web/src/lib/runAnalysis.ts`.
- **`runinfo.ts`** — a small regex scan over the flat `<KeyValuePairs>` list. No XML
  dependency: the structure is regular and self-closing `<Value />` maps to `""`.
- **`temps.ts`** — pulls temperatures out of the `.Plateread` ICFF index. It matches on the
  field *name* (anything containing `TEMP`) rather than a hardcoded list, so a firmware that
  emits, say, per-row block temperatures surfaces them with no code change. Measured floats
  and int set points are told apart by plausibility (see the module comment).
- **`pivot.ts`** — transforms run-centric reads into well-centric curves, per-channel dark
  curves, and per-field temperature series.
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
