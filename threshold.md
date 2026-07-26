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
> strategies plus the §3.4 start-trim) and baseline subtraction (the `Raw`/`RawBaseLineSubtracted`/
> `LinearBaseLineNormalized` modes). `packages/core/src/threshold.ts` implements threshold
> determination (manual override or auto, §5), both Cq algorithms (threshold crossing and
> curve-shape inflection, §6) and the amplification squelch (§7).
> `packages/core/src/stats.ts` holds the statistics both stages share. This document specifies
> reasonable algorithms and the option space a faithful implementation needs, so that the numbers
> can be compared against a reference instrument's own output rather than invented. The option
> names and default values quoted are those a real CFX run persists — they are observable in the
> committed sample `samples/20260720_Luna_noRT.pcrd`, whose analysis parameters are described in
> [`pcrd.md`](./pcrd.md) §2.5.
>
> **On agreement with CFX.** Bio-Rad documents none of the algorithms below — only the *option
> names and values* a saved run persists are observable. So each section flags whether a choice is
> (a) **read from the file**, and therefore certain; (b) **inferred** from those values plus the two
> thresholds CFX persisted; or (c) **this library's own**, with no evidence either way. Most of the
> numeric core is (c). Nothing here should be read as "this is what CFX does".

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

- **Begin at cycle ≥ 2.** `baselineBeginRepeat` is **2** in every `.pcrd` examined — CFX does not
  start a baseline at the run's first read, and neither does `minBeginCycle`'s default. Block and
  optics are still settling then, so that point sits off the line the rest of the region describes:
  including it tilts the fit and inflates the §5.1 noise estimate, which §5.1's multiplier then
  scales straight into every Cq in the group. (Cycle 0, where a run has one, is skipped for the
  same reason but more so.) Measured on `20230829…SINGLE_STEP_`, moving from 1 to 2 lowers the
  auto thresholds ~10–20% and pulls every Cq 0.1–0.4 cycles earlier, with the same wells reporting
  a Cq either way.
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
confident answer, then clamps the result to the §3.1 constraints — and then trims the start (§3.4).

### 3.3 Region *method*: data window vs. full scan

`pCRBaseLineMethod` selects what range of the run is considered:

- **`DataWindow`** (observed default) — restrict analysis to a window of the run, sized by
  `dataWindowFractionFullCycle` (**1** = the full run) and `dataWindowWidthFractionFullCycle`
  (**0.99**). Interpret these as a position and a width, each a fraction of the total cycle count,
  which together bound the region searched.
- **`FullScan`** — consider every cycle.

With the observed values the window is effectively the whole run, so the two coincide; the
distinction matters for runs where a sub-range is deliberately analysed.

### 3.4 Trimming the start: the settling transient

*This library's own; **no** evidence CFX does anything equivalent. Implemented by
`refineBaselineStart()`.*

