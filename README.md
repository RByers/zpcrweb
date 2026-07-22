# zpcrweb

Tools for reading **Bio-Rad CFX** qPCR `.zpcr` files — an isomorphic TypeScript library plus
a web app (in progress) built on top of it.

A `.zpcr` file is a ZIP archive written by a Bio-Rad CFX real-time PCR instrument. Inside it
holds one `.Plateread` binary file per PCR cycle (the raw fluorescence readings), a
`RunInfo.xml` metadata file, the run protocol/log, and per-dye calibration files. This
project decodes those files into well-typed data you can use from Node or the browser.

The `.Plateread` binary format was reverse-engineered and is documented in
[`plateread.md`](./plateread.md).

## Repository layout

This is an npm-workspaces monorepo:

| Path | What |
|------|------|
| `packages/core` | `@zpcrweb/core` — the isomorphic parsing library |
| `apps/web` | the web app (scaffold; see [`TODO.md`](./TODO.md)) |
| `samples/` | a committed sample `.zpcr` used by the test suite |

## `@zpcrweb/core`

### What it does today

- Decompresses a `.zpcr` archive in memory (via [`fflate`](https://github.com/101arrowz/fflate)).
- Decodes every `.Plateread` file into the full 6-channel × 108-well fluorescence table
  (mean / std / min / max per well), plus cycle number, block temperature, and timestamp.
- Parses `RunInfo.xml` into typed run metadata (grid size, scan mask → channel count,
  serials, start time, …), with the full raw key/value map preserved.
- Pivots the per-cycle data into **well-centric amplification curves** ready to plot.
- Exposes a **low-level archive API** (`entries`, `bytes`, `text`, `hexDump`) so any file —
  even ones we don't fully parse yet — can be inspected.

### Quick start

**Node** — read a file from disk:

```ts
import { zpcrFromFile } from "@zpcrweb/core";

const zpcr = await zpcrFromFile("20260720.zpcr");
console.log(zpcr.metadata.baseSerialNumber);   // "CT019138"
console.log(zpcr.reads.length);                // 45

// well 3A (row A=0, col 3→index 2) on channel 2, last cycle
console.log(zpcr.reads.at(-1)!.get(2, 0, 2).mean); // ~6852

// amplification curve for that well
const [curve] = zpcr.curves({ channel: 2 }).filter((c) => c.wellLabel === "A3");
console.log(curve.cycles, curve.mean);
```

**Browser** — parse an uploaded file:

```ts
import { parseZpcr, zpcrFromBlob } from "@zpcrweb/core";

const file = input.files[0];
const zpcr = await zpcrFromBlob(file);
// or: const zpcr = parseZpcr(await file.arrayBuffer());
```

### API overview

| Export | Purpose |
|--------|---------|
| `parseZpcr(data)` | Parse raw bytes (`Uint8Array` \| `ArrayBuffer`) → `Zpcr` |
| `zpcrFromFile(path)` | Node convenience: read + parse a file from disk |
| `zpcrFromBlob(blob)` | Browser convenience: read + parse a `Blob`/`File` |
| `Zpcr.metadata` | Typed `RunMetadata` from `RunInfo.xml` |
| `Zpcr.reads` | Ordered `PlateRead[]` (one per cycle) with `.get(channel,row,col)` |
| `Zpcr.curves(opts)` | Well-centric `WellCurve[]` amplification curves |
| `Zpcr.archive` | Low-level `entries` / `bytes` / `text` / `hexDump` access |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for design details and
[`packages/core/src/types.ts`](./packages/core/src/types.ts) for the full typed surface.

## Development

```sh
npm install                 # install all workspaces
npm test                    # run the @zpcrweb/core Vitest suite
npm run build               # build ESM + CJS + .d.ts
npm run typecheck           # tsc --noEmit
```

## License

MIT
