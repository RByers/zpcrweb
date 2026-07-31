# zpcrweb 

zpcrweb (pronounced Zed-PCR web 🇨🇦) is a set of tools for reading and analyzed **[Bio-Rad CFX](https://www.bio-rad.com/en-ca/product/cfx96-system?ID=OK1G048UU)** qPCR `.zpcr` files. It contains an isomorphic TypeScript library plus a cyberpunk-dark web app built on top of it.

Access it at [https://zpcr.rbyers.ca](https://zpcr.rbyers.ca/).

I built this because:
 - I just bought a used CFX thermocycler for my [home lab](https://lab.rbyers.ca/) and didn't have $2,800 extra budget for CFX Maestro.
 - I'd rather not buy a dedicated Windows machine and install drivers (I mostly use a Mac). 
 - I prefer to really learn how the device works under the hood and want to customize my workflow with automation anyway.

 However this application is nowhere near a complete replacement for CFX Master / Maestro, lots of features are missing and the analysis is likely less reliable and more error-prone. Use at your own risk! On the upside, it is highly hackable, feel free to fork, modify, file issues and submit PRs if you like. All code is written by AI agents and not necessarily human-reviewed, so there's likely some slop.

 ## File formats

A `.zpcr` file is a ZIP archive written by a Bio-Rad CFX real-time PCR instrument. Inside it
holds one `.Plateread` binary file per PCR cycle (the raw fluorescence readings), a
`RunInfo.xml` metadata file, the run protocol/log, and per-dye calibration files. This
project decodes those files into well-typed data you can use from Node or the browser.

The `.Plateread` binary format was reverse-engineered and is documented in
[`plateread.md`](./plateread.md).

There is also limited support for `.pltd` and `.pcrd` files as produced by CFX software, but they are [encrypted](zipcrypto.md) and this repo does not include the key (DMCA compliance). However you can easily exact the key from a copy a CFX Master using an AI agent like Claude code.

To minimize the hassle of working with encrypted plate definition files, this package define a simple `.plt.csv` file format for plates which can be exported, modified and imported back and linked into a `.zpcr` file. 

The app also opens **Biomeme run exports** (`.json`, from the Franklin/Two3/Three9 handheld
devices) — a genuinely different instrument (a handful of tube positions, fluorescence
reported directly per dye rather than per optical channel) that shares no bytes with a CFX
`.zpcr`/`.pcrd`, but is decoded into the same `Zpcr` shape (see `biomeme.ts` and
`ARCHITECTURE.md`'s "Three input formats"), so it opens in the same Curves view. Unlike a
CFX file, a Biomeme export carries the device's own baseline and Cq for every curve; the
Curves view offers a File ↔ Computed toggle for both, defaulting to the file's own numbers.

## Repository layout

This is an npm-workspaces monorepo:

| Path | What |
|------|------|
| `packages/core` | `@zpcrweb/core` — the isomorphic parsing library |
| `apps/web` | `@zpcrweb/web` — the React web app ([architecture](./apps/web/ARCHITECTURE.md)) |
| `samples/` | a committed sample `.zpcr` used by the test suite |

## `@zpcrweb/core`

### What it does today

- Decompresses a `.zpcr` archive in memory (via [`fflate`](https://github.com/101arrowz/fflate)).
- Decodes every `.Plateread` file into the full 6-channel × 108-well fluorescence table
  (mean / std / min / max per well), plus cycle number, protocol step, timestamp, and
  **every temperature the file carries** (block, ambient, shuttle, sample, lid, and the fan
  set points) — extracted generically from the file's own schema, not a fixed list.
- Parses `RunInfo.xml` into typed run metadata (grid size, scan mask → channel count,
  serials, start time, …), with the full raw key/value map preserved.
- Pivots the per-cycle data into **well-centric amplification curves** ready to plot.
- Exposes a **low-level archive API** (`entries`, `bytes`, `text`, `hexDump`) so any file —
  even ones we don't fully parse yet — can be inspected.

### Quick start

**Node** — read a file from disk:

```ts
import { zpcrFromFile } from "@zpcrweb/core";

const zpcr = await zpcrFromFile("20260720_FirstQualification.zpcr");
console.log(zpcr.metadata.baseSerialNumber);   // "CT019138"
console.log(zpcr.reads.length);                // 45

// well 3A (row A=0, col 3→index 2) on channel 2, last cycle
console.log(zpcr.reads.at(-1)!.wells[2]![0]![2]!.mean); // ~6852

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
| `Zpcr.reads` | Ordered `PlateRead[]` (one per cycle) with `.wells[channel][row][col]` |
| `Zpcr.curves(opts)` | Well-centric `WellCurve[]` amplification curves |
| `Zpcr.darkCurves(step)` | Per-channel dark (LED-off) background across cycles |
| `Zpcr.temperatureCurves(step)` | Per-field `TemperatureCurve[]` (°C per cycle) |
| `Zpcr.ledCurves(step)` | Per-channel `LedCurve[]` — LED drive current (DAC counts per cycle) |
| `Zpcr.archive` | Low-level `entries` / `bytes` / `text` / `hexDump` access |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for design details and
[`packages/core/src/types.ts`](./packages/core/src/types.ts) for the full typed surface.

## `@zpcrweb/web`

A React + Vite web app for exploring `.zpcr`/`.pcrd`/Biomeme `.json` files, in a
cyberpunk-dark theme. Drag-and-drop or click to load multiple files, switch between them, and
view each several ways:

- **Overview** — run metadata and thermal protocol.
- **Curves** — amplification curves for up to ~648 well/channel series (uPlot), with a
  channel bar and an 8×12 well matrix (row/column headers toggle whole rows/columns), Raw ↔
  ΔRFU baselining, Linear ↔ Log scale, and a hover/tap tooltip showing mean/min/max/std.
- **Raw files** — a hex/ASCII (and text) viewer over every file in the archive.

Loaded files and each file's view settings persist in **IndexedDB** across reloads; files
can be deleted from storage from the file bar. Non-trivial logic lives in `@zpcrweb/core` —
see the [web architecture notes](./apps/web/ARCHITECTURE.md).

```sh
npm run dev -w @zpcrweb/web      # start the dev server (http://localhost:5173)
npm run build -w @zpcrweb/web    # production build
```

## Development

```sh
npm install                 # install all workspaces
npm test                    # run the @zpcrweb/core Vitest suite
npm run build               # build the library (ESM + CJS + .d.ts)
npm run typecheck           # typecheck the library
npm run dev -w @zpcrweb/web  # run the web app
```
