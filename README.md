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

To minimize the hassle of working with encrypted plate definition files, this package define a simple `.plt.csv` file format for plates which can be exported, modified and imported back and linked into a `.zpcr` file, documented in [`pltcsv.md`](./pltcsv.md). 

A standalone **`.alf` run report** opens as a file in its own right too. That is what a protocol
with no `PLATEREAD` — an incubation, a reverse-transcription hold — produces: the instrument keeps
no run folder for one (`usb.md` §7.10), so there is no `.zpcr` to make, and the report is the whole
record of the run. Such a protocol is startable straight from a `.prcl.txt` in the Instrument view,
and its report lands in the file bar when it finishes.

The app also opens **Biomeme run exports** (`.bmrun`, from the Franklin/Two3/Three9 handheld
devices) — a genuinely different instrument (a handful of tube positions, fluorescence
reported directly per dye rather than per optical channel) that shares no bytes with a CFX
`.zpcr`/`.pcrd`, but is decoded into the same `Zpcr` shape (see `biomeme.ts` and
`ARCHITECTURE.md`'s "Three input formats"), so it opens in the same Curves view. Unlike a
CFX file, a Biomeme export carries the device's own baseline and Cq for every curve; the
Curves view offers a File ↔ Computed toggle for both, defaulting to the file's own numbers.

### Format documentation

The reverse-engineered binary format docs are the reference for anything in
`packages/core/src` that touches raw bytes. There's also one algorithm doc,
`calibration.md`, for the color-separation math built on top of `.Dcal`, and `threshold.md`
for baseline/threshold/Cq.

| Doc | Covers |
|-----|--------|
| [`icff.md`](./icff.md) | "ICFF" — the small index container format underlying both `.Plateread` and `.Dcal`: a trailing footer points at an index of `[name, offset, length]` entries. Implemented by `packages/core/src/icff.ts`; locate the index via the footer, not by scanning for a known field name. |
| [`plateread.md`](./plateread.md) | The `.Plateread` files inside a `.zpcr` — one per plate read (PCR cycle), holding the 6-channel × 108-well raw fluorescence table plus cycle number, block temperature and timestamp. **Mixed endianness:** metadata (version words, ICFF index) is big-endian; the WELLDATA/DARKDATA float arrays are little-endian. Implemented by `packages/core/src/plateread.ts`. |
| [`alf.md`](./alf.md) | The `.alf` run report the instrument writes at the end of every run — carried inside every `.zpcr` and fetchable over USB (`usb.md` §5.2). A `*`-delimited text file: run identity, the protocol as executed, an error summary, and one line per executed step with its setpoint, nominal hold and the wall-clock time that step began. Its error line is a *one-way* signal: an aborted run's report is byte-identical in shape to a completed one's (§6). The only per-step timing record the instrument produces, and 1:1 with the archive's `.Plateread` files. Implemented by `packages/core/src/alf.ts`, entry point `parseAlf(bytes)`; `zpcr.runReports()` decodes every `.alf` entry in an archive, and `alfThermalProfile()` (§7.6) turns one into the run's block-temperature-against-time trace — ramp and hold split apart per step — which the app plots under a run's Protocol tab. |
| [`dcal.md`](./dcal.md) | The `.Dcal` pure-dye calibration files — per-dye, per-plate-type fluorescence response across all 6 channels at 4 block temperatures, plus a matching empty-plate baseline; the only in-archive source of the channel→dye mapping (`PRIMARYCHANNEL`). Unencrypted ICFF container. Implemented by `packages/core/src/dcal.ts`, entry point `parseDcal(bytes)`; `zpcr.calibrations()` decodes every `.Dcal` entry in an archive. |
| [`calibration.md`](./calibration.md) | Channel→dye color separation — the algorithm that turns raw per-channel readings plus `.Dcal` calibration data into per-dye concentration estimates. Not a file format doc. Implemented by `packages/core/src/calibration.ts` (linear algebra in `linalg.ts`), entry points `separateDyes()` (one-shot) and the individual `buildDyeResponseCurve`/`buildCalibrationMatrix`/`preprocessChannelReadings`/`separateChannels` stages. |
| [`threshold.md`](./threshold.md) | Baseline, threshold and Cq — how a per-dye amplification curve becomes a quantification cycle, or a reported non-amplification: baseline region selection, subtraction, threshold determination, the crossing rule, end-point RFU, and the app's controls over them. Not a file format doc. §1 states the problem; §3–§7 are the shipped algorithm, implemented by `packages/core/src/baseline.ts` (§3–§4, §7), `packages/core/src/threshold.ts` (§5–§6, entry point `computeCq()`) and `packages/core/src/analysis.ts` (`computeCqTable()`, the per-run entry point); §10 separates what is deliberately unimplemented from what is still unknown. **Appendix A is the measurement against CFX Manager's own exported results** for a committed sample — the Cq stage exactly (`packages/core/test/cfxExport.test.ts`), the baseline stage to within a cycle of window; Appendix B records the alternatives tried and how noisy curves broke them. |
| [`pltd.md`](./pltd.md) | The `.pltd` plate-definition files — per-well fluorophores, target/gene, sample name and type, replicate, standard quantity. Encrypted + compressed XML container. Implemented by `packages/core/src/pltd.ts`, entry point `parsePltd(bytes)`; `zpcr.plates()` decodes every plate in an archive. |
| [`protocol.md`](./protocol.md) | The thermal-protocol language — every directive (`METHOD`, `HOTLID`, `TEMP`, `GRAD`, `MELT`, `INC`, `RATE`, `EXT`, `BEEP`, `PLATEREAD`, `GOTO`, …), what the instrument does with it, the 1-based step numbering `GOTO` counts in — steps count, **modifiers don't** — the `PLATEREAD` scan mask, the melt-curve idiom (§6) and how a protocol is typed at the instrument over USB (§7). Not a file format doc: it is the semantics shared by five carriers of the same text — `.prcl`/`.pcrd`'s `runDefinition`, a `.zpcr`'s `ProtocolRunDefinition.txt` and its `.alf` run report, `.prcl.txt`, and the USB command channel — whose differences §8 tabulates. Every rule is marked **measured** or **stated**; §9 collects what is still unknown, §10 is the editable form of the same language, and Appendix A is the step-numbering measurement, from the `.alf` execution log and live `STATUS?`. Implemented by `packages/core/src/runDefinition.ts`, entry point `parseRunDefinition()` (reading) and `packages/core/src/protocolBuilder.ts`, entry point `ProtocolBuilder` (writing — §10). |
| [`prcl.md`](./prcl.md) | The `.prcl` thermal-cycling protocol files — lid/volume settings plus the ordered step list (hold, gradient, melt, goto, plate read), in the same encrypted-ZIP container as `.pltd`/`.pcrd`. The same `protocol2` XML document `.pcrd` embeds. Implemented by `packages/core/src/prcl.ts`, entry point `parsePrcl(bytes)`; `parseProtocol2()` is reused by `pcrd.ts`; `zpcr.protocols()` decodes every `.prcl` entry in an archive. §3.1 documents `.prcl.txt`, this project's own line-per-directive text form (`formatRunDefinitionText`/`parseRunDefinitionText`) — the one representation here that isn't reverse-engineered. |
| [`pcrd.md`](./pcrd.md) | The `.pcrd` CFX Manager saved-experiment file — the whole run (plate setup, protocol, every plate read, `RunInfo`/`runlog`, plus analysis/UI state) as one large XML document, in the same encrypted-ZIP container as `.pltd`/`.prcl`. Implemented by `packages/core/src/pcrd.ts`, entry point `parsePcrd(bytes)`, which decodes into the same `Zpcr` shape `parseZpcr` produces. |
| [`zipcrypto.md`](./zipcrypto.md) | The single-entry ZipCrypto-encrypted ZIP container shared by `.pltd`/`.prcl` and `.pcrd`: container variants, the fixed shared password, and the decrypt → inflate pipeline. Implemented by `packages/core/src/zipcrypto.ts` + `inflate.ts`. |
| [`zpcrweb-json.md`](./zpcrweb-json.md) | `zpcrweb.json` — the one entry this project *writes* into a `.zpcr`, holding the run's analysis parameters (thresholds, the auto-threshold multiplier, calibration normalization) so they travel with the file instead of sitting in one browser's IndexedDB — plus §1.1's `experimentName`, what the run is *called*, which no CFX format has a field for. Not reverse-engineered. Implemented by `packages/core/src/zpcrwebSettings.ts` (+ `experiment.ts` for the name's resolution and filename derivation); the app side is `apps/web/src/state/analysisSettings.ts` + `analysisPersist.ts`. |
| [`pltcsv.md`](./pltcsv.md) | `.plt.csv` — this project's own plain-text plate format, a `.pltd` substitute since there's no encrypted-`.pltd` writer: one `# key: value` header block plus one CSV row per well, fluor columns labelled by dye name. Not reverse-engineered, not a CFX format. Implemented by `packages/core/src/plateCsv.ts`, entry points `plateToCsv`/`parsePlateCsv`; `zpcr.ts`'s `plates()` reads a `.plt.csv` archive entry exactly like a `.pltd` one, and `attachPlate.ts` writes one in. |
| [`biomeme.md`](./biomeme.md) | `.bmrun` — a Biomeme handheld device (Franklin/Two3/Three9) run export — the third input format, not a Bio-Rad format at all: no optical channels to unmix (fluorescence is per-dye already), and the device carries its own baseline/threshold/Cq alongside this library's. Self-describing JSON, not reverse-engineered. Implemented by `packages/core/src/biomeme.ts`, entry point `parseBiomeme(bytes)`, which decodes into the same `Zpcr` shape `parseZpcr`/`parsePcrd` produce. |
| [`usb.md`](./usb.md) | The CFX96/C1000 instrument's own USB control protocol — not a file format: enumeration, the 5-byte application-layer frame, the ASCII command channel, the file upload/download mechanism a run is loaded and read back through, and (§7) the complete start-to-finish sequence of commands a run is made of, including **§7.8 stopping a run in progress** (measured against a live abort — a `CANCEL` sent in the ~6 s start window is accepted and ignored, and the abort is recorded *only* in the status register, never in the run's files) and **§7.9 pausing**. Reverse-engineered from USB captures (decoded with `tools/usbpcap_decode.py`), then implemented and driven against live hardware — §10 lists what the instrument corrected. Implemented by `packages/core/src/usb/`, entry point `CfxDevice`; driven by `tools/cfx.mjs` and the web app's Instrument view, which starts runs and follows them as they go. |
| [`usb-traffic.md`](./usb-traffic.md) | `usb-traffic.bin` — the USB traffic log the Instrument view records for a run it drove itself, and the second entry this project *writes* into a `.zpcr`. Compact binary records (payload bytes plus the three facts about a message that aren't in them) rather than the text they render to: 5.4× smaller stored and ~40× smaller once zipped, which is what makes attaching a session's whole wire log to a run cost single-digit KB. Not reverse-engineered. Implemented by `packages/core/src/usbTraffic.ts` — `UsbTrafficRecorder` writes, `parseUsbTrafficLog` reads, `formatUsbTrafficLog` renders the one text form there is; the app side is `apps/web/src/state/useCfxDevice.ts` (always recording) and the console's "save log" switch (whether the run's file keeps it). |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Project-level design: isomorphic library goals, monorepo layout, input strategy. |
| [`apps/web/ARCHITECTURE.md`](./apps/web/ARCHITECTURE.md) | Web app design notes. |

