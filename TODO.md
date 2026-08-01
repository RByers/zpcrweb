# TODO / Roadmap

Deferred work, captured so we can come back to it. The long-term goal is a **full
visualizer for everything** inside a `.zpcr` archive.

## Immediately next

### Match CFX Manager's Cq and end RFU

`samples/20260726_S183-S185_RVP-export.zip` holds CFX's own exported results for
`samples/20260726_S183-S185_RVP.pcrd` — per-cycle corrected RFU, per-well Cq and end-point RFU.
Measuring against it turned most of the analysis chain from a guess into a fact.
**[`threshold.md`](./threshold.md) §A is the write-up.**

**Landed** (2026-07-28): the measured crossing rule (linear two-point interpolation on the cycle
index, longest-following-increasing-run selection, `T ∉ [min, max]` as the only no-Cq gate), the
quality gates demoted to diagnostics, no smoothing of the analysed curve, the
`LinearBaseLineNormalizedCurveFit` plateau filter, end-point RFU, baseline regions that take the
whole run for a non-amplifying well and stop at `round(Cq) − 2` for an amplifying one, the
per-fluorophore `thresholdOverrideValue` seeding the app's own override, and the regression test
that asserts the Cq stage against CFX's own numbers (`packages/core/test/cfxExport.test.ts`). End
to end the pipeline now lands within 0.11 cycles of CFX on every well it quantifies
(`threshold.md` §A.8).

Still open:

- [ ] **Find CFX's automatic threshold rule** (`threshold.md` §5.2). The largest remaining source
      of systematic disagreement, and the only place a wrong answer moves every Cq on a plate at
      once. Two anchors and one inequality — FAM 92.02, Tex 615 8.0645, Cy5 **> 278** — rule out
      every noise-relative rule *and* the per-curve shape rule this project used to propose: Cy5's
      threshold must exceed 278 RFU while every Cy5 curve on the plate is flat noise. More anchors
      need more runs with `autoCalculateThreshold` left on **and** exported results.
- [ ] **Ask for an export of `20260720_Luna_noRT.pcrd`.** The cheapest single addition to the
      above: its Cy5 is on auto, so an export would yield a third auto anchor. It would also
      settle `calibration.md` §8's per-dye scale factor, measured against two scalars of uncertain
      definition from that run (one read off a chart) and contradicted by the RVP full-curve
      comparison.
- [ ] **Ask for an export of `20260726_S183-S185_RVP-drift-correction.pcrd`.** Same experiment,
      `pDriftCorrection="True"`, nothing else changed — a controlled A/B that would answer what
      drift correction actually does (`calibration.md` §6) per well and per cycle.
- [ ] **Pin the exact baseline window rule** (`threshold.md` §A.7). The bracket is implemented and
      the model is settled, but the best-matching ordinary least-squares fit still misses CFX's
      recovered line by 0.02–0.5 RFU, and eight smoothing/edge variants plus a zero-slope variant
      all did worse. A precision question now, not a correctness one: it is what the ≤0.11 cycles
      of §A.8 is made of.
- [ ] **Don't add a reference-row correction — and record why** (`calibration.md` §4.1a). Measured:
      every per-cycle reference normalization tried (divide by R1, divide by the bright columns,
      subtract R1's deviation) degrades agreement with CFX by **300–940×**, *and* makes baseline
      noise 1.1–1.3× and baseline slope 3.3–4.9× worse on its own merits. The cause is in the raw
      data — sample wells share no per-cycle wiggle (mean pairwise correlation ≈ 0), so there is no
      common-mode to cancel and a correction only injects the reference's own noise. **No code
      change needed**; the current no-op is right. This entry exists so the idea doesn't get
      re-proposed.
- [ ] **Add a per-run optical-trend metric from the bright reference columns**
      (`calibration.md` §4.1b). R2–R12 dim 0.3–1.2% over a run and correlate 0.25–0.77 with the
      plate's common-mode residual — a real optical signal, too small to correct with but a good
      run-quality indicator. Complements the existing whole-run factory comparison in `refcal.ts`
      (which answers "has the row drifted since service?") with "did the optics move during *this*
      run?". Diagnostic only — never into the analysis path.
- [ ] **Surface `DARKDATA` as instrument QC** (`calibration.md` §4.2b). The subtraction stage is
      gone (measured to make results 260× worse); the *measurement* is a genuine health signal —
      per-channel dark levels reproduce to ~1 count in 2000 across runs six days apart. Flag a
      channel that moves between runs or drifts within one, and flag a well reading at or below
      its channel's dark level. **Channel 4 of CT019138 is reproducibly noisy** (2.5–3× the
      scatter of every other channel, in both committed runs) — a good first test case.
- [ ] **Chase the last ~2 × 10⁻⁴ of colour separation** (`calibration.md` §8): six Cy5 wells and
      Tex 615 G4 reconstruct to 0.14–0.46 RFU rather than 5e-3. Dye- and well-specific, present on
      flat curves, not well factors. Small, but it is now the largest known separation error.
- [ ] **The end-point call** (`threshold.md` §7) — `(+) Positive` / `Negative` / `NoCall` /
      `Unassigned`, derived from the plate's negative control rather than a fixed RFU. Visible in
      the export, but from one plate only.
