# Baseline, Threshold and Cq

Colour separation ([`calibration.md`](./calibration.md)) turns raw channel readings into a per-dye
amplification curve: one fluorescence value per cycle, per well, per dye. That curve is still not
a *result*. Turning it into the number a qPCR run actually reports — the **quantification cycle**,
Cq (also written Ct) — takes four more stages:

1. **Smooth** the curve, optionally (§2).
2. Pick a **baseline region** and fit a baseline to it (§3).
3. **Subtract** that baseline, so an unamplified well sits at zero (§4).
4. Pick a **threshold** and find where the curve crosses it (§5), or skip the threshold entirely
   and fit the curve's shape instead (§6).

Cq is the (fractional) cycle number at which a well's signal becomes reliably distinguishable from
its own noise. Everything below exists to make that judgement reproducible.

> **Status: implemented (§2–§7), not yet validated against a reference instrument.**
> `packages/core/src/baseline.ts` implements smoothing, baseline-region selection (both automatic
> strategies) and baseline subtraction (the `Raw`/`RawBaseLineSubtracted`/
> `LinearBaseLineNormalized` modes). `packages/core/src/threshold.ts` implements threshold
> determination (manual override or auto, §5), both Cq algorithms (threshold crossing and
> curve-shape inflection, §6) and the amplification squelch (§7). This document specifies
> reasonable algorithms and the option space a faithful implementation needs, so that the numbers
> can be compared against a reference instrument's own output rather than invented. The option
> names and default values quoted are those a real CFX run persists — they are observable in the
> committed sample `samples/20260720_Luna_noRT.pcrd`, whose analysis parameters are described in
> [`pcrd.md`](./pcrd.md) §2.5.

---

## 1. Where the options live

A saved experiment stores these settings **per fluorophore**, alongside per-well-group settings.
From the committed sample:

```xml
<dataAnalysisParameters algorithmCtDetection="Threshold" …>
  <dataAnalysisParam smoothFilterWidthPref="5" subsetPopRDBaseLinePref="5"
                     BeginCyclesSkip="0" EndCyclesSkip="0" …>
    <fluorsDataAnalysisParams>
      <fluorDataAnalysisParam fluorId="13002">
        <pCRDataAnalysisParams
            pCRBaseLine="LinearBaseLineNormalizedCurveFit"
            pCRBaseLineMethod="DataWindow"
            pCRDigitalFilter="WeightedMean"
            pCRDisplayMode="SinglePoint"
            autoCalculateBaseline="True"
            autoCalculateThreshold="False"
            baselineBeginRepeat="2" baselineEndRepeat="9"
            thresholdOverrideValue="38.7041130065918"
            dataWindowFractionFullCycle="1"
            dataWindowWidthFractionFullCycle="0.99"
            pDriftCorrection="False" />
```

So a well's Cq is a function of: the curve, a baseline mode, a baseline region (auto or explicit
begin/end cycles), a smoothing filter, a threshold (auto or overridden), and a Cq detection
algorithm. Reproducing a reference Cq means matching **all** of them, which is why they are
enumerated here rather than left implicit.

Note `pDriftCorrection` sits in this group — it is a baseline setting, not an optical one. See
[`calibration.md`](./calibration.md) §6.

## 2. Smoothing (the digital filter)

> Implemented by `smoothCurve()` in `packages/core/src/baseline.ts`.

Applied to the curve before baselining. Options:

| Mode | Behaviour |
|---|---|
| `Disable` | No smoothing — use the raw separated curve. |
| `RollingBoxcar` | Moving average over a window of `smoothFilterWidthPref` cycles (default **5**). |
| `WeightedMean` | Moving average with weights falling off from the centre (e.g. triangular), same width. The observed default. |
| `Centroid` | Centroid/centre-of-mass smoothing over the window. |

A width of 5 over a 45-cycle run is mild — enough to suppress single-cycle read noise without
visibly delaying the exponential rise. Two implementation cautions:

- **Smoothing shifts Cq slightly.** A symmetric filter does not bias the curve's position, but it
  does flatten the onset of amplification, which typically moves Cq later by a fraction of a
  cycle. Compare against a reference with the *same* filter, or with filtering disabled.
