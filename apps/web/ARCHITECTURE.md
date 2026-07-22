# Web app architecture

The web app (`@zpcrweb/web`) is a browser UI over [`@zpcrweb/core`](../../packages/core). It
loads one or more `.zpcr` files, switches between them, and explores each through three
views: Overview, Curves, and Raw files.

## Stack

- **React 18 + Vite + TypeScript** — SPA, no router (view state is per-file, in the store).
- **uPlot** — canvas charting. Chosen because a run can produce ~648 line series
  (6 channels × 108 wells); uPlot renders that volume smoothly with native log scales and a
  fast cursor, where an SVG library would stutter.
- **IndexedDB** (hand-rolled, no dependency) for persistence.

## Core principle: logic lives in the library, not the app

**All non-trivial data logic is in `@zpcrweb/core`, where it is unit-tested.** The app is a
thin presentation + persistence shell. Concretely:

- Curve derivation and the per-cycle stats (mean/std/min/max) come from `zpcr.curves()`.
- ΔRFU baselining is `deltaBaseline()` from the library — the app never subtracts itself.
- The app only owns view state (which channels/wells are selected, view/baseline/scale
  toggles), rendering, and IndexedDB storage.

Consequence for testing: there are **no app-level tests yet** — coverage rides on the
library's suite. If UI bugs prove frequent we can add Playwright e2e later (tracked in the
root `TODO.md`). Any new analytical transform must be added to the library with tests, not
written inline in a component.

## State & persistence

`state/useZpcrStore.ts` is the single store hook. It holds the list of loaded+parsed files,
the active file id, and a per-file settings map. `state/db.ts` is a minimal IndexedDB
wrapper with two object stores:

- `files` — `{ id, name, size, addedAt, bytes }`; **raw bytes** are stored so files survive
  reloads and are re-parsed with `parseZpcr` on load (fast; the archive is small). `id` is a
  `name:size` key, which also dedupes re-adding the same file.
- `settings` — `{ fileId, view, enabledChannels[], enabledWells[], baseline, scale }`, so
  each file remembers its enabled wells/channels and last view. Writes are debounced.

Deleting a file removes both its `files` and `settings` records and drops it from memory —
exposed as a clear affordance on each file chip.

## Views

- **Overview** — run metadata as stat tiles + the thermal protocol text, read from
  `zpcr.metadata` and `zpcr.archive.text()`.
- **Curves** — the centerpiece (see below).
- **Raw files** — groups `zpcr.archive.entries` (Metadata / Plate reads / Calibration /
  Other) and renders any file via `archive.hexDump()` (hex+ASCII, paginated with "Show
  more") or `archive.text()` for textual files. This makes every file inspectable until
  typed parsers land for the rest.

## Curves view

Data flows `zpcr.curves({ includeReference:false })` → filter by enabled channels+wells →
`lib/uplot/chart.ts` builds uPlot data/options → `CurveChart` renders + overlays a tooltip.

- **Selection:** a channel bar (6 dye-labelled toggles) and an 8×12 well matrix whose row
  (A–H) and column (1–12) headers toggle whole rows/columns, plus an all/none corner.
- **Transforms:** Raw ↔ ΔRFU (`deltaBaseline`) and Linear ↔ Log (uPlot `distr: 3`).
  - *Log + ΔRFU:* ΔRFU values go ≤ 0, which is undefined on a log axis, so non-positive
    points are rendered as gaps (`null`) and an inline note explains it. The other three
    combinations are unaffected.
- **Hover/tap tooltip:** a uPlot cursor plugin finds the nearest series and reports well
  label, channel/dye, cycle, and mean/min/max/std for that point.

## Color encoding (see `lib/channelColors.ts`)

**Color encodes the channel, never the individual well.** With hundreds of lines, wells in a
channel share one hue; the hovered/nearest line is emphasized while siblings dim (uPlot
`focus.alpha`).

The hues follow each dye's **emission color** — FAM green, HEX yellow, Texas Red orange, Cy5
red, Cy5.5 purple — the Bio-Rad CFX convention users recognize. This palette is deliberately
**not colorblind-safe**: warm dye colors collide (orange↔red; channel 6's blue↔purple) and
cannot pass the CVD gate without abandoning the emission semantics. That trade is acceptable
only because identity never rests on color alone — the channel bar and hover tooltip always
name the channel and dye, and hover isolates one line. The cyberpunk character comes from the
**chrome** (near-black surfaces, cyan/magenta UI accents, glow, mono type), not the series.

**Channels.** The CFX scans six optical channels (`ScanMask=63`); all six carry real
per-well data. Channels 1–5 are the standard dye set; **channel 6 is a real sixth detector
(labelled FRET)**, not the dark/reference data — those are stored separately (`DARKDATA` and
the reference row inside `WELLDATA`). Channel 6 is off by default since standard runs don't
use it.

## Styling & responsiveness

- `theme.css` holds the dark-only design tokens (surfaces, ink, neon accents, channel
  palette, fonts). `app.css` holds layout + component styles.
- Layout is **container-query driven** (`app__main` is the query container): the Curves rail
  sits beside the chart on wide screens and stacks above it under ~720px; the Raw list
  collapses similarly. Fluid type/padding via `clamp()`/`cqi`; chart cells use
  `min-inline-size: 0` and overflow guards so the page never scrolls horizontally.
- `prefers-reduced-motion` is respected.