`icff.md`, `plateread.md`, `dcal.md`, `pltd.md`, and `prcl.md` are marked **fully decoded** and
validated against the committed samples in `samples/`. The last of these to be interpreted was the
`PLATEREAD` operand — a scan mask, decoded in `usb.md` §3.1. `pcrd.md`'s container, plate-read
data, and `calibrationCollection` are likewise fully decoded and cross-validated bit-for-bit
against the matching `.zpcr`; `wellFactorsCollection` is decoded too (it is the only source of the
per-well gain factors `calibration.md` §4.1 needs), and the remaining analysis-state subtrees
(`dataAnalysisParameters`, `PersistedData`, …) are mapped but not yet interpreted.

## Repository layout

This is an npm-workspaces monorepo:

| Path | What |
|------|------|
| `packages/core` | `@zpcrweb/core` — the isomorphic parsing library |
| `apps/web` | `@zpcrweb/web` — the React web app ([architecture](./apps/web/ARCHITECTURE.md)) |
| `samples/` | a committed sample `.zpcr` used by the test suite |
| `tools/` | standalone CLIs and browser-automation scripts ([index](./tools/README.md)) |

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
- Decodes the `.alf` **run report** — the instrument's own log of what actually ran, one record
  per executed step, with the wall-clock time it began (and, derived from that, how long it took).