- **Handle the ends explicitly.** A window centred on cycle 1 has no left-hand neighbours. Either
  shrink the window near the edges or leave the first and last `⌊width/2⌋` points unsmoothed;
  either is defensible, but they give different early-cycle values, and the baseline region lives
  exactly there.

`BeginCyclesSkip` / `EndCyclesSkip` (both **0** by default) drop leading/trailing cycles from
consideration entirely — useful when the first cycles are disturbed. Apply them before everything
else.

## 3. Choosing the baseline region

> Implemented by `clampBaselineRegion()` (§3.1), `findBaselineByCurvature()` /
> `findBaselineByRegression()` / `autoBaselineRegion()` (§3.2) and `dataWindowRange()` (§3.3) in
> `packages/core/src/baseline.ts`.

The baseline is the flat, pre-amplification part of the curve. Everything downstream depends on
choosing it correctly: too late and it eats into the exponential rise, dragging Cq later; too
early or too short and it is dominated by noise.

### 3.1 Manual

Explicit `baselineBeginRepeat` / `baselineEndRepeat` cycles — the observed sample uses **2** and
**9**. Sensible constraints for a hand-set or auto-derived region:

- **Begin at cycle ≥ 1** — never cycle 0, whose reading is often anomalous.
- **End at cycle 9** as a starting default.
- **At least 3 cycles wide.** A two-point "baseline" fits any line exactly and has no residual, so
  noise estimation (§5.1) becomes meaningless.
- **End at least a few cycles before the earliest expected Cq.** This is the constraint that
  actually matters and the one auto-selection exists to enforce.

### 3.2 Automatic

Set `autoCalculateBaseline`. Two strategies are worth implementing; they differ in how they find
where amplification starts.

**(a) Curvature / peak-detection.** Amplification onset is where the curve stops being flat, which
is located from a **peak in its second derivative**. Compute the discrete second difference of the
smoothed curve, find its maximum, and end the baseline some margin before onset. This is robust for
clean sigmoidal curves and is the natural companion to the Cq definition in §6.

Refinements worth having, with reasonable defaults:

- **Reject secondary peaks.** Ignore a candidate peak whose height is below ~**0.3** of the
  largest peak, and treat two peaks closer than ~**4** cycles as one.
- **Take onset at the peak's *foot*, not the peak.** The second derivative peaks where the curve
  is accelerating hardest, which is already inside the exponential phase; on a curve whose rise is
  still climbing when the run ends, the peak lands within a cycle or two of the last cycle. Walk
  back from the peak to where the second difference has fallen to ~**5 %** of it — the cycle where
  the curve first departs flat, which is what "onset" means here.
- **Require flatness.** Accept the region only if its residual after a straight-line fit is within
  ~**3.5 %** of the curve's total span (*relative flatness*), and its deviation from linearity is
  within ~**3 %** (*relative linearity*). If it fails, walk the end cycle back and retry.

  Note what this check can and cannot catch: because the bounds are relative to the curve's
  *whole span*, a well rising 10,000 RFU can carry several hundred RFU of ramp inside its
  "baseline" and still pass comfortably. It is a backstop against a grossly wrong region, not a
  substitute for locating onset correctly in the first place — which is why the foot refinement
  above matters. Observed on every late-amplifying NRT/NTC well of
  `20230829_135443_CT019138_SINGLE_STEP_.zpcr`: with onset read at the peak, well E9 (amplifying
  from ~cycle 32, run ending at 40) was given a baseline of cycles 1–35, fitted at **+0.87**
  RFU/cycle against a true drift of **−6.5**. Subtracting that lifts the corrected curve's *first*
  cycles above the threshold, which §6.1 reads as a failed baseline — so the well reported no Cq at
  all, silently, despite obvious amplification.

**(b) Regression / iterative extension.** Fit a straight line to a short initial region, then
extend it one cycle at a time while each new point stays within a confidence band of the fit
(e.g. within *k* standard errors of the extrapolated line). Stop at the first point that departs
— that departure *is* amplification onset. This degrades more gracefully on noisy or
slowly-rising curves, where a second-derivative peak can be ill-defined.

A practical implementation runs (a) and falls back to (b) when peak detection produces no
confident answer, then clamps the result to the §3.1 constraints.

### 3.3 Region *method*: data window vs. full scan

