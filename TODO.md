# TODO / Roadmap

Deferred work, captured so we can come back to it. The long-term goal is a **full
visualizer for everything** inside a `.zpcr` archive.

## Immediately next

- Build a CFX device emulator for testing purposes, uses the full raw USB protocol but without
  an actual USB device. 
  - Add a button to the UI "Connect to mock instrument" for manual testing purposes
  - Generate realistic data / results based on saved recordings for PCR, melt and heat block runs.
    But generate the same curves for all wells,
  - Support both running in realtime (eg. for interactive use) and maximum accelerated time for
    automated testing (should rely on no sleeps), with on option in the UI when using the mock instrument.
- Clean up instrument UI to make it less confusing when moving between runs. Eg:
  - The left panel should be exclusively about the state of the instrument. Eg.
    showing the last completed run and offering to download it. Open / close lid,
    but nothing about the actively selected file (like start experiment). Changing the selected
    file should change nothing on the left.
  - The main right panel should be mainly about the actively selected file,
    the only place the "start experiment" button is located. Keeping the wide
    instrument data (collapsed by default) such as USB log and files on instrument on
    on the right is fine, but they should only be shown when the running file is selected, or
    in the case of the USB log it should represent any saved log in a file.
  - When a completed or other pending experiment file is selected while the instrument is running
    another file, only the running file should pulse "running". 
- There's a bug where a new zpcr file gets created for the experiment in progress. Review the code
  and ensure run results are always saved into the file which started the run (if any).
- There appears to be a bug with the temperature graph where it doesn't update when the sreen is
  locked / page is not visible (or maybe only when the laptop is sleeping?). See if it's possible
  to download the actual temperature logs during a run and draw the graph based on that. Not the
  plan in the alf, but the actual measured temps if they exist anywhere. Then connecting to a
  device while it's running an experiment should be able to show the whole graph. 

## Analysis improvements

### Match CFX Manager's Cq and end RFU

