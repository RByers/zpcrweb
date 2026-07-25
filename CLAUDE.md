# CLAUDE.md

## Git workflow

**No pull requests in this repo.** Work is committed directly to the trunk branch and pushed
to the `origin` GitHub remote (`git@github.com:RByers/zpcrweb.git`).

- The trunk branch here is named **`main`** (not `master`) — it is the only branch pushed
  upstream.
- Merge feature/worktree branches into `main` locally, then `git push origin main`.
- Don't open PRs, and don't push side branches upstream.

## Format documentation

The reverse-engineered binary format docs are the reference for anything in
`packages/core/src` that touches raw bytes — read them before changing a decoder:

| Doc | Covers |
|-----|--------|
| [`icff.md`](./icff.md) | "ICFF" — the small index container format underlying both `.Plateread` and `.Dcal`: a trailing footer points at an index of `[name, offset, length]` entries. Implemented by `packages/core/src/icff.ts`; locate the index via the footer, not by scanning for a known field name. |
| [`plateread.md`](./plateread.md) | The `.Plateread` files inside a `.zpcr` — one per plate read (PCR cycle), holding the 6-channel × 108-well raw fluorescence table plus cycle number, block temperature and timestamp. **Mixed endianness:** metadata (version words, ICFF index) is big-endian; the WELLDATA/DARKDATA float arrays are little-endian. Implemented by `packages/core/src/plateread.ts`. |
| [`dcal.md`](./dcal.md) | The `.Dcal` pure-dye calibration files — per-dye, per-plate-type fluorescence response across all 6 channels at 4 block temperatures, plus a matching empty-plate baseline; the only in-archive source of the channel→dye mapping (`PRIMARYCHANNEL`). Unencrypted ICFF container. Implemented by `packages/core/src/dcal.ts`, entry point `parseDcal(bytes)`; `zpcr.calibrations()` decodes every `.Dcal` entry in an archive. |
| [`pltd.md`](./pltd.md) | The `.pltd` plate-definition files — per-well fluorophores, target/gene, sample name and type, replicate, standard quantity. Encrypted + compressed XML container. Implemented by `packages/core/src/pltd.ts`, entry point `parsePltd(bytes)`; `zpcr.plates()` decodes every plate in an archive. |
| [`pcrd.md`](./pcrd.md) | The `.pcrd` saved-experiment files — CFX Manager's single-file XML document collapsing a whole run (plate setup, protocol, all plate reads, analysis/UI state) into one archive. Same container as `.pltd`. |
| [`zipcrypto.md`](./zipcrypto.md) | The single-entry ZipCrypto-encrypted ZIP container shared by `.pltd`/`.prcl` and `.pcrd`: container variants, the fixed shared password, and the decrypt → inflate pipeline. Implemented by `packages/core/src/zipcrypto.ts` + `inflate.ts`. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Project-level design: isomorphic library goals, monorepo layout, input strategy. |
| [`apps/web/ARCHITECTURE.md`](./apps/web/ARCHITECTURE.md) | Web app design notes. |

All format docs are marked **fully decoded** and validated against the committed samples in
`samples/`. If a decoder changes, update the corresponding doc in the same commit.

## Commands

```sh
npm install                     # install all workspaces
npm test                        # @zpcrweb/core Vitest suite
npm run build                   # build the library (ESM + CJS + .d.ts)
npm run typecheck               # typecheck the library
npm run dev -w @zpcrweb/web     # web dev server → http://localhost:5173
npm run build -w @zpcrweb/web   # web production build (typechecks first)
```
