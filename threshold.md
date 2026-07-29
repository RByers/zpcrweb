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

> **Status: implemented (§2–§7). The Cq stage is now validated exactly against CFX's own
> output; the baseline stage is not.** `packages/core/src/baseline.ts` implements smoothing,
> baseline-region selection (both automatic strategies plus the §3.4 start-trim) and baseline
> subtraction (the `Raw`/`RawBaseLineSubtracted`/`LinearBaseLineNormalized` modes).
> `packages/core/src/threshold.ts` implements threshold determination (manual override or auto,
> §5), both Cq algorithms (threshold crossing and curve-shape inflection, §6) and the
> amplification squelch (§7). `packages/core/src/stats.ts` holds the statistics both stages share.
>
> **§0 is the part to read first.** As of 2026-07-28 a run exists in `samples/` with both the
> saved experiment *and* CFX's own exported results for it — per-cycle baseline-corrected RFU,
> per-well Cq, and end-point RFU. That turns most of §5–§7 from "a reasonable algorithm" into a
> measurement, and several of this document's recommendations turn out to be **wrong**. §0 records
> what was measured and flags every section it overturns; those sections carry inline
> `**Superseded**` notes. Nothing has been changed in the code yet.
>
> **On agreement with CFX.** Away from what §0 pins down, Bio-Rad documents none of the algorithms
> below — only the *option names and values* a saved run persists are observable. So each section
> flags whether a choice is (a) **read from the file** or **measured against exported results**,
> and therefore certain; (b) **inferred**; or (c) **this library's own**, with no evidence either
> way. The option names and default values quoted are those a real CFX run persists — observable
> in the committed samples `20260720_Luna_noRT.pcrd` and `20260726_S183-S185_RVP.pcrd`, whose
> analysis parameters are described in [`pcrd.md`](./pcrd.md) §2.5.

---

## 0. Ground truth: what CFX's own exported results show

*Everything in this section is **measured**, from data files only. Reproduce it with the scripts
described at the end of the section.*

### 0.1 The dataset

`samples/20260726_S183-S185_RVP.pcrd` is a 45-cycle, 3-fluorophore (FAM, Cy5, Tex 615) run.
Alongside it, `samples/20260726_S183-S185_RVP-export.zip` holds the CSVs CFX Manager exports for
that same experiment:

| Export | What it gives |
|---|---|
| `Quantification Amplification Results_<fluor>.csv` | **CFX's own baseline-corrected RFU, per cycle, per well.** The output of §2–§4. |
| `Quantification Cq Results_0.csv` | CFX's Cq per well/fluor, to 15 significant digits. The output of §5–§6. |
| `End Point Results_<fluor>.csv` | End RFU and the end-point call per well. |
| `Quantification Plate View`, `Summary`, `Standard Curve`, `Melt Curve`, `Gene Expression` | Derived views over the same numbers. |

So the *input* to §5–§6 (the corrected curve) and the *output* (the Cq) are both known exactly,
independently of whether this library's §2–§4 reproduce the correction. That makes the threshold
and Cq stages directly checkable, and they now check out to the last bit.

A second file, `20260726_S183-S185_RVP-drift-correction.pcrd`, is the same experiment re-saved
with `pDriftCorrection="True"` and nothing else changed — an A/B pair for the drift-correction
question in [`calibration.md`](./calibration.md) §6, once a matching export exists for it.

### 0.2 The Cq rule, reproduced exactly

Feeding CFX's own corrected curves and its own persisted threshold into the rule below reproduces
**all 14 reported Cq values, and all 10 reported no-Cq wells, to ~1e-10 cycles** — i.e. exactly,
to the precision the CSV carries:

```
cq(y, T):                        # y = corrected RFU per cycle, indexed by cycle 1..N
  if T < min(y) or T > max(y):   return no Cq
  crossings = []
  for i in 2..N:
    if y[i] >= T and y[i-1] < T:
      m = (y[i] - y[i-1]) / (x[i] - x[i-1])        # x[i] = the cycle number, see §0.3
      if |m| < 1e-5: continue                      # reject a flat "crossing"
      xc = x[i-1] + (T - y[i-1]) / m               # two-point LINEAR interpolation
      run = number of further consecutive cycles with y strictly increasing
      crossings.append((run, xc)); skip i past that run
  if crossings empty: return no Cq
  return the last crossing with the largest `run`
```

Four things in that are different from what §6 currently recommends, and each is now settled:

1. **Linear interpolation, not logarithmic.** §6.1 recommends interpolating `log(corrected)`.
   CFX interpolates the corrected RFU itself, between exactly two points. Log interpolation gives
   a Cq a few hundredths of a cycle earlier and cannot match.
2. **The abscissa is the cycle number as exported** — 1, 2, 3, … — with no half-cycle offset.
   This was tested directly: solving each well's reported Cq back for the threshold that would
   produce it gives, per fluorophore, *the same threshold to 1e-12* under `x = cycle`, and values
   scattered over ±10% under `x = cycle + ½`. See §0.3.