`samples/20260726_S183-S185_RVP-export.zip` holds CFX's own exported results for
`samples/20260726_S183-S185_RVP.pcrd` — per-cycle corrected RFU, per-well Cq and end-point RFU.
Measuring against it turned most of the analysis chain from a guess into a fact.
**[`threshold.md`](./docs/threshold.md) §A is the write-up.**

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
- [ ] **Ask for `20260726_S183-S185_RVP.pcrd` re-saved with `pDriftCorrection="True"`, and an
      export of it.** Same experiment, nothing else changed — a controlled A/B that would answer
      what drift correction actually does (`calibration.md` §6) per well and per cycle. The
      re-saved file was once in hand but never exported, so it is the export that matters.
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
      committed regression sample** (`samples/biomeme-2024-01-17.bmrun`,
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


## Library (`@zpcrweb/core`)

## Web app (`apps/web`)

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

## Performance

From a whole-project performance review (2026-08-07). Checked items are landed; everything
unchecked is still as reviewed, and its figures still relative to the baseline below.

**How the numbers were obtained.** `--cpu-prof` over the real pipeline on the committed samples,
plus wall-clock timing of `parseZpcr`/`parsePcrd`/`computeRunAnalysis` averaged over repeated
runs. Items marked **measured** were prototyped, timed, and reverted — the figure is what the
prototype actually produced, with all 509 core tests still passing (including
`cfxExport.test.ts`, so the numbers are bit-identical to today's). Items marked **estimated** are
read off the profile without a prototype and should be re-measured before anyone trusts them.

Baseline, `computeRunAnalysis` on a 96-well / 45-cycle run
(`samples/20260726_S183-S185_RVP.zpcr`): **41.3 ms**, with parse a further 10.9 ms. This matters
because that function re-runs on **every** threshold-slider drag, multiplier change, baseline/Cq
source toggle, Cq-marker drag and step switch in the Curves view (`lib/runAnalysis.ts`'s `useMemo`)
— it is the app's interactive inner loop, not a load-time cost.

Since confirmed **in the browser**, by CPU-profiling a 2.3 s drag of a Cq marker in a headless
Chrome (`tools/harness.mjs`) — the harshest case there is, since one gesture sets a threshold on
every animation frame. It ran at **~27 fps** (46 of 68 frames over 32 ms; a real desktop Chrome
will do better, so read the ratios rather than the absolute rate), and the profile named the same
two functions this section already does:
`median` (`threshold.ts`) at 13% of self time and the color-separation linear algebra
(`symmetricEigenDecomposition`, `pseudoInverse`, `multiply`, `transpose`, `identity`) at ~24%
between them. uPlot barely registered (~2%) — **the plot is not the bottleneck, the analysis is**,
and the frame budget is spent re-deriving a whole plate's dye separation that the changed threshold
cannot possibly have affected.

### Perf win, but genuinely more complexity — judgment calls

- [ ] **Don't re-separate the dyes when only a threshold changed — but not yet; the three win-wins
      above make it unnecessary.** A threshold override changes no measurement: color separation,
      the calibration matrix and every raw dye curve are identical before and after. Yet
      `computeRunAnalysis` re-runs all of it, because `useRunAnalysis` memoizes the whole
      derivation on one dependency list and any settings change invalidates it. Splitting it into a
      separation stage (keyed on step, password and `calibrationNormalization`) feeding a Cq stage
      (keyed on the thresholds) would leave a drag re-running only the cheap half.

      **Deliberately not planned now.** The three win-wins above take the *whole* analysis from
      41.3 ms to 12.2 ms without any new structure — comfortably inside a frame, which turns the
      ~27 fps drag above into a smooth one and makes the split buy nothing a user could feel. And
      the split has real cost: `runAnalysis.ts`'s single-derivation shape is the thing that keeps
      the chart, the hover cards and the table from disagreeing (see `apps/web/ARCHITECTURE.md`,
      "One analysis per run"), and two cache keys is two chances for one of them to be wrong in a
      way that shows up as a stale Cq rather than as a crash. **Do the win-wins first and
      re-measure**; only revisit this if a drag is still visibly slow afterwards, or if plate sizes
      grow enough that even the cheap half doesn't fit in a frame.

      Meanwhile the *symptom* is handled where it was cheap to handle: a Cq drag takes the plot out
      of the mouse's way for its duration (`CurveChart.tsx`'s `suppressCursor`), so the cursor rule,
      hover points and tooltip are no longer re-created on every one of those frames — which is what
      made the frame rate visible as flicker in the first place.

- [ ] **Use `fflate` for standard DEFLATE, keep the local inflater for DEFLATE64 only.**
      **Estimated ~20–25% off `.pcrd` parse** (48.7 ms today). `inflate.ts` is a bit-at-a-time
      `puff.c`-style decoder and is **29% of `.pcrd` parse profile time** (`inflateRaw` 20.3%
      self, plus `decodeSymbol` and `bits`); `fflate`'s table-driven inflater is already a
      dependency and is several times faster. **But** `inflate.ts`'s header explicitly rejects
      this: it exists so there is *one* inflater rather than a special case for the DEFLATE64
      payloads CFX uses for larger `.pltd` entries. Taking the win means dispatching on the ZIP
      method — method 8 to `fflate`, method 9 to the local decoder — which is exactly the
      two-libraries branch that comment declined. **Complexity: a real increase.** Worth it only
      if `.pcrd` open time becomes a felt problem; note the doc would need updating in the same
      commit.

- [ ] **`zipCryptoDecrypt` is 16% of `.pcrd` parse.** Byte-at-a-time CRC update over the whole
      payload. A precomputed CRC table (if it isn't already) and avoiding per-byte function-call
      overhead would likely halve it — **estimated ~8% off `.pcrd` parse**. Small, contained,
      slightly more code. Measure before doing it; it may already be table-driven and simply
      bound by the byte count.

- [ ] **XML scanning is ~29% of `.pcrd` parse.** `xmlLite.ts`'s `splitElements` plus its element
      regex, `parseAttrs` and `unescapeXml`. A hand-written single-pass scanner would beat the
      regex, but `xmlLite` is deliberately small and readable, and `.pcrd` is the one format
      that leans on it. **Low priority** — the win is real but this is the least pleasant code to
      make faster and the easiest to get subtly wrong.

- [ ] **Code-split the initial bundle.** Today: **one 451 KB chunk (153 KB gzip)**, everything
      eager. Attributed by sourcemap: `uplot` 51.7 KB, core `usb/` 23.1 KB, `CurvesView` 17.4 KB,
      `useZpcrStore` 16.6 KB, `lib/uplot/chart.ts` 14.3 KB, `InstrumentRail` 11.5 KB,
      `protocolBuilder` 10.1 KB. The honest candidates are the **Instrument stack** (core `usb/` +
      `InstrumentRail` + `useCfxDevice` + the instrument components, ~50 KB — needed only when a
      device is connected, and WebUSB is Chrome-only anyway), the **Raw views** (~15 KB) and the
      **protocol editor** (~20 KB incl. `protocolBuilder`). That is ~85 KB raw / **~28 KB gzip,
      roughly 18% off first load**. `uplot` itself is not a candidate — Curves is the view people
      come for. **Complexity: moderate** (lazy boundaries, suspense/fallback states, and
      `uitest.mjs` coverage for views that now load asynchronously) for a payload that is already
      respectable. **Lowest priority of anything here** unless first-load latency is a complaint.

- [ ] **Move analysis off the UI thread.** Once the win-wins land, `computeRunAnalysis` is ~12 ms
      — comfortably inside a frame, so a Web Worker would buy little and cost a lot (structured
      cloning the run, an async seam through `useRunAnalysis` that every consumer feels). Recorded
      as **deliberately not planned**, so it doesn't get re-proposed: revisit only if plate sizes
      or cycle counts grow by an order of magnitude.

### Already fast — leave alone

Noted so a future review doesn't "optimize" them again:

- **Chart hover.** `lib/uplot/chart.ts`'s `applyHighlight` and the threshold overlay both call
  `u.redraw(false, false)` — no series or path rebuild — and `CurveChart.tsx` isolates highlight
  changes in their own effect, so hovering never reconstructs the plot. This is the right shape.
- **Write-behind persistence.** `state/writeThrottle.ts` is a rate limiter, not a debounce, with
  `visibilitychange`/`pagehide` flushes; a dragged slider costs one rewrite per window.
- **Archives held open.** `state/fileContent.ts` keeps a run's archive unzipped across edits
  instead of re-zipping hundreds of KB per change.

## Cleanups

Simplification / dead-code removal, from a whole-project review (2026-07-27). Items marked
**needs input** are judgment calls left for the repo owner rather than mechanical wins.

### `apps/web`

- [ ] **needs input — `DecodedPlateread.tsx`'s four inline `.decoded__pair` rows.** They are the
      last hand-written copies of the markup `Pair` renders, but their values are numbers and
      mixed JSX (`{size.toLocaleString()} B`) rather than plain strings, so folding them in means
      widening `Pair`'s `v` to `ReactNode` (or stringifying at each call site). Worth it only if
      you'd rather have one row component than a narrow string-typed one.
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