`pCRBaseLineMethod` selects what range of the run is considered:

- **`DataWindow`** (observed default) — restrict analysis to a window of the run, sized by
  `dataWindowFractionFullCycle` (**1** = the full run) and `dataWindowWidthFractionFullCycle`
  (**0.99**). Interpret these as a position and a width, each a fraction of the total cycle count,
  which together bound the region searched.
- **`FullScan`** — consider every cycle.

With the observed values the window is effectively the whole run, so the two coincide; the
distinction matters for runs where a sub-range is deliberately analysed.

## 4. Baseline subtraction modes

> Implemented by `subtractBaseline()` in `packages/core/src/baseline.ts`, for the `Raw`,
> `RawBaseLineSubtracted` and `LinearBaseLineNormalized` modes only — see §9.

`pCRBaseLine` selects what "baseline-corrected" means. The modes form a ladder:

| Mode | Meaning |
|---|---|
| `Raw` | No correction — plot the separated curve as-is. |
| `RawBaseLineSubtracted` | Subtract a **constant**: the mean of the baseline region. Simplest useful correction. |
| `LinearBaseLineNormalized` | Fit a **straight line** to the baseline region and subtract it across all cycles. Removes a sloping (drifting) baseline, not just an offset. |
| `LinearBaseLineNormalizedCurveFit` | As above, but the baseline region and the fit are refined against a model of the whole curve rather than taken as given. **The observed default.** |
| `ReferenceNormalized` | Normalize against a reference dye/well before baselining (e.g. a passive reference). |
| `ReferenceLinearBaseLineNormalized` | Both: reference-normalize, then subtract a fitted line. |

For a first implementation, `RawBaseLineSubtracted` and `LinearBaseLineNormalized` cover almost
everything:

```
constant:  corrected[c] = y[c] − mean(y[begin..end])
linear:    fit y = m·c + b over [begin..end];  corrected[c] = y[c] − (m·c + b)
```

Fit by ordinary least squares over the baseline cycles. The linear form is strictly better when
the instrument shows any drift over the run, and reduces to the constant form when `m ≈ 0`.

## 5. The threshold

> Implemented by `baselineNoise()`, `autoThreshold()` and `resolveThreshold()` in
> `packages/core/src/threshold.ts`.

### 5.1 Automatic

Set `autoCalculateThreshold`. The principle: the threshold should sit just above the noise floor
of the baseline, so that crossing it means "signal", not "noise".

```
noise      = standard deviation of the baseline-region residuals
threshold  = k × noise            (k ≈ 3.2)
```

using the residuals *after* baseline subtraction, so the measure is of scatter about the fitted
baseline rather than of the baseline's slope. A multiplier around **3.2** is a reasonable default:
high enough that random excursions essentially never cross, low enough to catch amplification
early. (The classic textbook choice is 10× the baseline standard deviation, which is markedly more
conservative; instruments in practice use something nearer 3.)

Two refinements that matter in practice:

- **Compute one threshold per fluorophore, not per well.** A threshold that varies well-to-well
  makes Cq values incomparable across a plate, which defeats the purpose. Estimate the noise
  across the wells in the group — the `subsetPopRDBaseLinePref` setting (**5**) suggests using a
  subset of the population rather than every well.
- **Floor the threshold.** If a plate contains only flat wells, the noise estimate collapses and
  the threshold approaches zero, so every well "crosses" at cycle 1. Impose a minimum absolute
  RFU. `autoThreshold()` takes a `minThreshold` but defaults it to **0**, i.e. no floor, because no
  defensible value has been pinned down yet — see §9. The effect is visible on real data: once §3.2
  picks a *tight* baseline, the residual noise is genuinely small, so `3.2 × noise` lands a few RFU
  above baseline on a curve that rises by thousands, and Cq comes out well before the visible
  take-off. The reported Cq is then self-consistent but systematically early relative to what an
  instrument using a fixed threshold (§5.2) would report for the same well.

> A direct consequence, worth stating plainly: **a Cq is a property of a well *and the group it
> was computed with*, not of the well's curve alone.** Change the set of wells in the group and the
> median noise moves, the threshold moves, and a marginal well can gain or lose its Cq. So a Cq must
> be computed once per run over the whole group and then read, never recomputed over whatever subset
> a caller happens to be looking at. `packages/core/src/analysis.ts`'s `computeCqTable()` is the
> batch entry point that enforces this: one call over every curve of a run, one entry per
> well/fluorophore.