- Recognises a run that **stopped short** — `runCompleteness()` counts the plate reads the
  protocol's own `GOTO` loops imply and compares them with what the archive holds. A cancelled run
  is marked as cancelled nowhere in its files (see `usb.md` §7.8), so the read count is the only
  evidence there is.
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
| `Zpcr.runReports()` | The archive's `.alf` run reports — the instrument's own per-step execution log |
| `runCompleteness(zpcr)` | Did the run finish its protocol? Expected vs. actual plate reads |
| `Zpcr.archive` | Low-level `entries` / `bytes` / `text` / `hexDump` access |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for design details and
[`packages/core/src/types.ts`](./packages/core/src/types.ts) for the full typed surface.

## `@zpcrweb/web`

A React + Vite web app for exploring `.zpcr`/`.pcrd`/Biomeme `.bmrun` files, in a
cyberpunk-dark theme. Drag-and-drop or click to load multiple files, switch between them, and
view each several ways:

- **Overview** — run metadata and thermal protocol.
- **Curves** — amplification curves for up to ~648 well/channel series (uPlot), with a
  channel bar and an 8×12 well matrix (row/column headers toggle whole rows/columns), Raw ↔
  ΔRFU baselining, Linear ↔ Log scale, and a hover/tap tooltip showing mean/min/max/std.
