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
| [`plateread.md`](./plateread.md) | The `.Plateread` files inside a `.zpcr` — one per plate read (PCR cycle), holding the 6-channel × 108-well raw fluorescence table plus cycle number, block temperature and timestamp. **Mixed endianness:** metadata (version words, scalar header, trailing descriptor dictionary) is big-endian; the WELLDATA/DARKDATA float arrays are little-endian. The trailing descriptor dictionary makes the file self-describing — decode via declared offsets, with hardcoded offsets only as fallback. Implemented by `packages/core/src/plateread.ts`. |
| [`pltd.md`](./pltd.md) | The `.pltd` plate-definition files — per-well fluorophores, target/gene, sample name and type, replicate, standard quantity. Encrypted + compressed XML container. Implemented by `packages/core/src/pltd.ts`, entry point `parsePltd(bytes)`; `zpcr.plates()` decodes every plate in an archive. |
| [`pcrd.md`](./pcrd.md) | The `.pcrd` CFX Manager saved-experiment file — the whole run (plate setup, protocol, every plate read, `RunInfo`/`runlog`, plus analysis/UI state) as one large XML document, in the same encrypted-ZIP container as `.pltd`/`.prcl`. Implemented by `packages/core/src/pcrd.ts`, entry point `parsePcrd(bytes)`, which decodes into the same `Zpcr` shape `parseZpcr` produces. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Project-level design: isomorphic library goals, monorepo layout, input strategy. |
| [`apps/web/ARCHITECTURE.md`](./apps/web/ARCHITECTURE.md) | Web app design notes. |

`plateread.md` and `pltd.md` are marked **fully decoded** and validated against the committed
samples in `samples/`. `pcrd.md`'s container and plate-read data are likewise fully decoded
and cross-validated bit-for-bit against the matching `.zpcr`; its analysis-state subtrees
(`dataAnalysisParameters`, `PersistedData`, …) are mapped but not yet interpreted. If a
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
