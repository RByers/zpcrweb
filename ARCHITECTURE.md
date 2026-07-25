# Architecture

Key design points for the zpcrweb project. For the `.Plateread` binary format itself, see
[`plateread.md`](./plateread.md); for the `.pcrd` XML format, see [`pcrd.md`](./pcrd.md).

## Format documentation

Every reverse-engineered Bio-Rad file format (or sub-format, like the shared ICFF container)
gets its own top-level `*.md` doc — [`plateread.md`](./plateread.md), [`dcal.md`](./dcal.md),
[`pltd.md`](./pltd.md), [`pcrd.md`](./pcrd.md), [`icff.md`](./icff.md). The one non-format
exception is [`calibration.md`](./calibration.md), which documents the channel→dye
color-separation algorithm built on top of `.Dcal` rather than a byte layout. Each doc is
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
  used by tests as ground truth (see `pcrd.test.ts`'s cross-validation against `20260720.zpcr`).

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
low-level archive API serve any file instantly.

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
- **`baseline.ts`** — the baseline stages (§2–§4) of a dye curve's Cq analysis: smoothing,
  automatic/manual baseline-region selection, and baseline subtraction. Stops short of
  thresholding and Cq themselves, which remain unimplemented. See [`threshold.md`](./threshold.md).
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
- **tsup** for builds — emits dual ESM + CJS plus `.d.ts` from a single entry point.
- **TypeScript** in `strict` mode with `noUncheckedIndexedAccess`.

## Dependency policy

Runtime dependencies are added only when the alternative is re-implementing a well-solved,
security-sensitive primitive (compression). Everything else — binary parsing, XML scanning,
hex formatting — is hand-written and tested. New runtime dependencies should clear the same
bar.