- **Raw files** — a hex/ASCII (and text) viewer over every file in the archive.

Files persist in **IndexedDB** across reloads, along with which of them were loaded and — for those
— their view settings; files can be deleted from storage from the file bar. Everything that changes
a reported number is written into the run's own file instead, so it travels with it. Non-trivial logic lives in `@zpcrweb/core` —
see the [web architecture notes](./apps/web/ARCHITECTURE.md).

### Working in a folder on your disk

The load button also offers **Add folder…**, which hands the app a directory and gets you out of the
upload/download loop entirely. A file opened from that folder is read straight off your disk and
written back to the same file when you change something — rename a run, drag a threshold — so there
is no second copy in the browser to go stale, and nothing to remember to download. Change a file in
another program and the app picks it up and refreshes on its own. Nothing in the folder is ever
deleted by the app: removing a file from the app, or the folder itself, only forgets it.

The **Files** tab splits in two, scrolling independently: what this browser is holding on top, your
folders underneath. Each folder shows its directory tree next to the files of whichever directory
you've picked — one above the other if the window is narrow — and reads one directory at a time as
you open it, so pointing the app at a folder holding years of runs costs nothing until you go
looking. Newly-added files show up when you reopen the tab or press the folder's ↻.

Two limits worth knowing. Browsers don't tell a web page where a folder actually is, only what it's
called, so files are named by their path *within* the folder (`runs/2026-07/a.zpcr`) rather than by
a full disk path — and renaming one has to be done on disk, not in the app. And a run being recorded
live from an instrument is buffered in the browser until it finishes, then written to disk once,
rather than rewriting the whole archive after every cycle.

This needs the File System Access API, so it's Chromium-only today; the option simply isn't shown
where it's unavailable.

```sh
npm run dev -w @zpcrweb/web      # start the dev server (http://localhost:5173)
npm run build -w @zpcrweb/web    # production build
```

### Browser support

The app is written against standard web APIs and intended to work on the latest version of any
major browser. In practice, development and manual testing happen almost entirely on
Chromium-based browsers (Chrome/Edge/etc.) — partly because the Instrument view's live USB
connection depends on WebUSB, and the disk-folder support above on the File System Access API,
neither of which anyone but Chromium implements, and partly just because that's
where the author tests. On first load, a non-Chromium browser gets a one-time dismissable
warning to that effect (`components/BrowserWarningModal.tsx`); everything except the Instrument
view is expected to work fine regardless.

### Everything is in the URL hash, nothing in the query string

- `#file=<name>&view=<overview|protocol|curves|plates|reference|calibration|raw|instrument|files|about>`
  selects the active file and view. Every view the app can show is nameable here: `files` is the
  full files table, `instrument` the USB panel, and `about` the credits page behind the logo —
  the last of these has no tab, and none of the three needs a file.
- `#load=<url>` fetches a file and loads it — the only key that can put a file the browser doesn't
  already have into the app. It's consumed on load and replaced by the `#file=` the loaded file
  produces, so it never survives in the address bar. `apps/web/public/examples/` (a symlink to
  `samples/`) is what the welcome screen's "Load an example file" button loads, via this key.
- `#cfxPassword=<value>` seeds the decryption password so encrypted files decrypt instead of
  sitting behind the prompt. URL-escape it — the password can contain characters like `#`.

All are hash keys in one query string (`#cfxPassword=…&view=curves`), parsed by
`state/pltdPassword.ts` and `state/urlHash.ts`. **The password is in the fragment because it's a
secret**: fragments are never sent to the server, so they can't reach access logs, proxies, or a
`Referer` header — `?cfxPassword=` would reach all three. The app strips the password from the
address bar the moment it reads it, so a URL copied afterwards can be shared safely. The legacy
`?cfxPassword=` query form still works but is deprecated; don't write new links with it.

