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

> **Status: baselining implemented (§2–§4); thresholding and Cq are still specification only
> (§5–§6).** `packages/core/src/baseline.ts` implements smoothing, baseline-region selection
> (both automatic strategies) and baseline subtraction (the `Raw`/`RawBaseLineSubtracted`/
> `LinearBaseLineNormalized` modes); nothing computes a threshold or a Cq yet. This document
> specifies reasonable algorithms and the option space a faithful implementation needs, so that
> the numbers can be compared against a reference instrument's own output rather than invented.
> The option names and default values quoted are those a real CFX run persists — they are
> observable in the committed sample `samples/20260720_Luna_noRT.pcrd`, whose analysis parameters
> are described in [`pcrd.md`](./pcrd.md) §2.5.

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
is where its **second derivative peaks**. Compute the discrete second difference of the smoothed
curve, find its maximum, and end the baseline some margin before that cycle. This is robust for
clean sigmoidal curves and is the natural companion to the Cq definition in §6.

Refinements worth having, with reasonable defaults:

- **Reject secondary peaks.** Ignore a candidate peak whose height is below ~**0.3** of the
  largest peak, and treat two peaks closer than ~**4** cycles as one.
- **Require flatness.** Accept the region only if its residual after a straight-line fit is within
  ~**3.5 %** of the curve's total span (*relative flatness*), and its deviation from linearity is
  within ~**3 %** (*relative linearity*). If it fails, walk the end cycle back and retry.

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
  RFU.

### 5.2 Manual override

`thresholdOverrideValue` (with `autoCalculateThreshold="False"`) pins the threshold to a fixed RFU
— **38.70** in the sample. This is the common choice when comparing runs, since an auto threshold
recomputed per run makes Cq values drift between plates. An implementation should treat the
override as authoritative and skip §5.1 entirely.

## 6. Cq — two algorithms

`algorithmCtDetection` selects between them.

### 6.1 `Threshold` — the crossing (observed default)

Find the first cycle whose baseline-corrected value is at or above the threshold, then
**interpolate between it and the previous cycle** to get a fractional cycle. Interpolating in the
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
  produces a spurious late Cq.
- **Validate the baseline.** If the chosen region fails the flatness/linearity checks of §3.2, the
  Cq derived from it is unreliable however clean the crossing looks. Surface it rather than
  silently reporting a number.

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
  subtraction). Thresholding (§5) and Cq (§6) are still unimplemented, as are the `pDriftCorrection`
  reference-normalization baseline modes and `LinearBaseLineNormalizedCurveFit`'s refinement.
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