3. **The selection rule is "longest following monotone-increasing run", not "the final run above
   threshold".** On clean curves they coincide. They differ on a curve that crosses, falls back
   and crosses again — see the well in §0.5.
4. **The only "no amplification" gate is `T ∉ [min(y), max(y)]`.** There is no amplification
   squelch, no baseline-validity gate, and no "no Cq if the trace ends under the threshold" rule.
   §7's gates and §6.1's `noCtIfEndsUnderThreshold` default have no counterpart in the reference.

### 0.3 Solving the reported Cq back for the threshold

The check that pins both the abscissa and the "one threshold per fluorophore" grouping. For each
well with a Cq, take the bracketing cycle pair and solve the linear interpolation for `T`:

| Fluor | Wells with a Cq | Implied `T`, `x = cycle` | Spread | Implied `T`, `x = cycle + ½` |
|---|---|---|---|---|
| FAM | 6 | **92.0212554931641** | 4e-12 | 60.9 … 68.2 |
| Tex 615 | 3 | **8.06451415811512** | 8e-13 | 1.2 … 7.5 |

Both readings are decisive, and the FAM value is independently confirmed: the `.pcrd` persists
`thresholdOverrideValue="92.0212554931641"` for `fluorId="5"` (FAM) — **the same 15 digits**. That
single equality validates the abscissa, the interpolation form, the per-fluorophore grouping and
the file field all at once.

### 0.4 The auto threshold is a curve-shape quantity, not a multiple of noise

The Tex 615 value is the more interesting one, because Tex 615 (`fluorId="11"`) is on
`autoCalculateThreshold="True"` with `thresholdOverrideValue="NaN"` — nothing is persisted, so
**8.0645 is a threshold CFX computed itself**, recovered here from its own outputs. It is the
first genuine auto-threshold anchor this project has had, and it does not fit §5.1's model:

- The two dyes' thresholds differ by **11×** (92.02 vs 8.06) on the same plate, in the same
  cycles, on the same wells. Their baseline noise does not: flat wells in both dyes jitter by
  ~1–3 RFU cycle-to-cycle. A noise multiple would have to be ~35× for FAM and ~3× for Tex 615.
- Nor does it track amplitude: FAM's amplifying wells rise to ~4800 RFU and Tex 615's to ~1700, a
  ratio of 3, not 11.
- 8.06 RFU is **0.5% of the rise** of the Tex 615 well that reaches 1574 RFU. No noise multiplier
  in §5.1's range (3–80) lands there from a ~1.5 RFU noise floor.

What does explain an 11× per-dye spread is a threshold read off **the shape of each curve** and
then averaged over the plate — a per-well "where does this curve leave its baseline" quantity,
which depends on how sharply each dye's curves turn, rather than on how noisy they are. §5.1
should be replaced by such a rule; the proposal is in §5.5.

### 0.5 Two wells that settle the quality-gate question

Both are Tex 615, both from the run above, and both are worth reading in full:

**B4 — pure noise, and CFX reports a Cq of 14.8211331477313.** Its corrected curve never
amplifies; it drifts from −24 RFU up to about +6 and sits there, ending at −1.8. Exactly one
cycle, cycle 15, pokes above the threshold at 8.5 RFU. CFX interpolates between cycle 14 (5.8) and
cycle 15 (8.5) and reports the crossing. So the reference has **no** amplification squelch, **no**
ends-below-threshold rule, and does **not** anchor to the final above-threshold run — this well's
only crossing is a single-point excursion followed by 30 cycles of decline.

**E4 — a clear monotone rise from 19.7 to 107 RFU, and CFX reports no Cq.** Not because it failed
any amplification test: because after baseline correction its *minimum* is 19.7, which is above
the 8.06 threshold, so `T < min(y)` and the curve is rejected as never having crossed. Its
baseline region evidently sits at the very start of a curve that rises from cycle 1.

Together they show the reference is far more permissive than §7 and far more literal than §6.1:
it asks only "does this curve cross this line", and answers with interpolation. Everything that
looks like quality control in CFX's output is a consequence of where the *threshold* landed, not
of a gate applied to the curve. That is a genuine simplification available to this library — see
§7.

### 0.6 The analyzed curve is not smoothed

§2's digital filter (`pCRDigitalFilter="WeightedMean"`, `smoothFilterWidthPref="5"`) does **not**
appear in the exported corrected curves, and neither does any other smoothing.

Test: for a flat well, take first differences of the corrected curve and measure their lag-1
autocorrelation. White noise gives −0.5; a width-5 triangular weighted mean of white noise gives
+0.5 (simulated, 4000 points). Measured over cycles 5–45 of every non-amplifying well in the run:

| Wells | lag-1 autocorrelation of first differences |
|---|---|
| 12 flat wells across Cy5, FAM, Tex 615 | **−0.26 … −0.60**, mean ≈ −0.42 |
| simulated white noise | −0.50 |
| simulated width-5 weighted mean | +0.50 |

Independently confirmed by §0.9, which reproduces the corrected curve from the raw dye curve to
**5e-3 RFU across all 45 cycles** on every non-amplifying well, with no filter of any kind in the
model. A width-5 weighted mean would leave residuals of tens of RFU.