## Tools

Standalone scripts in [`tools/`](./tools/README.md) — a CLI for the results table and for setting
up a run, live-instrument access over USB, and browser-automation checks for the web app:

```sh
node tools/zpcr.mjs samples/20260720_FirstQualification.zpcr results   # results table as CSV
node tools/zpcr.mjs samples/20260720_FirstQualification.zpcr curves \
  --wells B3 -o b3.png                                                 # curves as a PNG
node tools/zpcr.mjs 20260810_RVP.zpcr new --name "S190 RVP" \
  --protocol Luna_qPCR.prcl.txt --plate S190.plt.csv                   # a new experiment
node tools/cfx.mjs info                                                # talk to a live instrument
node tools/uishot.mjs                                                  # screenshot the web app
```

`zpcr.mjs new` writes a **pending experiment**: a `.zpcr` holding the protocol, the experiment's
name and (optionally) the plate, with no plate reads in it yet. That is exactly what the web app's
"New experiment" creates, so the file opens there as a run waiting to be started — edit the
protocol in place if you like, then start it from the Instrument view. `--plate` may be left out
and attached later; `--force` overwrites an existing file, which the command otherwise refuses to
do.

See [`tools/README.md`](./tools/README.md) for what each script does; `zpcr.mjs`/`cfx.mjs` need a
built core first (`npm run build`).

## Development

```sh
npm install                     # install all workspaces
npm test                        # @zpcrweb/core Vitest suite
npm run build                   # build the library (ESM + CJS + .d.ts)
npm run typecheck               # typecheck the library (core only)
npm run typecheck -w @zpcrweb/web   # typecheck the web app
npm run dev -w @zpcrweb/web     # web dev server → http://localhost:5173
                                # hot-reloads packages/core edits too (aliased to src, no tsup watch)
npm run build -w @zpcrweb/web   # web production build (typechecks first)
npm run test:ui                 # browser assertions (needs Chrome, ~35s; not part of npm test)
```

Local-only secrets (the CFX file decryption password) live in `secrets.json`, which is gitignored
and never committed — `{ "cfxPassword": "…" }`. Tests load it via `packages/core/test/secrets.ts`;
only tests that explicitly exercise the decryption pipeline need it (`describe.skipIf(!PW)`
blocks) — everything else runs against the plaintext samples committed in `samples/`, where each
encrypted sample's decrypted payload sits beside it as `<name>.xml`, so the structural tests never
touch the crypto.

### UI tooling

Two scripts drive a headless Chrome against the app, for two different jobs. They share
`tools/harness.mjs` (the CDP client and dev-server/Chrome plumbing), boot their own dev server and
browser on random ports (so they never collide with a server running on 5173), and load a sample
through the app's own file input.

**`tools/uishot.mjs` — look at it.** One command, ~5s:

```sh
node tools/uishot.mjs                                    # Overview + Curves, default sample
node tools/uishot.mjs --views curves                     # one view, biggest and most legible
node tools/uishot.mjs --views overview,curves,plates,raw # four views in one sheet
node tools/uishot.mjs --file samples/20260720_Luna_noRT.pcrd --views overview
```

It walks the requested views and writes **one labelled contact-sheet PNG** —
`tools/.uishot/shot.png` by default — tiling the views into a single image. It also reports
console errors, uncaught exceptions and failed page loads, which catch breakage a screenshot
can't show.

