# Architecture

Key design points for the zpcrweb project. For the `.Plateread` binary format itself, see
[`plateread.md`](./plateread.md).

## Goals

- One parsing library, usable **unchanged** from both a Node app and a browser web app.
- Well-typed output: the consumer never touches raw bytes unless they want to.
- Minimal dependencies. One reputable dependency (`fflate`) for ZIP decompression; nothing
  else at runtime.
- An extensive test suite validated against a real instrument sample.

## Monorepo

npm workspaces:

- `packages/core` — `@zpcrweb/core`, the library. No framework, no DOM/Node coupling in the
  core path.
- `apps/web` — the web app, which depends on `@zpcrweb/core`. Scaffolded now, built later
  (see [`TODO.md`](./TODO.md)).
- `samples/` — a committed real `.zpcr` (~400 KB) used by tests as ground truth.

## Isomorphic input strategy

The core entry point, `parseZpcr(data)`, accepts `Uint8Array | ArrayBuffer` — the common
denominator available in every JS runtime. Everything downstream is synchronous and
environment-agnostic.

Environment-specific *convenience* wrappers are kept thin and isolated so the core stays
portable:

- `zpcrFromFile(path)` (Node) dynamically imports `node:fs/promises`, so bundlers targeting
  the browser never pull in Node built-ins unless the function is actually referenced.
- `zpcrFromBlob(blob)` uses the `Blob` API, available in both browsers and modern Node.

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
- **`plateread.ts`** — `DataView`-based little-endian decoder for the fixed 22037-byte
  `.Plateread` layout (WELLDATA at `0x1A8`, DARKDATA at `0x2A28`, cycle at `0x120`, block
  temp at `0x133`, timestamp at `0x182`). Header temp/timestamp are read best-effort and
  guarded (returned only when they validate).
- **`runinfo.ts`** — a small regex scan over the flat `<KeyValuePairs>` list. No XML
  dependency: the structure is regular and self-closing `<Value />` maps to `""`.
- **`pivot.ts`** — transforms run-centric reads into well-centric curves.
- **`zpcr.ts`** — orchestrates the above into the public `Zpcr` object.

## Two output shapes

Both are provided because they serve different consumers:

1. **Run-centric** (`Zpcr.reads`) mirrors the files 1:1 — an ordered array of reads, each
   holding the full well grid with all four floats (mean/std/min/max). This is lossless and
   is the canonical representation.
2. **Well-centric** (`Zpcr.curves()`) pivots into per-well, per-channel mean-fluorescence
   arrays aligned to cycle number — directly plottable amplification curves. It is derived
   on demand from the run-centric data, so there is no duplicated source of truth.

## Low-level archive API

Full visualizers for every file type (protocol, `.alf`, `runlog.xml`, `.Dcal`) are future
work. Until then, `Zpcr.archive` lets the UI show the raw `bytes`, decoded `text`, or a
canonical `hexDump` of any archive entry. This means the app can present *something* useful
for every file from day one, and new typed parsers can be layered in without changing the
low-level contract.

## Coordinate convention

Wells are addressed as `(channel, row, col)`:

- `channel` 0–5 (scan order; dye mapping requires calibration files — future work).
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