- [ ] **Biomeme's noise estimator false-positives on flat wells with real thermal drift**
      (`threshold.ts`'s `baselineNoise`, `biomeme.md`). Reported against
      `~/lab/MolBioLab/biomeme/runs/1A22DCF3-658B-47DE-BF97-1EDA72A93D38.json`: the device calls
      every green (FAM) and red (ATTO-647N) well non-amplifying, but `computeCqTable` gives three
      of them a Cq anyway. Root cause: `baselineNoise`'s median-second-difference estimator is
      *deliberately* blind to smooth curvature (measured necessary for CFX, whose smooth curvature
      in a nominal baseline region always means a misplaced window — see the function's doc
      comment). Biomeme's handheld block has no active thermal feedback like a CFX, so a
      non-amplifying well's "flat" region carries tens of RFU of genuine smooth drift; the
      estimator correctly calls that "not jitter" and reports noise as low as 0.17–1.3 RFU, so
      `20 × noise` sits below the drift and a flat well crosses its own threshold. Measured
      residual-stddev/jitter ratios on that run's flat wells: 7.6×–29.1× (CFX's own worst
      documented case, cited in the same doc comment, is 8.7×).

      Tried `max(jitter, stddev)` for dye-space sources only (gated so CFX's own path, and
      Biomeme's baseline-*placement* pass, stay on pure jitter — only the already-placed final
      noise/threshold would blend). Fixes the reported file (all green/red curves correctly go to
      no-Cq, orange keeps its Cq within ~1 cycle of the device's own). **But regresses the
      committed regression sample** (`samples/biomeme-2024-01-17.json`,
      `packages/core/test/biomeme.test.ts`): amplified/not agreement drops 19/27 → 16/27, and the
      sample's one known true-positive well (well 4, TexRedX, file Cq 23.24) disappears — that
      channel's real positives in this sample are themselves gentle continuous rises from cycle 1
      with no sharp exponential shoulder, so the already-narrowed baseline region still contains
      real curve shape, and `stddev` there measures signal, not drift. A side-by-side small-multiples
      chart of both runs' curves showed the two cases can look visually identical (a slow smooth
      rise from cycle 1) — one is drift, the other is real low-amplitude amplification — which is
      probably why no per-curve residual-variance statistic can cleanly separate them; likely needs
      information a single curve doesn't carry (e.g. comparing against the fluorophore's own
      no-template/negative wells specifically, or leaning more on the device's own per-curve
      threshold for Biomeme rather than this library's per-fluorophore auto rule). Change was
      reverted; nothing shipped.

`threshold.md` §10 also lists the analysis options left deliberately unimplemented (reference
normalization, drift correction, cycle skips, the data sub-window, the `NoThreshold` Cq
algorithm, display smoothing) — each understood, none exercised by any sample in hand.

### Other

- [ ] Review all indexeddb storage beyond the data files. Consider whether we can remove
      everything from indexeddb other than the files now — what would we lose, and is it just
      transient state which could be stored in the URL (like the active view mode)?

## Library (`@zpcrweb/core`)

Additional typed parsers for the archive files currently reachable only via the low-level
`archive` API (raw bytes / text / hex):

- [ ] **`.alf` run log** — the `*_…_Luna_noRT.alf` tab/`*`-delimited step-by-step run log
      (per-step temperatures, timestamps, elapsed time, error state).
- [ ] **`runlog.xml`** — full structured run event log.

## Web app (`apps/web`)

- [ ] Add a plate editor which allows setting the flourophores used per well, as well as the tube types for the plate (clear / white).  Used for calibration adjustments and fluorophore display. Allow saving/naming plate files and applying them to runs. Remember the plate setting applied to each loaded run. Have an easy mechanism to copy/paste settings from one well to another or to all wells on a column/row/plate, or to duplicate a column/row across multiple columns/rows (eg. using click drag to select a region simple to copy/paste operations in spreadsheets)
- [ ] Optionally allow writing the target and sample names per well in the plate editor, again with easy copy paste of some form. Then use these in the curves visualization (eg. on hover).
- [ ] Full visualizers replacing the raw viewers as typed parsers land above (`.alf` and the
      remaining plaintext status files). `.Dcal` now has the Calibration view.
- [ ] **Build a melt curve UI.** `zpcr.steps()`/`toSteps()` (`packages/core/src/pivot.ts`) groups
      plate reads purely by the raw `STEP` field, with no notion of "amplification" vs. "melt" —
      protocol-step *kind* is decoded separately in `prcl.ts` (`meltcurvestep`) but never joined
      against it. So today a melt-curve step (temperature ramp, not real cycles) shows up as just
      another chip in the Curves view's step selector (`CurvesView.tsx`), and selecting it feeds
      temperature increments into `computeCqTable` as if they were cycles — producing meaningless
      Cq values, more of them the lower the auto-threshold multiplier. Needs its own view (x axis
      = temperature, no Cq) and the step selector should stop offering melt steps to the Cq-based
      Curves view.

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
- [ ] **Root `ARCHITECTURE.md` doesn't mention `tools/`.** README.md and
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
- [x] **The ZipCrypto test-encryption helper exists three times.**
      `test/pcrd.test.ts`, `test/pcrd-synthetic.test.ts` and `test/prcl.test.ts` each carried an
      identical ~120-line copy of `CRC_TABLE`/`crc32`/`EncryptKeys`/`zipCryptoEncrypt` and the
      synthetic-archive builders — ~240 lines of duplication. Collapsed into a shared
      `test/zipCrypto.ts` (alongside `test/sample.ts`, `test/secrets.ts`) exporting
      `buildEncryptedZip(plaintext, password, entryName)` plus `TEST_PASSWORD`; the three copies
      differed only in the ZIP entry name, now a parameter.

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