**`tools/uitest.mjs` (`npm run test:ui`) — assert it.** 242 browser assertions covering what
nothing else can catch: the two URL contracts — hash routing (deep links, back/forward,
unknown-file and invalid-view fallbacks) and password handling (stripped from both URL forms,
never leaked into the routing hash, an encrypted `.pcrd` still decrypting) — plus `#load=`, the
rule that every XML view uses the shared collapsible tree rather than a flat dump, the chart's
one-right-axis invariant (temperatures and LED currents can never both be on), the Calibration
view's default selection (only the run's in-use `.Dcal` files of the 28 it ships, the rest a click
away), and the rail chips' shared interaction contract (double-click solos, hovering a disabled
chip peeks at it only while hovered — including the Wells grid's row and column headers, which
peek at the whole row/column) plus the Reference view's overlay toggles and x-axis modes —
including that hiding the factory line doesn't break the ΔRFU baseline computed from the same
values, and that its min/max bands draw under that baseline but drop out (with a note) on the
column axis, where a point is a run mean with no spread of its own — and the Curves table's sort
contract (a header click re-orders, a second reverses, Well sorts by plate position rather than
label text, wells with no Cq stay at the bottom in both directions) and its Cq axis (every marker
at its own cycle, an empty axis where there is no Cq) and its End RFU column (sorts numerically,
and is a number of its own rather than a copy of ΔRFU) — and the rail's Cq range filter, whose top
stop is where the curves with no Cq live (an upper bound drops them, the *lower* handle parked
there leaves only them, and the handles clamp instead of crossing) — and that a `.pcrd` carrying a
hand-set threshold seeds it as a per-fluorophore override while a dye the file left on auto is
left alone (`threshold.md` §5.3: that one value is what makes the app reproduce CFX's own Cq) —
and the Overview tab's `.prcl.txt` download plus the Instrument view, which starts the **one
experiment** the file bar has selected (the bar meaning the same single selection it means
everywhere else) — a run that already holds results is refused a start and offered a clone instead,
Start appears only with an instrument attached, no name is collected on that tab at all, and the
protocol shown is the directives alone: the plain-English reading of each one belongs to the
Protocol tab, which is where it is asserted, save the `PLATEREAD` scan mask, whose channels and
sweep mode are a packed byte the text can't show and so stay on a sub-line of their own —
and the **pending experiment** flow both ways in: cloning a run yields a new file with the protocol
and plate and none of the results, under a bare-date name, with its experiment-name field required
and focused, and naming it renames the file to the `<date>-<name>` convention; "New experiment"
yields the same thing with neither half, offering Overview and Protocol (the latter an editor even
with nothing in it) but not the tabs it has nothing for —
and that a `.prcl.txt` is a document as
well as an input: it enables Overview, Protocol and Raw and nothing else, and its Overview reports
the protocol's own settings from the decode — and how a run is *named*: the file bar shows an
experiment name over a compact local timestamp rather than a file name, derived from the
filename's `<date>_<time>_<serial>_<name>` unless the format states one (Biomeme) or somebody
typed one, and a typed name has to survive a reload, which it can only do by reaching the
archive's own `zpcrweb.json` (clearing it reverts to the derived name rather than blanking it) —
plus a Biomeme run's Raw tab, which is its JSON document in the standalone (no file list) viewer —
and the `.alf` run report's decoded view, whose three most useful columns are things the file
never states: a step's wall-clock duration (differenced timestamps, so a 10 s hold reads as the
~22 s it occupied), its stage, and its plate read's index — which is asserted to be 1:1 with the
archive's own `.Plateread` entries, a claim spanning two file types that nothing else checks —
and the thermal profile that same report implies, plotted under a run's Protocol tab, where the
assertable part is the read numbering: all three numbers on a 3-read run, thinned to what fits on
a 45-read one but never losing the first or the last, and no section at all for a `.pcrd`, which
carries no report to plot — and a run that **never reads the plate at all** (an incubation or an
RT hold, whose protocol carries no `PLATEREAD` and which therefore writes no `.Plateread` files):
it opens on Overview with only Curves, Reference and Calibration greyed out, is not mistaken for a
run that stopped short, and neither view says anything about readings that don't exist —

and what happens when a file with unsaved edits is deleted — an edited file (a rename is enough)
wears a dot and its ✕ arms into a waste bin that takes a second click, Escape disarms it, neither
state widens the chip, the flag survives a reload, and downloading the file puts it back to
deleting on one click — and that the view bar is the *same eight file views* for every file, a tab
the file can't answer being disabled rather than dropped (`ViewBar`'s `enabled` prop), including a
run still behind the password prompt, which greys out every file view rather than dropping the
strip — a claim about two files' headers matching that no single-file check can make — and the
three sets the app rests on: releasing a file leaves its Files-table row intact, still described
from the summary cached in IndexedDB when it was last loaded, and a reload brings back the loaded
set and nothing else — plus the file
chip's icon, whose shape is what the file *is* (core's `fileCategory`, so the two plate encodings
draw alike) while its colour stays the encryption status, two claims a screenshot can only show
one at a time.

A screenshot can't show that the back button works, that a secret reached the address bar, that a
hover put a curve back, or that eight rows are in the right order — and the core Vitest suite has
no DOM.

Agent-facing guidance on when and how to run these — cost control, headless flags, sample loading
— lives in [`AGENTS.md`](./AGENTS.md).