So an implementation aiming to match CFX should **not smooth the curve that gets baselined,
thresholded and reported.** Smoothing belongs, if anywhere, inside onset detection (§3.2), where
it is a search heuristic over a curve nobody reports. This deletes a whole stage from the
pipeline and removes §2's "smoothing shifts Cq slightly" caveat along with it.

> **Correction — there *is* one filter, at the other end of the curve.** An earlier revision of
> this section also claimed that `LinearBaseLineNormalizedCurveFit`'s post-Cq refinement was
> absent, on the grounds that local roughness (RMS third difference) doesn't drop after the Cq.
> That test was wrong: it is swamped by the curvature of the exponential rise, which is exactly
> where the filter applies. §0.9 finds the filter, and it is exact — a width-3 centred mean over
> the curve's **tail only**. It does not affect the baseline, the threshold or the Cq, all of
> which are settled before it runs; it changes the reported RFU of the amplification plateau, and
> therefore the end-point RFU of §0.7.

### 0.7 End-point RFU: the mean of the last five cycles

The `End Point Results` export's **End RFU** column equals the arithmetic mean of the last **5**
values of the same well's corrected curve — exactly, to the CSV's full precision, for all 14 wells
across FAM and Tex 615. It is not the last value (which differs by up to 320 RFU on a
still-rising well), not the last 3, and not the last 10:

| Well (FAM) | End RFU | last value | mean of last 3 | **mean of last 5** | mean of last 10 |
|---|---|---|---|---|---|
| A4 | 674.826 | 906.139 | 796.622 | **674.826** | 395.067 |
| E9 | 4622.190 | 4653.062 | 4639.122 | **4622.190** | 4534.335 |
| H9 | 1418.779 | 1739.195 | 1607.959 | **1418.779** | 866.369 |
| C4 | −1.693 | 0.672 | −0.940 | **−1.693** | −0.793 |

This library has no end-point stage at all; §8a proposes one, since it is three lines and is the
only number some assays report.

### 0.8 The end-point call needs a negative control

Secondary, but observable. In the FAM export, wells at 2906/4622/4773/4059 RFU are called
`(+) Positive`, the well at 1419 RFU is the `Neg Ctrl` and is called `Negative`, and the well at
675 RFU — which *does* have a Cq of 38.14 — is `NoCall`. So the call threshold sits between 675
and 1419 and is derived from the negative control, not from a fixed RFU. In the Tex 615 export,
which has **no** negative control, every well is `Unassigned` regardless of its RFU (including one
at 1574). Cq and the end-point call are independent verdicts and disagree freely.

### 0.9 The baseline stage, solved

Subtracting the exported corrected curve from this library's own colour-separated raw dye curve
for the same well exposes CFX's baseline directly, and the answer is clean. Run the separation
(`calibration.md`) over `20260726_S183-S185_RVP.pcrd`, take `d = raw − corrected`, and:

**`d` is a straight line in the cycle number, to a residual RMS of 4–9 × 10⁻³ RFU** on 17 of the
24 exported curves. For a non-amplifying well that holds across all 45 cycles; for an amplifying
well it holds up to a break point identified below. So the correction really is

```
corrected[c] = raw[c] − (slope·c + intercept)
```

with `c` the cycle number — an ordinary linear baseline, subtracted from an unsmoothed curve,
exactly as §4's `LinearBaseLineNormalized` describes. Fitting `d` gives CFX's own `slope` and
`intercept` per well, to five significant figures.

#### The tail filter — `LinearBaseLineNormalizedCurveFit`, exactly

On a well with a Cq, `d` departs the straight line at one specific cycle and stays off it. On FAM
E9 (Cq 23.0733) the residual is a textbook line from cycle 1 to 25 — 2.45, 2.25, 2.05, … −2.37,
stepping by 0.205 a cycle — and then jumps to −43 at cycle 26. Modelling the departure as a
**width-3 centred mean applied to the corrected curve's tail** reproduces it exactly:

```
for c = floor(Cq) + 3 … N−1:                       # N = last cycle; the last cycle is NOT filtered
    out[c] = (corrected[c−1] + corrected[c] + corrected[c+1]) / 3
```

read from the *unfiltered* curve (a plain FIR pass, not applied in place — an in-place variant
was tried and is 7× worse). With that one line added, the full reconstruction of CFX's corrected
curve from the raw dye curve lands at **4–7 × 10⁻³ RFU RMS over all 45 cycles**, on curves
spanning 4653 RFU. Three details, each measured rather than assumed:

- **The start cycle is `floor(Cq) + 3`** — confirmed on all 9 wells with a Cq, across two dyes and
  Cq values from 14.8 to 38.1, with no exceptions.
- **The last cycle is left alone.** Duplicating the edge value instead leaves cycle 45 off by 4.4
  RFU while every other cycle is exact.
- **Everything before the start cycle is untouched**, so the baseline, the threshold and the Cq —
  all settled earlier — are unaffected. This filter is cosmetic, and it changes only the reported
  plateau RFU and hence the §0.7 end-point value.