Everything in §3.2 decides where the baseline must **stop**. Nothing there decides where it should
**start** — the region simply begins at `minBeginCycle` (2) and takes whatever the instrument was
doing early in the run. That is a real gap, because the first cycles of a run are the least
trustworthy part of it: the block and optics are still stabilizing, so the curve rises steeply and
then flattens — a decaying transient on top of the usual linear drift. A straight line fitted across
the whole region cannot follow that shape, so the fit tilts, and everything built on it (the noise
estimate, and through it the group's threshold and every Cq in the group) inherits the error.

The size of the effect is per-well, which is what makes it damaging: on `20260720.zpcr`, wells A3
and D3 carry the same dye and near-identical curves, but A3's transient is ~55 RFU on the first
cycle step against D3's ~12, giving residual spreads of 11.1 and 2.5 about their fitted baselines.

The fix is to walk the region's start forward until its residuals stop looking like a smooth arc and
start looking like noise, judged by the von Neumann ratio of §5.2:

- Stop at the **earliest** start whose ratio reaches ~**1.0**. Earliest, not the maximum — keeping
  as many baseline cycles as the model honestly supports, rather than discarding good data to chase
  sampling noise in the statistic.
- Never trim below ~**8** cycles, and never walk more than ~**15** cycles forward. The second bound
  matters more than it looks: a settling transient is over within a handful of cycles, and without a
  bound the walk will "succeed" at the far end of a region, because the tail of a flat curve is
  white noise and passes trivially. Observed on well A3/FAM of `20260720.zpcr` — a well that never
  amplifies, so onset detection returns the whole run — where an unbounded walk returned cycles
  **34–45**, a perfectly white dozen cycles describing nothing about the well's baseline.
- If **no** start reaches the target, leave the region alone. The premise of the search is that the
  mis-fit is confined to the front; if nothing makes it white, that premise is false (a baseline
  that curves continuously, or amplification pulled deep into the region) and trimming would return
  an arbitrary late slice. §7's validation gate should reject the curve instead.

Judge the ratio on the **unsmoothed** curve. §2's filter makes adjacent points share most of their
inputs, which is serial correlation by construction — a width-5 weighted mean drives the ratio to
≈0.4 on pure white noise — so a smoothed curve looks mis-modelled everywhere and the walk trims to
the minimum on every well. Onset detection genuinely wants the smoothed curve; this test genuinely
wants the raw one.

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
noise      = successive-difference spread of the baseline-region residuals   (§5.2)
threshold  = k × noise                                                       (k ≈ 20, see below)
```

On top of the region starting at cycle 2 (§3.1), the region's **own first cycle is left out of the
`noise` estimate** (`skipLeadingCycles`, default 1) — so with the default region the estimate begins
at cycle 3. The settling argument in §3.1 doesn't stop cleanly at one cycle, and one outlier in a short window
inflates a standard deviation out of proportion to its meaning — which the threshold then
multiplies by a large constant, straight into every Cq of the group. Only the noise *statistic*
skips it: the baseline line is still fitted over the whole region and the curve is still corrected
across every cycle.

How much this matters depends on the run. On `20230829_135443_CT019138_SINGLE_STEP_.zpcr` the
first cycle turns out **not** to be unusual — its residual is a median 0.76σ from the baseline,
with only 5 of 34 loaded wells past 2σ, so dropping it moves the mean noise by 3% and Cq by under
0.1 cycles. It is cheap insurance on the runs where the first read *is* off, not a correction that
reshapes a well-behaved plate.

using the residuals *after* baseline subtraction, so the measure is of scatter about the fitted
baseline rather than of the baseline's slope.

The multiplier depends entirely on what "noise" means, and the textbook figures (3× as permissive,
10× as the conservative classic) assume the raw well-to-well scatter of the baseline cycles. The
residual measured here is a much smaller quantity: the curve has already been smoothed (§2) and had
a line fitted tightly to its pre-amplification region subtracted (§3–§4). Multiplying *that* by 3.2
puts the threshold a few RFU above baseline on a curve rising by thousands, so the crossing lands
deep in the exponential's foot and every Cq comes out systematically early.

The **scale** comes from the only ground truth available — the thresholds CFX itself persisted in
`20260720_Luna_noRT.pcrd`, where `autoCalculateThreshold="False"` means these are the values the
instrument's own analysis actually used. The plate loads three fluorophores and exactly **two**
carry an override: `fluorId` 5 (FAM) and 12 (Texas Red), both 210.72. `fluorId` 4 (Cy5) is left on
`autoCalculateThreshold="True"` and is **not** an anchor. Dividing those two by the median
`baselineNoise` over each dye's four loaded wells:

| Fluor | CFX `thresholdOverrideValue` | via plain std-dev | via successive difference (§5.2) |
|---|---|---|---|
| FAM | 210.72 | 2.33 → **90.3×** | 2.47 → **85.3×** |
| Texas Red | 210.72 | 5.08 → **41.5×** | 2.65 → **79.6×** |

Read that table as evidence about the *estimator*, not just the constant. Under a plain standard
deviation the two anchors disagree by **2.2×**, so "the" multiplier would depend on which dye it had
been calibrated against — disqualifying for a constant meant to generalize. Under §5.2's estimator
they agree within **7%**. That is the main argument for §5.2, and it was not true by construction:
the estimators converge because Texas Red's cohort happened to carry more baseline mis-fit than
FAM's, and removing that from the statistic removed the disagreement with it.

The **default is 20**, well below the ≈80 those anchors now imply. That gap is a deliberate,
unresolved judgement call rather than a measurement: re-anchoring to ≈80 puts every Cq on the
samples in hand later than the curves suggest. Two anchors sharing one override value, from one run
on one instrument, are not enough to overrule that; see §9. The web app puts the multiplier on a
slider for exactly this reason.

An obvious alternative is to scale the threshold to the *amplification* rather than the noise. The
same two anchors read as 7.5% and 10.1% of their wells' median ΔRFU: a looser fit, and one that
disagrees sharply on other plates (on `20230829_135443_CT019138_SINGLE_STEP_.zpcr`, whose ΔRFU/noise
ratio is ~4× higher, an 8% rule gives a threshold ~5× the noise-relative one). So the rule stays
noise-relative.

### 5.2 What "noise" means: successive differences, not spread

*This library's own. CFX's noise statistic is not documented and not observable; all that can be
said is that this choice makes the two anchors above mutually consistent, which the obvious
alternative does not. Implemented by `baselineNoise()`, selectable via its `estimator` option.*

The obvious reading of "noise" is the standard deviation of the baseline region's residuals. That is
wrong in a way that matters, and it is the single largest source of *per-well* error in the chain.

A standard deviation about a fitted line answers **"how far is this curve from my model?"** The
threshold rule needs **"how much does this curve jitter?"** Those coincide only when the model is
right. When it isn't — a settling transient (§3.4), a curved drift, the foot of amplification pulled
into the region — the residuals trace a smooth path rather than scattering, the standard deviation
reports the size of *that path*, and the threshold inflates in proportion to how badly the line
mis-described the well. The threshold then rises exactly where the curve is least well understood,
per well, which makes Cq incomparable across a plate — the very thing §5.1's per-group threshold
exists to prevent.

Use the root-mean-square **successive difference** instead (the MSSD, or von Neumann, estimator):

```
noise = sqrt( mean( (r[i] − r[i−1])² ) / 2 )
```

It measures only cycle-to-cycle change, so it is blind to any smooth trend the fit missed, and it
agrees with the standard deviation on residuals that really are a straight line plus white noise.
The `/2` is what makes the two agree there: successive differences of independent values carry twice
the variance of the values themselves.

Measured over the loaded curves of the committed samples, `std-dev ÷ successive-difference` runs to
**4.2×** on `20260720.zpcr` and **8.7×** on `20230829_135443_CT019138_SINGLE_STEP_.zpcr` (median
5.5× there, where 67 of 72 curves carry a visibly non-white baseline). On the latter the old
estimator put the group threshold at **≈1063 RFU** and only 3 of 72 wells reported a Cq at all;
this one puts it at **≈178**, and 5 report.

Two cautions:

- **Trend robustness is not outlier robustness.** An isolated bad read enters *two* successive
  differences rather than one squared deviation, so a lone spike counts for slightly more, not less.
  This is why the leading-cycle skip below still earns its place. A median-of-absolute-differences
  variant would be robust to both; it is not implemented, because nothing has been measured to
  justify the extra constant it needs.
- **The ratio of the two estimators is itself the useful quantity** — see §5.3.

### 5.3 The von Neumann ratio, and what it is good for

*This library's own; exposed as `residualWhiteness()` and `whiteness()`.*

Dividing the mean squared successive difference by the variance gives **von Neumann's ratio** — a
scale-free measure of how much of a residual series is noise rather than structure:

| Ratio | Meaning |
|---|---|
| **≈ 2** | White noise — successive residuals independent. What a correctly-modelled baseline gives. |
| **→ 0** | Strongly serially correlated — the residuals trace a smooth path, so a straight line is the wrong model over this region. |
| **> 2** | Alternating / anti-correlated, e.g. an over-smoothed or aliased trace. |

Its value is that it needs **no tuning constant and no scale**: the null is 2 for every curve, dye,
run and instrument. Contrast §3.2's flatness/linearity bounds, which are fractions of the curve's
*whole span* and so grow permissive exactly on the high-rising wells where a mis-fit baseline does
the most damage. Measured on the committed samples the separation is wide and clean: every visibly
mis-modelled curve lands at **0.03–0.5**, every clean one at **1.4–2.5**.

**Where it works: choosing between regions.** §3.4's start-trim compares sub-regions of one curve
against each other, and a wrong answer there costs a few baseline cycles.

**Where it does not: accepting or rejecting one.** Promoting the same ratio into a §7 validation
gate was tried and abandoned. Being scale-free cuts both ways — it cannot distinguish structure that
matters from structure far below what the instrument can resolve. A near-noiseless curve is the
pathological case: with almost no scatter, *any* residual is ~100% structure, so the ratio collapses
toward 0 and the gate fires hardest precisely where the linear fit is most nearly exact. On
noise-free synthetic sigmoids it rejects every curve; on real data it flagged ten further wells of
`20230829…SINGLE_STEP_` invalid without catching anything §7's existing gate was missing. Validation
stays with the span-relative bounds; the ratio stays a search heuristic and a per-curve diagnostic.

An obvious alternative is to scale the threshold to the *amplification* rather than the noise. The
same two anchors read as 7.5% and 10.1% of their wells' median ΔRFU: a looser fit, and one that
disagrees sharply on other plates (on `20230829_135443_CT019138_SINGLE_STEP_.zpcr`, whose ΔRFU/noise
ratio is ~4× higher, an 8% rule gives a threshold ~5× the noise-relative one). So the rule stays
noise-relative.

Two refinements that matter in practice:

- **Compute one threshold per fluorophore — not per well, and not per target.** A threshold that
  varies well-to-well makes Cq values incomparable across a plate, which defeats the purpose.
  Estimate the noise across the wells in the group — the `subsetPopRDBaseLinePref` setting (**5**)
  suggests using a subset of the population rather than every well.

  The **fluorophore**, specifically, is the right grouping, and this is one of the few places the
  file format settles the question: CFX persists `thresholdOverrideValue` and
  `autoCalculateThreshold` under `fluorDataAnalysisParam fluorId=…` (§1), one entry per dye. There
  is no per-target threshold anywhere in the format. That matches the physics — baseline noise is a
  property of the dye, the optics and the well, while the target is a biological label attached to
  the same physical measurement — and grouping by target instead splits one dye's wells into
  cohorts differing only in what the experimenter called them. Observed on `20260720.zpcr`, whose
  three loaded Texas Red wells carry two targets (HMPV Ma in A3/B3, PIV3 Bo in D3): grouping by
  target gave them thresholds of **162 and 49 RFU** for near-identical curves, and left PIV3 Bo's
  cohort a single well, so its "median noise" was that one well with no robustness at all.
- **Floor the threshold.** If a plate contains only flat wells, the noise estimate collapses and
  the threshold approaches zero, so every well "crosses" at cycle 1. Impose a minimum absolute RFU.
  `autoThreshold()` takes a `minThreshold` but defaults it to **0**, i.e. no floor, since no
  defensible absolute value has been pinned down. In practice the §7 gates carry this weight
  instead: the amplification squelch and the baseline-validation check decide *which* wells report a
  Cq at all, and on the `20230829…SINGLE_STEP_` plate the same 33 wells report across every
  multiplier from 3.2 to 40 — the multiplier moves the values, not the population.

> A direct consequence, worth stating plainly: **a Cq is a property of a well *and the group it
> was computed with*, not of the well's curve alone.** Change the set of wells in the group and the
> median noise moves, the threshold moves, and a marginal well can gain or lose its Cq. So a Cq must
> be computed once per run over the whole group and then read, never recomputed over whatever subset
> a caller happens to be looking at. `packages/core/src/analysis.ts`'s `computeCqTable()` is the
> batch entry point that enforces this: one call over every curve of a run, one entry per
> well/fluorophore.

### 5.4 Manual override

`thresholdOverrideValue` (with `autoCalculateThreshold="False"`) pins the threshold to a fixed RFU.
This is the common choice when comparing runs, since an auto threshold recomputed per run makes Cq
values drift between plates. An implementation should treat the override as authoritative and skip
§5.1 entirely.

**Read the `fluorId`, not just the first entry.** A `.pcrd` carries a `fluorDataAnalysisParam` for
every fluorophore the software knows about, not only the ones on the plate, so the first override in
the document usually belongs to a dye the run never used. In `20260720_Luna_noRT.pcrd` the first is
`fluorId="13002"` at **38.70** — quoted as "the sample's override" in earlier revisions of this doc,
and wrong: the plate's own dyes are `fluorId` 5 (FAM) and 12 (Texas Red), both **210.72**, plus
`fluorId` 4 (Cy5) on `autoCalculateThreshold="True"` with no override at all. Only the two 210.72
values are usable as calibration anchors (§5.1).

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
- **Do *not* add a serial-correlation gate here.** Rejecting a region whose residuals aren't white
  (§5.3) looks like the natural companion to the flatness/linearity check and is not: the von
  Neumann ratio is scale-free, so it cannot tell structure that matters from structure below the
  instrument's resolution, and it fires hardest on the cleanest curves. Tried and abandoned — see
  §5.3 for the measurements. The ratio belongs in region *selection* (§3.4) and in diagnostics.
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
| Baseline region | Auto, never starting before cycle 2; else cycles 2–9 |
| Baseline start-trim (§3.4) | On; target ratio 1.0, min width 8, max trim 15 cycles |
| Noise statistic (§5.2) | Successive difference (MSSD), not standard deviation |
| Cycles dropped from the noise estimate | 1 (the region's first) |
| Minimum baseline width | 3 cycles |
| Baseline mode | Linear (fitted line subtracted) |
| Baseline region method | Data window over the full run |
| Threshold group | The fluorophore (§5.1) — never the target |
| Threshold | Manual override if present, else ≈20 × baseline noise (§5.1) |
| Cq algorithm | Threshold crossing, log-interpolated |
| No Cq if trace ends under threshold | On |

## 9. Open items

- **Partially implemented.** `baseline.ts` covers §2–§4 (smoothing, baseline region including
  §3.4's start-trim, baseline subtraction, and the §7 validation gate via `validateBaselineRegion()`)
  and
  `threshold.ts` covers §5–§7 (threshold determination, both Cq algorithms, the amplification
  squelch). Not implemented: the `pDriftCorrection` reference-normalization baseline modes and
  `LinearBaseLineNormalizedCurveFit`'s refinement.
- **The threshold multiplier rests on two data points.** §5.1's scale is fixed by the two
  fluorophores of `20260720_Luna_noRT.pcrd` for which CFX persisted an explicit
  `thresholdOverrideValue` (FAM and Texas Red, both 210.72; Cy5 is on auto and is not an anchor).
  Under §5.2's estimator they imply 85.3× and 79.6× — agreeing within 7%, but from one run on one
  instrument, sharing a single override value. The shipped default of **20** sits far below that,
  on the strength of how the resulting Cq values read rather than any measurement, and closing that
  4× gap is the largest open question in this document. More runs carrying
  `autoCalculateThreshold="False"` would either confirm the constant or reveal that it tracks
  something else (dye, chemistry, plate type). Since the multiplier sets how early every Cq lands,
  this remains the single largest source of *systematic* error left in the chain — though it is now
  a uniform one, where the old std-dev estimator made it vary per well.
- **The noise estimator is inferred, not observed.** §5.2's successive-difference statistic is
  argued from first principles and from the fact that it makes the two anchors above mutually
  consistent (2.2× disagreement → 7%). That is real evidence, but it is *indirect*: nothing in the
  format says what CFX computes, and a different estimator paired with a different multiplier could
  fit the same two numbers. `baselineNoise()` keeps `residualStdDev` selectable so the comparison
  can be redone if more anchors turn up.
- **A robust successive-difference variant is untested.** The MSSD estimator is immune to smooth
  trend but slightly *more* sensitive to isolated spikes than a standard deviation (a spike enters
  two differences). A median-of-absolute-differences form would be robust to both; it needs a
  consistency constant (≈1.048 for Gaussian residuals) that nothing here has been measured against,
  so it was not shipped.
- **Persisted analysis parameters are not yet honoured.** A `.pcrd` carries the whole
  `dataAnalysisParameters` tree — including the per-fluorophore `thresholdOverrideValue` /
  `autoCalculateThreshold` pair that §5.4 says should be authoritative, and the
  `baselineBeginRepeat` / `baselineEndRepeat` region. Reading them would make a `.pcrd` reproduce
  CFX's own numbers exactly rather than approximately. A `.zpcr` stores none of this, so auto
  selection remains the only path there.
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