### 5.2 Manual override

`thresholdOverrideValue` (with `autoCalculateThreshold="False"`) pins the threshold to a fixed RFU
— **38.70** in the sample. This is the common choice when comparing runs, since an auto threshold
recomputed per run makes Cq values drift between plates. An implementation should treat the
override as authoritative and skip §5.1 entirely.

## 6. Cq — two algorithms

> Implemented by `findThresholdCrossing()` (§6.1), `findInflectionCq()` (§6.2) and `computeCq()`
> (dispatches between them, and applies the §7 squelch) in `packages/core/src/threshold.ts`.

`algorithmCtDetection` selects between them.

### 6.1 `Threshold` — the crossing (observed default)

Find where the curve crosses the threshold — the start of its **final** run above it, see the
"ends below threshold" case below — then **interpolate between that cycle and the previous one** to
get a fractional cycle. Interpolating in the
log domain matches the underlying exponential and is the better default:

```
find first c with corrected[c] ≥ T
solve for the fractional position between c−1 and c:

  Cq = (c−1) + ( log(T) − log(corrected[c−1]) )
             / ( log(corrected[c]) − log(corrected[c−1]) )
```

Equivalently: fit a line to `log(corrected)` over the couple of cycles bracketing the crossing and
solve it for `log(T)`. Fitting a short line rather than using exactly two points is more robust to
a single noisy reading, and is what the slope/intercept pair a reference implementation carries
alongside each crossing implies.

Edge cases, all of which must be handled explicitly:

- **`corrected[c−1] ≤ 0`.** Common — the point just below threshold may sit below the baseline.
  The logarithm is undefined; fall back to linear interpolation for that well.
- **Never crosses.** Report **no Cq** (not cycle 0, not the cycle count). An empty Cq is a
  meaningful result: no amplification.
- **Starts above threshold.** Usually indicates a failed baseline, not an extraordinarily early
  Cq. Report no Cq and flag the well.
- **Ends below threshold.** A curve that crosses and then falls back is suspect. Reference
  implementations expose a "no Cq if the trace ends under the threshold" option; default it on.
- **Crosses, falls back, then crosses again.** With that option on, only the last crossing can be
  the amplification the trace ends in, so anchor Cq to the start of the *final* above-threshold
  run rather than the first cycle that touches the threshold. On a clean single-crossing sigmoid
  the two rules coincide. This matters whenever the threshold sits near a well's own baseline
  noise — which happens by construction to a genuinely amplifying well grouped (per §5.1) with
  mostly-flat ones, since the group's median noise sets the threshold: taking the first touch then
  reports a Cq of 1–2 for a well that amplifies at cycle 30.

### 6.2 `NoThreshold` — curve fitting

Dispense with the threshold and take Cq from the curve's **shape**: fit a sigmoid (or use the
smoothed derivatives directly) and report the **second-derivative maximum** — the point of
steepest acceleration, the inflection at the start of the exponential phase.

This has a real advantage: it needs no threshold, so it is immune to the "which threshold?"
problem that makes Cq values incomparable between runs. Its disadvantage is that it is only
defined for curves that actually have a sigmoidal shape — a flat or linear trace has no
meaningful second-derivative maximum, so the "no amplification" case must still be detected
separately.

The two algorithms do **not** produce identical values. A second-derivative maximum typically
falls slightly later than a threshold crossing set near the noise floor. Do not mix them within a
comparison.

## 7. Quality gates

Two guards worth implementing, both of which change reported results:

- **Squelch unamplified traces.** Before assigning Cq, classify each well as amplified or not
  (e.g. total rise below a few multiples of baseline noise ⇒ not amplified) and suppress Cq for
  the rest. Without this, noise on a flat well eventually crosses a low auto threshold and
  produces a spurious late Cq. Implemented by `isAmplified()` in `packages/core/src/threshold.ts`
  (default multiplier **10**, not pinned by the doc); `computeCq()` applies it automatically when
  given a `noise` estimate.
