# CLAUDE.md

## Git workflow

**No pull requests in this repo.** Work is committed directly onto branches and then merged into main. 

- Merge feature/worktree branches into `main` locally. After doing so delete the worktree and branch.
- Don't open PRs, and don't push anything upstream to the `origin`

Whenever changes are made, review and update all ARCHITECTURE.md files to be a concise yet accurate summary of the application design, with pointers to other relevant files.

## Secrets

Local-only secrets (e.g. the CFX file decryption password) live in `SECRETS.md`, which is
gitignored and never committed.

## Format documentation

The reverse-engineered binary format docs are the reference for anything in
`packages/core/src` that touches raw bytes — read them before changing a decoder. There's also
one algorithm doc, `calibration.md`, for the color-separation math built on top of `.Dcal`.

| Doc | Covers |
|-----|--------|
| [`icff.md`](./icff.md) | "ICFF" — the small index container format underlying both `.Plateread` and `.Dcal`: a trailing footer points at an index of `[name, offset, length]` entries. Implemented by `packages/core/src/icff.ts`; locate the index via the footer, not by scanning for a known field name. |
| [`plateread.md`](./plateread.md) | The `.Plateread` files inside a `.zpcr` — one per plate read (PCR cycle), holding the 6-channel × 108-well raw fluorescence table plus cycle number, block temperature and timestamp. **Mixed endianness:** metadata (version words, ICFF index) is big-endian; the WELLDATA/DARKDATA float arrays are little-endian. Implemented by `packages/core/src/plateread.ts`. |
| [`dcal.md`](./dcal.md) | The `.Dcal` pure-dye calibration files — per-dye, per-plate-type fluorescence response across all 6 channels at 4 block temperatures, plus a matching empty-plate baseline; the only in-archive source of the channel→dye mapping (`PRIMARYCHANNEL`). Unencrypted ICFF container. Implemented by `packages/core/src/dcal.ts`, entry point `parseDcal(bytes)`; `zpcr.calibrations()` decodes every `.Dcal` entry in an archive. |
| [`calibration.md`](./calibration.md) | Channel→dye color separation — the algorithm that turns raw per-channel readings plus `.Dcal` calibration data into per-dye concentration estimates. Not a file format doc; not yet cross-validated against a reference instrument's own output. Implemented by `packages/core/src/calibration.ts` (linear algebra in `linalg.ts`), entry points `separateDyes()` (one-shot) and the individual `buildDyeResponseCurve`/`buildCalibrationMatrix`/`preprocessChannelReadings`/`separateChannels` stages. |
| [`pltd.md`](./pltd.md) | The `.pltd` plate-definition files — per-well fluorophores, target/gene, sample name and type, replicate, standard quantity. Encrypted + compressed XML container. Implemented by `packages/core/src/pltd.ts`, entry point `parsePltd(bytes)`; `zpcr.plates()` decodes every plate in an archive. |
| [`prcl.md`](./prcl.md) | The `.prcl` thermal-cycling protocol files — lid/volume settings plus the ordered step list (hold, gradient, melt, goto, plate read), in the same encrypted-ZIP container as `.pltd`/`.pcrd`. The same `protocol2` XML document `.pcrd` embeds. Implemented by `packages/core/src/prcl.ts`, entry point `parsePrcl(bytes)`; `parseProtocol2()` is reused by `pcrd.ts`; `zpcr.protocols()` decodes every `.prcl` entry in an archive. |
| [`pcrd.md`](./pcrd.md) | The `.pcrd` CFX Manager saved-experiment file — the whole run (plate setup, protocol, every plate read, `RunInfo`/`runlog`, plus analysis/UI state) as one large XML document, in the same encrypted-ZIP container as `.pltd`/`.prcl`. Implemented by `packages/core/src/pcrd.ts`, entry point `parsePcrd(bytes)`, which decodes into the same `Zpcr` shape `parseZpcr` produces. |
| [`zipcrypto.md`](./zipcrypto.md) | The single-entry ZipCrypto-encrypted ZIP container shared by `.pltd`/`.prcl` and `.pcrd`: container variants, the fixed shared password, and the decrypt → inflate pipeline. Implemented by `packages/core/src/zipcrypto.ts` + `inflate.ts`. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Project-level design: isomorphic library goals, monorepo layout, input strategy. |
| [`apps/web/ARCHITECTURE.md`](./apps/web/ARCHITECTURE.md) | Web app design notes. |

`icff.md`, `plateread.md`, `dcal.md`, `pltd.md`, and `prcl.md` are marked **fully decoded** and
validated against the committed samples in `samples/` — though one `prcl.md` field (the
`PLATEREAD` operand) remains uninterpreted.
`pcrd.md`'s container, plate-read data, and `calibrationCollection` are likewise fully decoded
and cross-validated bit-for-bit against the matching `.zpcr`; its remaining analysis-state
subtrees (`dataAnalysisParameters`, `PersistedData`, …) are mapped but not yet interpreted. If a
decoder changes, update the corresponding doc in the same commit.

## Commands

```sh
npm install                     # install all workspaces
npm test                        # @zpcrweb/core Vitest suite
npm run build                   # build the library (ESM + CJS + .d.ts)
npm run typecheck               # typecheck the library
npm run dev -w @zpcrweb/web     # web dev server → http://localhost:5173
npm run build -w @zpcrweb/web   # web production build (typechecks first)
```
