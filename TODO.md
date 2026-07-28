# TODO / Roadmap

Deferred work, captured so we can come back to it. The long-term goal is a **full
visualizer for everything** inside a `.zpcr` archive.

## Immediately next

- [ ] It seems common for a negative curve to grow in the first 5 cycles then level off flat. It seems like we should be picking the large later flat line as the baseline but we often pick the start instead. See 20230829's well F5 and 20260726 D4 FAM.
- [ ] Enable sorting on the table view. Click to sort by Cq or well.
- [ ] Review all indexedb storage beyond the data files. Remove anything which effects the analysis (like threshold overrides) - that should come strictly from the file. Whenever such state exists, add a new entry to the zpcr file, call it "zpcrweb.json". In order to make storing this efficient, use a debounce system and pagehide handler - eg. only recreate the zip file in the indexeddb from the in-memory state at most once a minute and on pagehide. When a zpcr file is loaded, read these settings from it (if any) to initialize state. Consider whether we can remove everything from indexeddb other than the files now - what would we lose, and is it just transient state which could be stored in the URL (like the active view mode)?

## Library (`@zpcrweb/core`)

Additional typed parsers for the archive files currently reachable only via the low-level
`archive` API (raw bytes / text / hex):

- [ ] baseline subtraction / Cq (Ct) calculation helpers derived from the curves.
      **Algorithms and the full option space are now specified in
      [`threshold.md`](./threshold.md)** — smoothing, baseline region selection (auto and
      manual), baseline subtraction modes, auto/override threshold, and the two Cq algorithms.
      Implementation is the remaining work; §8 there lists the defaults to start from.
- [ ] **Protocol** — `ProtocolName.txt`, `ProtocolRunDefinition.txt`
      (e.g. `METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP …;PLATEREAD;GOTO 2,44;END`). Parse
      into structured steps + cycling program.
- [ ] **`.alf` run log** — the `*_…_Luna_noRT.alf` tab/`*`-delimited step-by-step run log
      (per-step temperatures, timestamps, elapsed time, error state).
- [ ] **`runlog.xml`** — full structured run event log.
- [ ] **Plateread header** — fan/lid state is decoded via the descriptor dictionary but only
      reachable through `decodePlateReadDetail`; promote it to the typed `PlateRead` surface like
      the temperatures and LED currents now are.
- [ ] **`FactoryRefRowCal`** — parse the factory reference-row calibration array in
      `RunInfo.xml` into typed per-well records.

## Web app (`apps/web`)

- [ ] Add a plate editor which allows setting the flourophores used per well, as well as the tube types for the plate (clear / white).  Used for calibration adjustments and fluorophore display. Allow saving/naming plate files and applying them to runs. Remember the plate setting applied to each loaded run. Have an easy mechanism to copy/paste settings from one well to another or to all wells on a column/row/plate, or to duplicate a column/row across multiple columns/rows (eg. using click drag to select a region simple to copy/paste operations in spreadsheets)
- [ ] Optionally allow writing the target and sample names per well in the plate editor, again with easy copy paste of some form. Then use these in the curves visualization (eg. on hover).
- [ ] Add an option to apply flourophore-specific calibration to the run based on the calibration file data.
- [ ] Plate heatmap per cycle. 
- [ ] Full visualizers replacing the raw viewers as typed parsers land above (`.alf` and the
      remaining plaintext status files). `.Dcal` now has the Calibration view.

## Testing / infra

- [ ] **Regenerate `samples/20260720_Luna_noRT.pcrd` with the correct `Tex 615` fluor.** The
      plate in that `.pcrd` was set up with **`Texas Red`**, which was a mistake at acquisition
      time — the matching `.zpcr` for the same run
      (`samples/20260720_FirstQualification.zpcr`, run `20260720_211747_CT019138_Luna_noRT`)
      correctly says `Tex 615`. The two are aliases for one physical dye and Bio-Rad ships a
      `.Dcal` under each name whose response blocks are byte-identical, so **no number is
      affected** — curves, thresholds and Cq all come out the same either way. What differs is
      the *label*, and the label is the key for threshold-override grouping and for the
      per-fluor settings persisted in `zpcrweb.json`, so opening the same run from the two
      files gives two different override namespaces.

      Worth knowing before touching this: a naive cross-format comparison silently drops the
      96 well/dye pairs whose keys don't match, and looks like it passed. Do not "fix" this by
      adding a dye-alias table to the library — the `.pcrd` is simply wrong and should be
      re-saved from CFX Manager with the right fluor; regenerate `…​.pcrd.xml` alongside it, and
      re-check the `Tex 615` assertions in `pcrd.test.ts`.