- **Validate the baseline.** If the chosen region fails the flatness/linearity checks of §3.2, the
  Cq derived from it is unreliable however clean the crossing looks — this matters even for a
  region `findBaselineByRegression` chose, not just `findBaselineByCurvature`'s own candidates:
  its local fit-and-extend stops at the first point that departs the fit, which is only sometimes
  real amplification onset. A curve whose true baseline decays at a *changing*
  rate (steep for the first few cycles, much shallower after, with no amplification anywhere)
  departs a short initial fit too, and extrapolating that region's line across the rest of the run
  then manufactures a spurious rise out of pure slope-estimation error — observed on a real NTC
  well (`20230829_135443_CT019138_SINGLE_STEP_.zpcr`, well B5). Implemented by
  `validateBaselineRegion()` in `packages/core/src/baseline.ts`, which re-checks the final region
  (however it was chosen) against §3.2's flatness/linearity bounds, judged against the curve's
  *whole* span rather than the region's own scatter. A region narrower than
  `minValidationWidth` (default **5**) is extended up to that width before checking: any 3-4
  point window of an otherwise-smooth curve fits a line almost exactly by construction (the same
  too-few-degrees-of-freedom instability `findBaselineByRegression`'s `initialWidth` guards
  against), so a too-narrow region — typically an artifact of a curvature-detected onset that
  lands implausibly early — can pass flatness/linearity trivially on its own even though it's just
  as unreliable as a wider mis-fit region; observed on a second real well in the same run (NRT
  control, well E5), whose auto-detected region was only 3 cycles wide. `baselineCorrectCurve()`
  in `analysis.ts` runs the gate automatically and surfaces the result as
  `CurveBaselineResult.baselineValid`, forcing `amplified` to `false` when invalid; `computeCq()`'s
  `baselineValid` option (typically fed from that same field) reports no Cq outright when `false`,
  checked before the amplification squelch above.

## 8. Recommended defaults

For an implementation aiming to match a reference instrument:

| Setting | Default |
|---|---|
| Cycles skipped (begin/end) | 0 / 0 |
| Smoothing | Weighted mean, width 5 |
| Baseline region | Auto; else cycles 2–9 |
| Minimum baseline width | 3 cycles |
| Baseline mode | Linear (fitted line subtracted) |
| Baseline region method | Data window over the full run |
| Threshold | Manual override if present, else ≈3.2 × baseline noise |
| Cq algorithm | Threshold crossing, log-interpolated |
| No Cq if trace ends under threshold | On |

## 9. Open items

- **Partially implemented.** `baseline.ts` covers §2–§4 (smoothing, baseline region, baseline
  subtraction, and now the §7 baseline-validation gate via `validateBaselineRegion()`) and
  `threshold.ts` covers §5–§7 (threshold determination, both Cq algorithms, the amplification
  squelch). Not implemented: the `pDriftCorrection` reference-normalization baseline modes and
  `LinearBaseLineNormalizedCurveFit`'s refinement.
- **No threshold floor.** §5.1 calls for one and `autoThreshold()` accepts a `minThreshold`, but
  its default is 0. This is now the weakest link in the chain: with baseline detection no longer
  eating into the rise, `3.2 × median baseline noise` is a very low bar, and it is what sets how
  early every Cq lands. A floor expressed as an absolute RFU is instrument-dependent; a floor
  expressed relative to the group's amplification span (a few percent of median ΔRFU, say) would
  scale, but neither has been checked against a reference instrument.
- **Not validated.** These algorithms are specified to be *reasonable and precise*, but no Cq —
  and, for the baseline stages now implemented, no baseline region or corrected curve either —
  has been compared against a reference instrument's own reported values for the same well. Until
  that comparison exists, treat agreement as unproven — the same caveat
  [`calibration.md`](./calibration.md) carries.
- The exact form of the curve-fit refinement in `LinearBaseLineNormalizedCurveFit` (as against
  plain linear baselining) is not pinned down.
- `dataWindowFractionFullCycle` / `dataWindowWidthFractionFullCycle` are interpreted here as a
  position and width; with the observed values (1 and 0.99) the two readings are
  indistinguishable, so this needs a run that uses a genuine sub-window to confirm.
- `pCRDisplayMode` (`SinglePoint` vs `AllPoints`) is understood to select how a multi-read cycle
  is reduced to one value per cycle, but its interaction with Cq has not been checked.