That closes the "exact form of the curve-fit refinement" question §9 has carried since this
document was written: mode `LinearBaseLineNormalizedCurveFit` is mode `LinearBaseLineNormalized`
plus this three-point tail average.

#### The baseline window: recovered approximately, not exactly

With `slope` and `intercept` known per well, the remaining question is which cycles were fitted.
Searching every `(begin, end)` pair for the ordinary least-squares fit of the raw curve that
reproduces the recovered line gives a consistent and sensible picture:

| Well | Cq | Best-matching window |
|---|---|---|
| FAM B4, D4 | — | cycles 4–45 |
| FAM C4, Cy5 A4, B4, D4, E4, F4 | — | cycles 3–45 |
| Cy5 A9 | — | cycles 4–45 |
| FAM E9 | 23.07 | cycles 3–21 |
| FAM G9 | 23.00 | cycles 3–21 |
| FAM F9 | 21.87 | cycles 3–20 |

Two rules fall out. **A non-amplifying well is baselined over essentially the whole run** —
never the 2–9 default — which is the §3.2 failure mode already logged as the first entry in
[`TODO.md`](./TODO.md). **An amplifying well's baseline ends about two cycles before its Cq**:
the three clean positive controls above all give `round(Cq) − 2` exactly. Both begin at cycle 3
or 4, not the `baselineBeginRepeat="2"` the file persists.

**But no window is exact.** The best fit is off by 0.02–0.5 RFU on curves of thousands, and that
gap does not close under any variant tried: fitting the line to a smoothed copy of the curve
(triangular-5, boxcar-5, boxcar-3, with shrinking, skipped and clamped edge handling — 8
combinations), or forcing the slope to zero. Unsmoothed OLS remains the best of them and is still
not exact. Note this residual **cannot** be explained away by an error in this library's colour
separation: any affine difference between our raw curve and CFX's cancels out of the comparison
identically, and a non-affine one is bounded at 5e-3 RFU by the straight-line result above.

So the baseline *model* is settled and the window is known to within a cycle or two, but the exact
window-selection rule — and whatever makes the fit differ slightly from plain OLS — is not. The
practical consequence is small: reconstructing with the best-matching window instead of the exact
line moves the corrected curve by well under 1 RFU. Against a FAM threshold of 92 RFU that is
under 1% of a threshold crossing, so a Cq computed this way lands within a few thousandths of a
cycle of CFX's — but it is not the bit-exact agreement §0.2 achieves downstream.

#### A note on the wells that don't reach 5e-3

Seven curves — six Cy5 wells and Tex 615 G4 — fit the straight line only to 0.14–0.46 RFU rather
than 5e-3. That residual is *not* a baseline effect: it is present on flat, no-Cq curves where no
filter runs, and it is dye- and well-specific (Cy5 C4 misses while FAM C4 in the same well is
exact). It is a small colour-separation difference, ~2 × 10⁻⁴ relative, and it belongs to
[`calibration.md`](./calibration.md) rather than here. Well factors are ruled out — this `.pcrd`'s
`wellFactorsCollection` is the default identity table.

### 0.10 Reproducing these measurements

All of §0 comes from two inputs and no instrument: the export ZIP, and the `.pcrd`'s decrypted
XML (`parsePcrd` with the password, then the `dataAnalysisParameters` subtree — see
[`pcrd.md`](./pcrd.md) §2.5). The Cq check in §0.2 is ~40 lines: parse the amplification CSV into
`(cycle, well) → RFU`, parse the Cq CSV, run the pseudocode above with the per-fluor threshold,
and compare. It belongs in the test suite as a regression fixture — see §9.

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

> **Superseded by §0.6 — proposed change: don't smooth the analysed curve.** CFX's exported
> corrected curves are unsmoothed white noise about their baselines (lag-1 autocorrelation of
> first differences ≈ −0.5, where a width-5 weighted mean would give +0.5), even though the same
> run persists `pCRDigitalFilter="WeightedMean"` and `smoothFilterWidthPref="5"`. So the filter
> named in the file is not applied to the curve that is baselined, thresholded, reported and
> exported — it is presumably a display or internal-search setting.
>
> The proposed change is a deletion: default the analysis pipeline to `Disable`, keep
> `smoothCurve()` for onset detection (§3.2), where it operates on a curve nobody reports, and
> for the chart if a smoothed overlay is ever wanted. That removes the "smoothing shifts Cq
> slightly" trap below, removes the end-handling ambiguity, and removes the serial correlation
> that §3.4 currently has to work around by re-reading the unsmoothed curve. The rest of this
> section stays as documentation of what the option *means*, not of what to do with it.

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

**On a well that never amplifies, take the whole run.** §0.9's window search over CFX's own
corrected curves lands on cycles 2–45 (or 3–45) for every non-amplifying well in the RVP sample —
the entire trace, since there is no onset to stop before. That is a useful check on (a) and (b)
alike: both are onset detectors, and an onset detector applied to a curve with no onset must
return "no onset" rather than a plausible-looking early region. The first entry in
[`TODO.md`](./TODO.md) is this failure mode — a negative curve that rises for five cycles and then
goes flat, where the region should be the long flat tail and this library picks the start.

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