- [ ] Add a browser-mode Vitest run to prove isomorphism in a real browser environment.
- [ ] Add more sample `.zpcr` files (different block types, channel counts, cycle counts)
      as they become available.
- [ ] CI workflow (install / typecheck / test / build).

### UI tooling follow-ups

- [ ] **Confirm the dev-server shutdown race.** `tools/harness.mjs`'s `killGroup()` signals the
      whole process group and Chrome reliably reaps to zero, but a `ps` taken immediately after
      `uishot`/`uitest` exits sometimes still shows 1–2 `vite` processes; a moment later they
      are gone. Looks like normal async teardown rather than a leak — confirm with a short
      poll, and if it is real, have `stop()` await process exit. Symptom to watch for: a stale
      `--strictPort` collision on a rerun.
- [ ] **Widen `uitest.mjs` coverage.** Natural next checks: a standalone `.pltd`/`.plt.csv`
      exposing only the Plates + Raw tabs, multi-file switching through `FileBar` (including
      that per-file settings don't bleed across files), and the `.pcrd` password prompt
      appearing when no password is available.
- [ ] **Decide whether `test:ui` runs in CI.** It is deliberately outside `npm test` (needs
      Chrome, ~9s vs ~3s) and `process.exit(1)`s without a `secrets.json` password. To gate CI,
      split the routing checks (no secret needed) from the password checks (secret required).
- [ ] **Root `ARCHITECTURE.md` doesn't mention `tools/`.** CLAUDE.md and
      `apps/web/ARCHITECTURE.md` cover the harness; a short "Tooling" section would close the
      loop.
- [ ] **Hash state is view + file only.** Selected wells/channels/fluorophores stay per-file in
      IndexedDB. `state/urlHash.ts` was built to extend (more keys in the same query string) if
      sharing a specific chart view becomes useful.

## Cleanups

Simplification / dead-code removal, from a whole-project review (2026-07-27). Items marked
**needs input** are judgment calls left for the repo owner rather than mechanical wins.

### `@zpcrweb/core`

- [x] **Un-export four module-private symbols.** `symmetricEigenDecomposition` (`linalg.ts`),
      `byChannel` (`pltd.ts`), `parseAttrs` (`xmlLite.ts`) and `ZIPCRYPTO_HEADER_LEN`
      (`zipcrypto.ts`) are each used only inside their own file and are not re-exported from
      `index.ts`. Dropping `export` narrows the module surface with no behavior change.
- [x] **`pltd.ts`: a doc comment sits on the wrong function.** The block describing
      `parsePlatesetup2` is attached to `byChannel`, which was inserted between the function
      and its comment; `parsePlatesetup2` is left undocumented.
- [x] **`refCalComparison()` recomputes `parseFactoryRefRowCal`.** Both `zpcr.ts` and `pcrd.ts`
      call it with the arguments `factoryRefCal()` already used. Reuse the existing result
      (preserving laziness).
- [ ] **needs input — the ZipCrypto test-encryption helper exists three times.**
      `test/pcrd.test.ts`, `test/pcrd-synthetic.test.ts` and `test/prcl.test.ts` each carry an
      identical ~120-line copy of `CRC_TABLE`/`crc32`/`EncryptKeys`/`zipCryptoEncrypt` and the
      synthetic-archive builders — ~240 lines of duplication. A shared `test/zipCrypto.ts`
      (alongside the existing `test/sample.ts`, `test/secrets.ts`) would collapse it. A comment
      in `pcrd.test.ts` records that self-contained duplication was a deliberate earlier call,
      so this is a revisit-the-decision question, not an oversight.

### `apps/web`

- [x] **Dead CSS: the `.baseline-range*` block.** `app.css` still carries ~75 lines styling the
      `BaselineRangeSlider` deleted in `523ecb3` ("Replace baseline configuration with always-on
      auto linear baselining"). No `.ts`/`.tsx` references any `baseline-range*` class.
- [x] **Dead CSS selector `.refcal__tbl td.refcal__drift-big`.** `refcal__tbl` survives nowhere —
      `RefCalPanel.tsx` uses `refcal__grid`. Drop the stale half of the compound selector.
- [x] **Triplicated `Pair` component.** A byte-identical private `Pair({ k, v })` is defined in
      `raw/DecodedDcal.tsx`, `raw/DecodedProtocol.tsx` and `raw/DecodedPlate.tsx`. Extract one
      shared copy. Done as `raw/Pair.tsx` — a fourth identical copy turned up in
      `plate/PlateViewer.tsx`, and `raw/PlateTable.tsx`'s four hand-written rows now use it too.

- [ ] **needs input — `DecodedPlateread.tsx`'s four inline `.decoded__pair` rows.** They are the
      last hand-written copies of the markup `Pair` renders, but their values are numbers and
      mixed JSX (`{size.toLocaleString()} B`) rather than plain strings, so folding them in means
      widening `Pair`'s `v` to `ReactNode` (or stringifying at each call site). Worth it only if
      you'd rather have one row component than a narrow string-typed one.
- [x] **Narrow ~12 unused exports.** Re-exports nothing imports (`ANALYSIS_BASELINE_MODE` in
      `lib/cq.ts`, `AnalysisSettings` in `state/useZpcrStore.ts`, `NormalizationMode` in
      `lib/fluorCurves.ts` — every consumer imports these straight from `@zpcrweb/core`), plus
      symbols used only inside their own file: `PlateFileKind`, `NEUTRAL_COLOR`,
      `MIN_INTERVAL_MS`, `AnalysisFlushTarget`, `setStoredPltdPassword`, `formatHash`,
      `plusOpacity`, `stepSummary`, and the `HoverCard` component itself (reached only through
      the `useHoverCard` hook that renders it).
- [ ] **needs input — `CurvesView.tsx`'s four `cardFor*` hover-card builders.** `cardForWell`,
      `cardForDyeLabel`, `cardForChannel` and `cardForSample` share one shape (filter
      `allPlotCurves`, bail if empty, map through `selectedFirst`, return `{title, subtitle?,
      rows}`) and differ only in predicate, field mapping and labels — ~70 lines that could be
      ~35. But `cardForWell` carries extra per-card behavior (the
      `well.loaded ? well.sampleType : "empty"` fallback, `meta` lookup) that a naive collapse
      would blur, so this trades repetition for indirection.
- [ ] **needs input — `baseline` is Reference-view-only plumbing.** `CurvesView` always passes
      `baseline="raw"`; only `ReferenceView` varies it. The prop is load-bearing, not dead, but
      the two chart use-cases could split into a thinner shared core plus two wrappers. The
      existing doc comments already flag the asymmetry deliberately, so possibly leave alone.

### Repo hygiene

- [ ] **Stale worktrees.** `.claude/worktrees/` holds four locked worktrees, two of which
      (`bridge-cse_012…`, `bridge-cse_014…`) have no commits beyond `main` and are pure
      leftovers. Prune once no job is using them.

### Knip false positives — do not "clean up"

Recorded so a future pass doesn't remove them: `ProtocolStep` (`prcl.ts` → `types.ts` →
`index.ts`) is public API consumed by `apps/web`; `Cdp` and `drainProblems`
(`tools/harness.mjs`) are imported by `tools/uishot.mjs`. Knip misses both cross-package and
`.mjs` script-to-script imports. Likewise `react`/`react-dom` are flagged "unlisted" in
`apps/web` only because `vite.config.ts` aliases them onto `preact/compat` — the `preact`
dependency entry is correct and no React runtime ships.