The size of the effect is per-well, which is what makes it damaging: on
`20260720_FirstQualification.zpcr`, wells A3
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
  white noise and passes trivially. Observed on well A3/FAM of
  `20260720_FirstQualification.zpcr` — a well that never
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
| `LinearBaseLineNormalizedCurveFit` | As above, **plus a width-3 centred mean over the curve's tail** (cycles `floor(Cq)+3` … `N−1`, last cycle excluded). Nothing about the baseline or the Cq is refined — see §0.9. **The observed default.** |
| `ReferenceNormalized` | Normalize against a reference dye/well before baselining (e.g. a passive reference). |
| `ReferenceLinearBaseLineNormalized` | Both: reference-normalize, then subtract a fitted line. |

`LinearBaseLineNormalizedCurveFit` is now fully specified — it is `LinearBaseLineNormalized`
followed by a single FIR pass over the tail, and §0.9 reproduces CFX's exported curve to 5e-3 RFU
with exactly that model. Since it is the observed default, implementing it is worth the three
lines: without it, every reported plateau RFU (and therefore every §8a end-point value) is off by
several RFU on an amplifying well.

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

### 5.1 Automatic — the noise-multiple rule (**superseded**, see §5.5)

> **Superseded by §0.4.** A CFX-computed auto threshold is now known exactly for one dye
> (Tex 615, **8.06451415811512**), alongside a persisted override for another on the same plate
> (FAM, **92.0212554931641**). They differ by **11×** while the two dyes' baseline noise differs
> by well under 2× and their amplitudes by 3×, so no single multiple of a noise statistic
> reproduces both. That is not a case for re-tuning the multiplier — it rules out the *form* of
> the rule. §5.5 proposes the replacement; the rest of §5.1 and all of §5.2 are kept because the
> noise statistic itself remains needed (for §3.4's start-trim and for diagnostics), and because
> the reasoning about estimator choice is still the best account of why a residual standard
> deviation is the wrong quantity to build anything on.
>
> Note what this does *not* change: the **grouping**. One threshold per fluorophore, shared by
> every well of that dye, is confirmed to 1e-12 by §0.3 — that part of §5.1 was right.

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
**4.2×** on `20260720_FirstQualification.zpcr` and **8.7×** on
`20230829_135443_CT019138_SINGLE_STEP_.zpcr` (median
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
  cohorts differing only in what the experimenter called them. Observed on
  `20260720_FirstQualification.zpcr`, whose three loaded Tex 615 wells carry two targets (HMPV Ma
  in A3/B3, PIV3 Bo in D3): grouping by
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

**Per-curve overrides are ours, not the format's.** `computeCqTable()` also accepts
`curveThresholdOverrides`, keyed by curve (one well, one fluorophore) rather than by group, and a
curve listed there uses that threshold whatever its group resolved to — auto or overridden. The
file format has no equivalent: CFX persists a threshold per `fluorId` and nothing finer. It exists
because §5.1's median deliberately refuses to follow any single well, which is right for the
default and leaves no way to correct one well whose baseline region or noise came out wrong
(§3.4, §5.2) without moving every other well of that dye with it. An overridden curve still joins
its group's noise cohort: its noise is a real measurement, and dropping it would change every
*other* curve's threshold as a side effect. `CqTableEntry.thresholdSource` reports which of the
three levels a given entry's threshold came from.

### 5.5 Proposed replacement: a per-curve shape threshold, averaged over the plate

*Proposed, not implemented. Motivated by §0.4 and testable against the one auto anchor there.*

The rule that fits the evidence is not "how noisy is the baseline" but "how far up its own rise
has each curve got when it stops looking like a baseline" — a **per-curve** quantity in RFU,
averaged into one plate-wide scalar per fluorophore. Sketch:

**Per well**, on the *raw* (unsmoothed, pre-subtraction) curve:

1. Find the amplification onset the way §3.2(a) already does — the rising limb, located from the
   smoothed curve's derivatives. Reuse the existing peak machinery; this is search, so smoothing
   is fine here (§0.6).
2. Take `xT` = the cycle, to sub-cycle resolution, of **maximum positive curvature on the rising
   limb** — the foot of the exponential, where the curve turns upward hardest. Not the
   second-derivative *peak* proper; the foot, for the reason §3.2 already gives.
3. Take `T_well_raw` = the curve's value at `xT`.
4. Convert into corrected space using that well's own fitted baseline line:
   `T_well = T_well_raw − (slope·xT + intercept)`. This is the step that makes per-well values
   comparable, and it is why the threshold is a property of the *shape*, not of the offset.

**Per fluorophore**: `T = mean(T_well)` over the wells that qualify — those whose baseline region
did **not** run to the end of the trace (a well with no detectable onset has no meaningful `T_well`
and must not drag the average), and whose `T_well` is finite. Restrict to `Unknown`, `Standard`
and positive-control wells if any exist; if none do, take every well.

Why this is the right shape of rule, on the evidence:

- It is a mean of per-curve RFU values, so it scales with **how each dye's curves rise**, not with
  their noise — which is what an 11× spread at constant noise demands.
- It naturally produces a *small* threshold (8 RFU) for a dye whose amplifying wells turn upward
  early and gently, and a large one (92 RFU) for a dye whose wells turn sharply — matching the two
  anchors' direction as well as their ratio.
- The mean, not the median: §5.1's median was chosen to stop one bad well moving the group. Under
  this rule the qualifying test does that job instead, and a mean is what the one available anchor
  should be checked against first.

**The test.** Implement it, run it on `20260726_S183-S185_RVP.pcrd`'s Tex 615 wells, and compare
against **8.06451415811512**. Then re-run FAM and compare against **92.0212554931641** — a value
that run persists as an *override*, so agreement there is suggestive rather than conclusive (a
user may have typed it), but disagreement by an order of magnitude would be conclusive the other
way. Two anchors, from one plate, sharing neither a value nor a dye: a much stronger constraint
than the two identical overrides §5.1 was built on.

Until that lands, the shipped multiplier stays where it is, and the web app's slider stays the
honest interface to a number that isn't yet known.

## 6. Cq — two algorithms

> Implemented by `findThresholdCrossing()` (§6.1), `findInflectionCq()` (§6.2) and `computeCq()`
> (dispatches between them, and applies the §7 squelch) in `packages/core/src/threshold.ts`.

`algorithmCtDetection` selects between them.

### 6.1 `Threshold` — the crossing (observed default)

> **Rewritten from §0.2, which reproduces CFX's reported Cq exactly (14/14 wells, 10/10 no-Cq
> wells, agreement to ~1e-10 cycles) given CFX's own corrected curves and threshold.** This is now
> the one stage of the pipeline that is *measured* rather than inferred, and it is also simpler
> than what this library currently does. Adopt it verbatim.

```
cq(corrected, T):
  if T < min(corrected) or T > max(corrected):   return no Cq
  best = none
  i = 2
  while i <= N:
    if corrected[i] >= T and corrected[i-1] < T:
      m = corrected[i] - corrected[i-1]                  # per cycle; x is the cycle number
      if |m| >= 1e-5:
        xc  = (i-1) + (T - corrected[i-1]) / m           # two-point LINEAR interpolation
        run = how many further consecutive cycles keep strictly increasing from i
        if run >= best.run:  best = (run, xc)            # >=, so later ties win
        i = i + run
    i = i + 1
  return best.xc, or no Cq if there was none
```

Four points, each of which changes the current implementation:

- **Interpolate linearly, between exactly two points.** Not in the log domain, and not by fitting a
  short line across several cycles. The exponential-decay argument for a log interpolation is
  physically appealing and is simply not what produces the reported numbers; it lands a few
  hundredths of a cycle early. This also deletes the `corrected[c−1] ≤ 0` special case, which only
  existed because the logarithm is undefined there.
- **The abscissa is the cycle number**, 1-based as the curve is indexed, with no half-cycle offset
  (§0.3 tests this directly and the two readings differ by ~10% in the implied threshold).
- **Choose the crossing followed by the longest strictly-increasing run**, not the start of the
  final above-threshold run. Ties go to the later crossing. The intent is the same — don't let an
  early noise spike over a low threshold be read as a cycle-2 Cq — but the rule is different, and
  on a single-point excursion followed by decline it *does* report a Cq where the "final run" rule
  reports none. §0.5's Tex 615 B4 is exactly that case, and CFX reports **14.82** for it.
- **Reject a crossing whose local slope is below `1e-5`**, then keep scanning. A curve that lies
  flat along the threshold produces no crossing rather than an arbitrary one.

Edge cases, now all consequences of the rule above rather than separate handling:

- **Never crosses.** No Cq. An empty Cq is a meaningful result.
- **Starts above threshold.** `T < min(corrected)` — no Cq, by the guard on the first line. This
  is *the* reason a well with an obvious rise can report nothing: §0.5's Tex 615 E4 climbs
  monotonically from 19.7 to 107 RFU and gets no Cq because its whole corrected curve sits above
  an 8.06 threshold. Worth surfacing in the UI as "baseline above threshold" rather than as
  "no amplification" — they look identical in the output and mean opposite things.
- **Ends below threshold.** Not a special case, and **not** a reason to withhold a Cq. The
  `noCtIfEndsUnderThreshold` option should default **off**: §0.5's B4 ends 10 RFU below the
  threshold it crossed at cycle 15 and is still reported.
- **Crosses, falls back, then crosses again.** Handled by the longest-run rule; no separate
  treatment.

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

> **Superseded in part by §0.5 — proposed change: stop letting these suppress a Cq.** The
> reference applies none of the gates below. It reports a Cq for a well that is pure noise and
> touches the threshold once (Tex 615 B4, Cq 14.82), and withholds one from a well that rises
> cleanly by 87 RFU (Tex 615 E4) purely because the threshold fell below its corrected minimum.
> Its only test is §6.1's `T ∈ [min, max]`.
>
> That is a real simplification available here, and it is also a *correctness* change: as long as
> this library's gates can veto a crossing, its Cq population can never match CFX's, however well
> §5 and §6 are tuned. The proposal is to keep every gate as a **diagnostic** — `amplified`,
> `baselineValid` and the flatness/linearity verdicts stay on `CurveBaselineResult`, stay in the
> hover card, and stay available for sorting and filtering in the UI — but remove their power to
> turn a computed Cq into no Cq. `computeCq()` would lose its `baselineValid` option and its
> automatic squelch; callers that want the strict behaviour ask for it explicitly.
>
> Two caveats worth weighing before doing it. First, the gates were each added in response to a
> real, observed failure on a real well (§3.2's E9, §7's B5 and E5 below) — those failures don't
> stop being failures, they stop being *hidden*, which is arguably the honest outcome given a
> reference that also reports them. Second, a permissive Cq rule is only safe if the threshold is
> right, and under §5.1's current noise-multiple threshold it is not; §5.5 should land first, or
> at least alongside.
>
> The rest of this section describes the gates as they are, and stays accurate as a description of
> the diagnostics.

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

For an implementation aiming to match a reference instrument. **Proposed** column is what §0
argues for; **current** is what ships today.

| Setting | Current | Proposed | Basis |
|---|---|---|---|
| Cycles skipped (begin/end) | 0 / 0 | unchanged | read from file |
| Smoothing of the analysed curve | Weighted mean, width 5 | **Disable** | §0.6, measured |
| Smoothing inside onset detection | (same filter) | Weighted mean, width 5 | unchanged in effect |
| Baseline region, non-amplifying well | Auto; often an early region | **Essentially the whole run** | §0.9, measured |
| Baseline region, amplifying well | Auto, never before cycle 2 | Begin at cycle 3–4; end ≈ `round(Cq) − 2` | §0.9, measured |
| Baseline start-trim (§3.4) | On; ratio 1.0, min 8, max 15 | unchanged | this library's own |
| Tail filter for `…CurveFit` mode | not implemented | **Width-3 centred mean, cycles `floor(Cq)+3` … `N−1`** | **§0.9, measured** |
| Noise statistic (§5.2) | Successive difference (MSSD) | unchanged | still needed for §3.4 |
| Cycles dropped from the noise estimate | 1 | unchanged | this library's own |
| Minimum baseline width | 3 cycles | unchanged | inferred |
| Baseline mode | Linear (fitted line subtracted) | unchanged | read from file |
| Baseline region method | Data window over the full run | unchanged | read from file |
| Threshold group | The fluorophore | unchanged | **§0.3, measured to 1e-12** |
| Threshold source | Override if present, else ≈20 × noise | Override from the `.pcrd` if present (§5.4), else §5.5's shape rule | §0.3 / §0.4 |
| Cq abscissa | cycle index | unchanged — no ½-cycle offset | **§0.3, measured** |
| Cq interpolation | Log, linear fallback | **Two-point linear** | **§0.2, measured** |
| Crossing selection | Start of final above-threshold run | **Longest following increasing run, last on ties** | **§0.2, measured** |
| No Cq if trace ends under threshold | On | **Off** | **§0.5, measured** |
| Amplification squelch / baseline gate suppress Cq | On | **Off** (diagnostics only) | **§0.5, measured** |
| No Cq when `T ∉ [min, max]` of the corrected curve | implicit | **Explicit, and the only gate** | **§0.2, measured** |
| End-point RFU | not implemented | **Mean of the last 5 corrected cycles** | **§0.7, measured** |

### 8a. End-point RFU

*Proposed; §0.7 measures it exactly.* Some assays report no Cq at all and read the well's
end-point fluorescence instead, so this is worth having even though it is three lines:

```
endRfu = mean(corrected[N-4 .. N])       # the last five cycles
```

It belongs on `CqTableEntry` next to the Cq, computed in the same batch pass over the run, since
it is a function of the same corrected curve and the same baseline. Note it is deliberately *not*
`deltaRfu`, which `CurveBaselineResult` already carries: `deltaRfu` is the last value minus the
baseline mean, a rise; `endRfu` is a five-cycle average of the corrected curve, and on a
still-rising well the two differ by hundreds of RFU (§0.7's table).

The end-point **call** (`(+) Positive` / `Negative` / `NoCall` / `Unassigned`) is a separate
verdict that needs the plate's negative control (§0.8) and is not proposed here — but note that
CFX's call and its Cq disagree freely, so neither should be derived from the other.

## 9. Open items

Ordered by value. The first four are the proposed work; the rest is what remains genuinely
unknown.

1. **Adopt §6.1's crossing rule, and drop §7's gates to diagnostics.** Smallest change, largest
   effect, and the only one that is *measured* rather than argued: two-point linear interpolation
   on the cycle index, longest-following-run selection, `T ∈ [min, max]` as the sole gate, no
   ends-below-threshold rule. Land it with the §0.10 regression fixture — the export CSVs in
   `samples/20260726_S183-S185_RVP-export.zip` let `computeCq()` be asserted against CFX's own
   numbers to 1e-10, on a curve this library did not compute, so the test isolates §5–§6 from
   every upstream stage. **This library has never had a test like that; it should.**
2. **Honour the persisted per-fluorophore threshold** (§5.4, and the entry below). One line of
   plumbing, and it makes a `.pcrd` reproduce CFX's Cq exactly for every overridden dye — FAM in
   the RVP sample is such a dye, and §0.3 shows the whole chain then agrees.
3. **Implement the tail filter** of §0.9 for `LinearBaseLineNormalizedCurveFit` — the observed
   default mode, currently unimplemented. Three lines, exactly specified, and it is what makes the
   reported plateau (and §8a's end-point RFU) match rather than run several RFU high.
4. **Fix baseline-region selection for the two cases §0.9 pins down**: a non-amplifying well takes
   essentially the whole run, and an amplifying well ends around `round(Cq) − 2`. The first of
   these is the long-standing bug at the top of [`TODO.md`](./TODO.md), now with reference data
   behind it.
5. **Implement and test §5.5's shape threshold** against the 8.0645 anchor. This is the largest
   remaining source of systematic error and the one place a wrong answer moves every Cq on the
   plate.
6. **Stop smoothing the analysed curve** (§0.6, §2). A deletion, and it simplifies §3.4.
7. **Add end-point RFU** (§8a). Three lines, exactly known.

Still genuinely open:

- **Partially implemented.** `baseline.ts` covers §2–§4 (smoothing, baseline region including
  §3.4's start-trim, baseline subtraction, and the §7 validation gate via `validateBaselineRegion()`)
  and
  `threshold.ts` covers §5–§7 (threshold determination, both Cq algorithms, the amplification
  squelch). Not implemented: the `pDriftCorrection` reference-normalization baseline modes and
  `LinearBaseLineNormalizedCurveFit`'s refinement.
- **Drift correction is now A/B-testable but not tested.** `20260726_S183-S185_RVP.pcrd` and
  `20260726_S183-S185_RVP-drift-correction.pcrd` differ only in `pDriftCorrection`. Exporting the
  amplification results from the second one would show, per well and per cycle, exactly what the
  option does — the cheapest possible answer to a question [`calibration.md`](./calibration.md) §6
  and §4 of this document both leave open. **Worth asking for that export.**
- **The threshold multiplier rests on two data points, and §0.4 has now falsified the rule it
  belongs to.** §5.1's scale was fixed by the two fluorophores of `20260720_Luna_noRT.pcrd` for
  which CFX persisted an explicit `thresholdOverrideValue` (FAM and Texas Red, both 210.72). Under
  §5.2's estimator they implied 85.3× and 79.6×, against a shipped default of 20. That gap is no
  longer the largest open question — the RVP run's 11× per-dye spread at near-constant noise says
  no multiplier fits at all, and §5.5 replaces the rule rather than retuning it. The measurements
  in §5.1 are kept because they remain the best evidence for §5.2's *estimator*, which is still
  used elsewhere.
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
- **Persisted analysis parameters are not yet honoured** — see item 2 above, now with a
  measurement behind it. A `.pcrd` carries the whole `dataAnalysisParameters` tree, including the
  per-fluorophore `thresholdOverrideValue` / `autoCalculateThreshold` pair that §5.4 says should be
  authoritative, and the `baselineBeginRepeat` / `baselineEndRepeat` region. §0.3 shows that
  honouring the first of those reproduces CFX's Cq **exactly**, not approximately. A `.zpcr` stores
  none of this, so auto selection remains the only path there.

  Read `baselineBeginRepeat`/`baselineEndRepeat` with care, though: both RVP fluorophores persist
  `2`/`9` while also carrying `autoCalculateBaseline="True"`, so those two numbers are the
  *defaults the auto search starts from*, not the region CFX actually used — §0.9's window search
  puts several wells' regions nowhere near 2–9. Only trust them when `autoCalculateBaseline` is
  `False`.
- **The baseline *window* rule.** §0.9 settles the baseline model, the fit and the tail filter, and
  brackets the window (begin cycle 3–4; end at the last cycle for a non-amplifying well, or
  `round(Cq) − 2` for a clean amplifying one). What it does not settle is the rule that produces
  those windows in general, or why the best-matching ordinary least-squares fit still misses the
  recovered line by 0.02–0.5 RFU when eight smoothing/edge variants and a zero-slope variant were
  all tried. The residual is small enough that a Cq built on the best-matching window lands within
  a few thousandths of a cycle, so this is now a precision question rather than a correctness one.
- **Validated end-to-end except for that window.** §0.2 reproduces the Cq stage exactly and §0.9
  reproduces the corrected curve from the raw dye curve to 5e-3 RFU *given CFX's own baseline
  line*. What has not been demonstrated is this library choosing the same window unaided.
- `dataWindowFractionFullCycle` / `dataWindowWidthFractionFullCycle` are interpreted here as a
  position and width; with the observed values (1 and 0.99) the two readings are
  indistinguishable, so this needs a run that uses a genuine sub-window to confirm.
- `pCRDisplayMode` (`SinglePoint` vs `AllPoints`) is understood to select how a multi-read cycle
  is reduced to one value per cycle, but its interaction with Cq has not been checked.
