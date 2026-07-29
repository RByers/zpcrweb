# Baseline, Threshold and Cq

Colour separation ([`calibration.md`](./calibration.md)) turns raw channel readings into a per-dye
amplification curve: one fluorescence value per cycle, per well, per dye. That curve is still not
a *result*. Turning it into the number a qPCR run actually reports — the **quantification cycle**,
Cq (also written Ct) — takes three more stages:

1. Pick a **baseline region** and fit a straight line to it (§3).
2. **Subtract** that line, so an unamplified well sits at zero (§4).
3. Pick a **threshold** (§5) and find where the corrected curve crosses it (§6).

Cq is the (fractional) cycle number at which a well's signal becomes reliably distinguishable from
its own noise. Everything below exists to make that judgement reproducible.

> **Status.** §3–§8 are implemented, in `packages/core/src/baseline.ts` (region, subtraction,
> plateau filter, end-point RFU), `packages/core/src/threshold.ts` (noise, threshold, Cq) and
> `packages/core/src/analysis.ts` (the per-run pass that ties them together). §9 lists what is
> deliberately **not** implemented, and what remains genuinely unknown.
>
> **§1 is the part to read first.** One run in `samples/` ships with both the saved experiment
> *and* CFX Manager's own exported results for it, which turns most of this document from "a
> reasonable algorithm" into a measurement. Every section below says where its content comes from:
> **measured** against those results, **read from the file**, or **this library's own** choice with
> no evidence either way. That distinction matters, because exactly one number in the shipped
> pipeline is in the last category — the auto-threshold multiplier of §5.2 — and it is the one that
> most affects where every Cq lands.

---

## 1. Ground truth: CFX's own exported results

*Measured, from data files only. `packages/core/test/cfxExport.test.ts` is the executable form of
§1.2, §1.4 and §1.5, and needs no password.*

### 1.1 The dataset

`samples/20260726_S183-S185_RVP.pcrd` is a 45-cycle, 3-fluorophore (FAM, Cy5, Tex 615) run.
Alongside it, `samples/20260726_S183-S185_RVP-export.zip` holds the CSVs CFX Manager exports for
that same experiment:

| Export | What it gives |
|---|---|
| `Quantification Amplification Results_<fluor>.csv` | **CFX's own baseline-corrected RFU, per cycle, per well.** The output of §3–§4. |
| `Quantification Cq Results_0.csv` | CFX's Cq per well/fluor, to 15 significant digits. The output of §5–§6. |
| `End Point Results_<fluor>.csv` | End RFU and the end-point call per well. |
| `Quantification Plate View`, `Summary`, `Standard Curve`, `Melt Curve`, `Gene Expression` | Derived views over the same numbers. |

So the *input* to §5–§6 (the corrected curve) and the *output* (the Cq) are both known exactly,
independently of whether this library's §3–§4 reproduce the correction. That makes the threshold
and Cq stages directly checkable, and they check out to the last bit.

A second file, `20260726_S183-S185_RVP-drift-correction.pcrd`, is the same experiment re-saved
with `pDriftCorrection="True"` and nothing else changed — an A/B pair for the drift-correction
question in [`calibration.md`](./calibration.md) §6, once a matching export exists for it.

### 1.2 The Cq rule, reproduced exactly

Feeding CFX's own corrected curves and its own threshold into §6's rule reproduces **all 14
reported Cq values, and all 10 reported no-Cq wells, to ~1e-10 cycles** — i.e. exactly, to the
precision the CSV carries. Four things about it are worth stating as measurements rather than as
implementation details, because each replaced a plausible alternative this library had shipped:

1. **Linear interpolation, not logarithmic.** CFX interpolates the corrected RFU itself, between
   exactly two points. Log interpolation is physically appealing — the curve really is roughly
   exponential between reads — and lands a few hundredths of a cycle early, so it cannot match.
2. **The abscissa is the cycle number as exported** — 1, 2, 3, … — with no half-cycle offset. See
   §1.3, which tests this directly.
3. **The crossing is selected by the longest following monotone-increasing run**, not by taking
   the start of the final above-threshold run. On clean curves the two coincide; they differ on a
   curve that crosses, falls back and crosses again (§1.4).
4. **The only "no amplification" gate is `T ∉ [min(y), max(y)]`.** There is no amplification
   squelch, no baseline-validity gate, and no "no Cq if the trace ends under the threshold" rule.

### 1.3 Solving the reported Cq back for the threshold

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

### 1.4 Two wells that settle the quality-gate question

Both are Tex 615, both from the run above:

**B4 — pure noise, and CFX reports a Cq of 14.8211331477313.** Its corrected curve never
amplifies; it drifts from −24 RFU up to about +6 and sits there, ending at −1.8. Exactly one
cycle, cycle 15, pokes above the threshold at 8.5 RFU. CFX interpolates between cycle 14 (5.8) and
cycle 15 (8.5) and reports the crossing.

**E4 — a clear monotone rise from 19.7 to 107 RFU, and CFX reports no Cq.** Not because it failed
any amplification test: because after baseline correction its *minimum* is 19.7, which is above
the 8.06 threshold, so `T < min(y)` and the curve never crosses.

Together they show the reference asks only "does this curve cross this line", and answers with
interpolation. Everything that looks like quality control in CFX's output is a consequence of
where the *threshold* landed, not of a gate applied to the curve — which is a real simplification,
and the reason §7's checks are diagnostics rather than vetoes.

### 1.5 End-point RFU: the mean of the last five cycles

The `End Point Results` export's **End RFU** column equals the arithmetic mean of the last **5**
values of the same well's corrected curve — exactly, to the CSV's full precision, for all 14 wells
across FAM and Tex 615. It is not the last value (which differs by up to 320 RFU on a still-rising
well), not the last 3, and not the last 10:

| Well (FAM) | End RFU | last value | mean of last 3 | **mean of last 5** | mean of last 10 |
|---|---|---|---|---|---|
| A4 | 674.826 | 906.139 | 796.622 | **674.826** | 395.067 |
| E9 | 4622.190 | 4653.062 | 4639.122 | **4622.190** | 4534.335 |
| H9 | 1418.779 | 1739.195 | 1607.959 | **1418.779** | 866.369 |
| C4 | −1.693 | 0.672 | −0.940 | **−1.693** | −0.793 |

### 1.6 The analysed curve is not smoothed

The digital filter the file names (`pCRDigitalFilter="WeightedMean"`, `smoothFilterWidthPref="5"`)
does **not** appear in the exported corrected curves, and neither does any other smoothing.

Test: for a flat well, take first differences of the corrected curve and measure their lag-1
autocorrelation. White noise gives −0.5; a width-5 triangular weighted mean of white noise gives
+0.5 (simulated, 4000 points). Measured over cycles 5–45 of every non-amplifying well in the run:

| Wells | lag-1 autocorrelation of first differences |
|---|---|
| 12 flat wells across Cy5, FAM, Tex 615 | **−0.26 … −0.60**, mean ≈ −0.42 |
| simulated white noise | −0.50 |
| simulated width-5 weighted mean | +0.50 |

Independently confirmed by §1.7, which reproduces the corrected curve from the raw dye curve to
5e-3 RFU with no filter of any kind in the model; a width-5 weighted mean would leave residuals of
tens of RFU. So the filter named in the file is not applied to the curve that is baselined,
thresholded, reported and exported — and this library does not smooth it either. That deleted a
whole stage from the pipeline.

### 1.7 The baseline stage, recovered

Subtracting the exported corrected curve from this library's own colour-separated raw dye curve
for the same well exposes CFX's baseline directly. Take `d = raw − corrected`, and:

**`d` is a straight line in the cycle number, to a residual RMS of 4–9 × 10⁻³ RFU** on 17 of the
24 exported curves. For a non-amplifying well that holds across all 45 cycles; for an amplifying
well it holds up to a break point identified below. So the correction is

```
corrected[c] = raw[c] − (slope·c + intercept)
```

with `c` the cycle number — an ordinary linear baseline subtracted from an unsmoothed curve.
Fitting `d` gives CFX's own `slope` and `intercept` per well, to five significant figures.

#### The plateau filter

On a well with a Cq, `d` departs the straight line at one specific cycle and stays off it. On FAM
E9 (Cq 23.0733) the residual is a textbook line from cycle 1 to 25 — 2.45, 2.25, 2.05, … −2.37,
stepping by 0.205 a cycle — and then jumps to −43 at cycle 26. Modelling the departure as a
**width-3 centred mean applied to the corrected curve's tail** reproduces it exactly:

```
for c = floor(Cq) + 3 … N−1:                       # N = last cycle; the last cycle is NOT filtered
    out[c] = (corrected[c−1] + corrected[c] + corrected[c+1]) / 3
```

read from the *unfiltered* curve (a plain FIR pass, not applied in place — an in-place variant was
tried and is 7× worse). With that one line, the full reconstruction of CFX's corrected curve from
the raw dye curve lands at **4–7 × 10⁻³ RFU RMS over all 45 cycles**, on curves spanning 4653 RFU.
Three details, each measured rather than assumed:

- **The start cycle is `floor(Cq) + 3`** — confirmed on all 9 wells with a Cq, across two dyes and
  Cq values from 14.8 to 38.1, with no exceptions.
- **The last cycle is left alone.** Duplicating the edge value instead leaves cycle 45 off by 4.4
  RFU while every other cycle is exact.
- **Everything before the start cycle is untouched**, so the baseline, the threshold and the Cq are
  unaffected. This filter changes only the reported plateau, and hence the §1.5 end-point value.

This is what the mode name `LinearBaseLineNormalizedCurveFit` denotes: `LinearBaseLineNormalized`
plus this three-point tail average.

#### The baseline window

With `slope` and `intercept` known per well, the remaining question is which cycles were fitted.
Searching every `(begin, end)` pair for the ordinary least-squares fit that reproduces the
recovered line gives a consistent picture:

| Well | Cq | Best-matching window |
|---|---|---|
| FAM B4, D4 | — | cycles 4–45 |
| FAM C4, Cy5 A4, B4, D4, E4, F4 | — | cycles 3–45 |
| Cy5 A9 | — | cycles 4–45 |
| FAM E9 | 23.07 | cycles 3–21 |
| FAM G9 | 23.00 | cycles 3–21 |
| FAM F9 | 21.87 | cycles 3–20 |

Two rules fall out, and they are the ones §3 implements. **A non-amplifying well is baselined over
essentially the whole run** — never the 2–9 the file's own `baselineBeginRepeat`/`EndRepeat`
suggest. **An amplifying well's baseline ends about two cycles before its Cq**: the three clean
positive controls above all give `round(Cq) − 2` exactly. Both begin at cycle 3 or 4.

**But no window is exact.** The best fit is off by 0.02–0.5 RFU on curves of thousands, and that
gap does not close under any variant tried: fitting the line to a smoothed copy of the curve
(triangular-5, boxcar-5, boxcar-3, with shrinking, skipped and clamped edge handling — 8
combinations), or forcing the slope to zero. This residual **cannot** be an error in this
library's colour separation: any affine difference between our raw curve and CFX's cancels out of
the comparison identically, and a non-affine one is bounded at 5e-3 RFU by the straight-line result
above. So the baseline *model* is settled and the window is known to within a cycle or two; the
exact window-selection rule is not (§9).

### 1.8 End to end

Running the shipped pipeline — this library's colour separation, §3's regions, §6's Cq — over the
RVP run, with the run's own persisted FAM threshold honoured (§5.3) and Tex 615 on its recovered
value, against CFX's reported Cq:

| Fluor | Well | This library | CFX | Δ cycles |
|---|---|---|---|---|
| FAM | A4 | 38.150 | 38.144 | 0.006 |
| FAM | E4 | 24.857 | 24.848 | 0.009 |
| FAM | E9 | 23.030 | 23.073 | 0.043 |
| FAM | F9 | 21.792 | 21.875 | 0.083 |
| FAM | G9 | 22.895 | 23.002 | 0.107 |
| FAM | H9 | 36.670 | 36.623 | 0.047 |
| Tex 615 | A4 | 32.410 | 32.346 | 0.064 |

Every well CFX quantifies is quantified here, within 0.11 cycles, and every FAM and Cy5 well CFX
leaves unquantified is unquantified here too. The residual is the baseline window of §1.7, not the
Cq rule: given CFX's *own* corrected curves the agreement is 1e-10. Three wells disagree, all Tex
615 — B4 and G4, where CFX reports a Cq against a threshold of 8 RFU that sits inside those wells'
own jitter (§1.4) and this library reports none, and E4, which the two baseline differently.

---

## 2. Where the options live

*Read from the file.* A saved experiment stores these settings **per fluorophore**:

```xml
<dataAnalysisParameters algorithmCtDetection="Threshold" …>
  <dataAnalysisParam smoothFilterWidthPref="5" subsetPopRDBaseLinePref="5"
                     BeginCyclesSkip="0" EndCyclesSkip="0" …>
    <fluorsDataAnalysisParams>
      <fluorDataAnalysisParam fluorId="5">
        <pCRDataAnalysisParams
            pCRBaseLine="LinearBaseLineNormalizedCurveFit"
            pCRBaseLineMethod="DataWindow"
            pCRDigitalFilter="WeightedMean"
            autoCalculateBaseline="True"
            autoCalculateThreshold="False"
            baselineBeginRepeat="2" baselineEndRepeat="9"
            thresholdOverrideValue="92.0212554931641"
            dataWindowFractionFullCycle="1"
            dataWindowWidthFractionFullCycle="0.99"
            pDriftCorrection="False" />
```

Of these, exactly one is read by this library: `thresholdOverrideValue`, when
`autoCalculateThreshold` is `False` (§5.3). The rest are either measured to be inert
(`pCRDigitalFilter`, §1.6), measured to describe something other than what CFX actually did
(`baselineBeginRepeat`/`EndRepeat`, §1.7 — they are the defaults the auto search starts from, and
several wells' real regions are nowhere near them), or unexercised by any sample
(`BeginCyclesSkip`, `pCRBaseLineMethod`'s `FullScan`, the `Reference…` baseline modes — §9).
`pDriftCorrection` sits in this group even though it is a baseline setting rather than an optical
one; see [`calibration.md`](./calibration.md) §6. The whole subtree is described in
[`pcrd.md`](./pcrd.md) §2.5.

## 3. The baseline region

> *Measured (§1.7).* Implemented by `baselineRegion()` in `packages/core/src/baseline.ts`.

```
begin = 3
end   = (no Cq) ? the last cycle : round(Cq) − 2
```

widened to at least 5 cycles and clamped to the run. That is the whole rule, and each part is a
recovered fact:

- **Begin at cycle 3.** Every window recovered in §1.7 begins at cycle 3 or 4 — never at 1, and
  never at the `baselineBeginRepeat="2"` the same file persists. Block and optics are still
  settling over the run's first reads, so those points sit off the line the rest of the region
  describes and tilt the fit.
- **A well with no Cq is baselined over the whole run.** There is no onset to stop before. This is
  also the fix for a long-standing bug in this library: a negative curve that rises for five cycles
  and then goes flat should be described by its long flat tail, and onset detection used to seize
  on the early rise instead.
- **A well with a Cq stops two cycles short of it.** The exponential's foot lifts the curve
  measurably a cycle or two before it reaches the threshold, and a baseline fitted through that
  foot tilts upward and drags every later value down.

**The region depends on the Cq, and the Cq depends on the region**, so the two are iterated to a
fixed point: correct over the whole run, take a Cq, re-fit ending before it, repeat until the
region stops moving (`baselineCorrectCurve`; two or three passes in practice). At the run level
`computeCqTable` does this in two passes over the whole plate — whole-run baselines to get each
group's threshold, then every curve re-baselined against that threshold, then the thresholds
re-resolved from the improved noise. Regions are always placed with a group's **automatic**
threshold, never an override of either kind: where a curve stops looking like a baseline is a
property of the curve, and letting an override move baselines would make one well's edit change
its plate-mates' noise, and through the group median their thresholds.

This rule replaced two onset detectors (a second-derivative peak finder and an iterative
regression), a whiteness-based start trim and a flatness/linearity validation gate — together
about a dozen tuning constants, none of them measured. What they were for is now either handled by
the rule above (the whole-run case) or was compensating for the gates §7 no longer applies.

## 4. Baseline subtraction

> *Measured (§1.7).* Implemented by `subtractBaseline()` and `smoothPlateauTail()`.

`pCRBaseLine` names six modes; they form a ladder:

| Mode | Meaning |
|---|---|
| `Raw` | No correction. |
| `RawBaseLineSubtracted` | Subtract a constant, the region's mean. |
| `LinearBaseLineNormalized` | Fit a straight line to the region by ordinary least squares and subtract it across all cycles. **What this library uses for every Cq.** |
| `LinearBaseLineNormalizedCurveFit` | The above plus §1.7's plateau filter. **The observed instrument default**; implemented as a separate pass, since it changes no Cq — only the reported plateau, and so §8's end-point RFU. |
| `ReferenceNormalized`, `ReferenceLinearBaseLineNormalized` | Normalize against a passive reference dye first. Not implemented — §9. |

```
constant:  corrected[c] = y[c] − mean(y[begin..end])
linear:    fit y = m·c + b over [begin..end];  corrected[c] = y[c] − (m·c + b)
```

The linear form is strictly better when the instrument shows any drift over the run, and reduces
to the constant form when `m ≈ 0`.

## 5. The threshold

> Implemented by `baselineNoise()`, `autoThreshold()` and `resolveThreshold()` in
> `packages/core/src/threshold.ts`.

### 5.1 What "noise" means

*This library's own; CFX's statistic is not documented and not observable.*

The baseline noise of a well is the **median absolute second difference** of its corrected curve
over the baseline region, scaled to σ by `1 / (0.6745 × √6) ≈ 0.6053` — the factor that makes it
agree with a standard deviation on white noise, and arithmetic rather than a tuning knob. Two
alternatives were rejected, both for the same reason: the statistic has to survive being computed
over a region the baseline does *not* describe, because §3's first pass deliberately baselines
every curve across its own amplification.

- A **standard deviation** about the fitted line answers "how far is this curve from my model?",
  not "how much does it jitter". Measured over the committed samples, `stdDev ÷ jitter` runs to
  4.2× on `20260720_FirstQualification.zpcr` and 8.7× on
  `20230829_135443_CT019138_SINGLE_STEP_.zpcr` — that ratio is baseline mis-fit being reported as
  noise, per well, which is exactly what makes Cq incomparable across a plate.
- **Root-mean-square successive differences** (the MSSD, which this library shipped previously) fix
  the offset half of that but not the rest: a leftover slope puts a constant into every difference,
  and an amplifying well leaves a huge one in the differences across its rise.

A median of second differences is blind to both — second differences of any straight line are
zero, and a rise occupying a minority of the region cannot move a median — and it agrees with the
other two on a region that really is a line plus white noise, so it is a strict improvement rather
than a different answer.

### 5.2 The automatic threshold, and why it is a default rather than a reproduction

*This library's own. **The one number in the shipped pipeline with no measurement behind it.***

```
T = multiplier × median(baseline noise over the fluorophore's wells)      multiplier = 20
```

One threshold per **fluorophore**, from the **median** so one unusual well cannot move the group.
Both of those parts are settled: §1.3 confirms the grouping to 1e-12, and the file format persists
thresholds per `fluorId` with no per-target equivalent anywhere. Grouping by target instead splits
one dye's wells into cohorts differing only in what the experimenter called them — observed on
`20260720_FirstQualification.zpcr`, whose three loaded Tex 615 wells carry two targets and used to
come out with thresholds 3.3× apart (162 vs 49 RFU) for near-identical curves, one cohort being a
single well.

The *multiplier* is the problem, and the evidence says the **form** of the rule is wrong rather
than the constant. The RVP run pins two of its three dyes' thresholds and bounds the third:

| Fluor | Threshold CFX used | How it is known | Baseline noise | Implied multiplier |
|---|---|---|---|---|
| FAM | 92.0212554931641 | persisted in the `.pcrd` | ~2.3 | ~40× |
| Tex 615 | 8.06451415811512 | recovered from its own Cq values (§1.3) | ~2.5 | ~3× |
| Cy5 | **> 278** | well D9 rises to 278.3 RFU and gets no Cq | ~1.8 | > 150× |

Three dyes on one plate, in the same cycles, with baseline noise within 40% of each other, and
thresholds spanning 35×. That rules out every noise-relative rule. It also rules out the
curve-shape rule this document used to propose — a per-well "where does this curve leave its
baseline" value in RFU, averaged over the plate — because **Cy5's threshold must exceed 278 RFU
while every Cy5 curve on the plate is flat noise**: the one well that amplifies leaves its baseline
at ~5 RFU, so nothing read off those curves' shapes can produce a number two orders of magnitude
larger. Scaling to amplitude fails the same way, and in the same direction: Cy5's amplifying well
is the *smallest* of the three dyes' and its threshold is the largest.

So the shipped rule is a defensible default — a threshold a few tens of multiples above the noise
floor sits above the jitter of a flat well and below the exponential's shoulder on an amplifying
one — and **the way to get exact agreement is to supply the threshold, not to compute it**. The
web app puts the multiplier on a slider for exactly this reason.

### 5.3 Manual overrides

*Read from the file, and measured (§1.3).*

`thresholdOverrideValue` with `autoCalculateThreshold="False"` is the threshold the instrument's
own analysis used, per fluorophore. `parsePcrd` decodes it into `Zpcr.persistedThresholds`, keyed
by dye name, and the web app **seeds its own per-fluorophore override with it** when a run loads.
That one value is what makes this app reproduce CFX's Cq exactly for an overridden dye.

Two details that cost time to learn:

- **Read the `fluorId`, not the first entry.** A `.pcrd` carries a `fluorDataAnalysisParam` for
  every fluorophore CFX knows about, not only the ones on the plate, so the first override in the
  document usually belongs to a dye the run never used. Ids are resolved against the plate's own
  `<dyeLayer><fluor fluorId= fluorName=>` entries, and an id with no dye layer is dropped rather
  than guessed at.
- **It seeds state; it is not a pipeline input.** A `.pcrd` and the `.zpcr` of the same run must
  quantify identically from the same measurement (see `apps/web/src/lib/runAnalysis.ts`), and a
  persisted threshold is a saved *decision*, not a measurement. Seeding an override makes it
  visible and editable in the Threshold rail instead of silently changing the arithmetic;
  `zpcrweb.json` — this app's own record of the same decision — outranks it.

The app also supports **per-curve** overrides, keyed by well and fluorophore, which outrank the
group's. The file format has no equivalent; they exist because §5.2's median deliberately refuses
to follow any single well, which is right for the default and leaves no other way to correct one
well whose baseline came out wrong. An overridden curve still joins its group's noise cohort: its
noise is a real measurement, and dropping it would change every *other* curve's threshold as a
side effect of editing this one.

> A consequence worth stating plainly: **a Cq is a property of a well *and the group it was
> computed with*, not of the well's curve alone.** Change the set of wells in the group and the
> median noise moves, the threshold moves, and a marginal well can gain or lose its Cq. So a Cq
> must be computed once per run over the whole plate and then read, never recomputed over whatever
> subset a caller happens to be looking at. `computeCqTable()` is the batch entry point that
> enforces this.

## 6. Cq

> *Measured (§1.2), exactly.* Implemented by `computeCq()` in `packages/core/src/threshold.ts`,
> and asserted against CFX's own numbers by `packages/core/test/cfxExport.test.ts`.

```
cq(y, T):                          # y = corrected RFU per cycle, indexed by cycle 1..N
  y = y[3..N]                      # the analysed range — see below
  if T < min(y) or T > max(y):   return no Cq
  crossings = []
  for i in 4..N:
    if y[i] >= T and y[i-1] < T:
      m = y[i] − y[i-1]                            # per cycle; x is the cycle number
      if |m| < 1e-5: continue                      # a curve lying flat along T has no crossing
      xc  = x[i-1] + (T − y[i-1]) / m              # two-point LINEAR interpolation
      run = number of further consecutive cycles with y strictly increasing
      crossings.append((run, xc)); skip i past that run
  return the last crossing with the largest `run`, or no Cq if there were none
```

Edge cases are consequences of the rule rather than separate handling:

- **Never crosses** ⇒ no Cq. An empty Cq is a meaningful result.
- **Starts above the threshold** ⇒ no Cq, by the guard on the first line. This is *the* reason a
  well with an obvious rise can report nothing (§1.4's E4). The app surfaces it in the Threshold
  rail as "the whole corrected curve sits above this threshold" rather than letting it look like a
  flat well: the two are indistinguishable in the output and mean opposite things.
- **Ends below the threshold** is not a special case and not a reason to withhold a Cq (§1.4's B4).
- **Crosses, falls back, crosses again** is handled by the longest-run rule.

**One narrowing, and the only one: the search starts at cycle 3** — §3's
`BASELINE_BEGIN_CYCLE`, the first cycle the baseline was fitted to describe — and `min`/`max` are
taken over the same range. *This library's own; the reference cannot settle it, because no
exported well has a transient like the one it exists for.*

It is not a quality gate: it adds no test a curve can fail, it states the domain the model is
defined on. §3 excludes the run's first reads from the fit **because** block and optics are still
settling there, so the corrected values at those cycles are extrapolations of a line deliberately
told not to model them, and reading a Cq off them is incoherent. Observed on well F1 of
`20230829_135443_CT019138_SINGLE_STEP_.zpcr`, a well that never amplifies: its raw trace decays
steeply over the first cycles (7590.7, 7593.2, 7576.0, 7544.3, 7525.2, …), leaving corrected
values of 55.0 and 63.9 at cycles 1–2 that straddle a 57.9 threshold. That was the only crossing
on the whole curve, and it produced a Cq of **1.32** for a flat well. Nothing measured is given
up: every Cq CFX reports is far past cycle 3, and the §1.2 regression test is unchanged by it.

`algorithmCtDetection` also names a `NoThreshold` mode, which takes Cq from the curve's shape (the
second-derivative maximum) instead of from a threshold. This library used to implement it; it is
deleted — see §9.

## 7. Quality diagnostics

> Implemented by `isAmplified()`; surfaced as `CurveBaselineResult.amplified`.

A curve counts as **amplified** when its total rise is at least 10× its baseline noise. This is a
label, **not a gate**: it never suppresses a Cq. §1.4 is why — the reference reports a Cq for a
pure-noise well that touches the threshold once, and withholds one from a well that rises cleanly
by 87 RFU, purely on `T ∈ [min, max]`.

This library previously let `amplified` and a baseline-validity check veto a Cq, and each was added
in response to a real failure on a real well. Those failures do not reappear as bad Cq values,
because §3's region rule removes their cause: both were wells where onset detection picked a short
early region and extrapolated its line across the run, manufacturing a rise out of
slope-estimation error. Baselining such a well over the whole run leaves it flat, and a flat well
crosses nothing.

## 8. End-point RFU

> *Measured (§1.5), exactly.* Implemented by `endPointRfu()`; reported as `CqTableEntry.endRfu`,
> the Curves table's **End RFU** column and the analysis CSV.

```
endRfu = mean(corrected[N−4 … N])       # the last five cycles, after §1.7's plateau filter
```

Some assays report no Cq at all and read the well's end-point fluorescence instead. It is
deliberately *not* `deltaRfu`, which `CurveBaselineResult` also carries: `deltaRfu` is the last
value minus the baseline mean, a rise; `endRfu` is a five-cycle average, and on a still-rising well
the two differ by hundreds of RFU.

The end-point **call** (`(+) Positive` / `Negative` / `NoCall` / `Unassigned`) is a separate
verdict, and is not implemented. It needs the plate's negative control: in the FAM export, wells at
2906/4622/4773/4059 RFU are called positive, the well at 1419 RFU is the negative control and is
called negative, and the well at 675 RFU — which *does* have a Cq of 38.14 — is `NoCall`. In the
Tex 615 export, which has no negative control, every well is `Unassigned` regardless of its RFU
(including one at 1574). So the call threshold is derived from the negative control rather than
from a fixed RFU, and Cq and the call are independent verdicts that disagree freely — neither may
be derived from the other.

## 9. Not implemented, and open questions

### Deliberately not implemented

Each of these is understood well enough to build; none is exercised by any sample in hand, so
building it would mean shipping untested code and a UI control for it.

- **`ReferenceNormalized` / `ReferenceLinearBaseLineNormalized`** — normalizing against a passive
  reference dye before baselining. Needs a plate that designates one; no sample does.
- **`pDriftCorrection`** — see [`calibration.md`](./calibration.md) §6. A controlled A/B pair
  exists (`20260726_S183-S185_RVP-drift-correction.pcrd` differs in this flag alone), but only the
  `False` side has an export, so what the option does is still unmeasured. **An export of the
  drift-corrected run would settle it outright**, per well and per cycle.
- **`BeginCyclesSkip` / `EndCyclesSkip`** — dropping leading/trailing cycles from consideration
  entirely. Both are 0 in every sample.
- **`pCRBaseLineMethod="DataWindow"`'s sub-window** — `dataWindowFractionFullCycle` and
  `dataWindowWidthFractionFullCycle` are 1 and 0.99 in every sample, i.e. the whole run, so their
  reading as a position and a width is untestable. A run using a genuine sub-window would settle it.
- **The `NoThreshold` (curve-fit) Cq algorithm** — Cq from the second-derivative maximum, needing
  no threshold at all, and so immune to §5.2. Its values are not comparable with threshold-crossing
  values, which is why it can't simply be an alternative source for the same column: it would have
  to be reported as a quantity of its own, beside the Cq rather than instead of it.
- **The end-point call** — §8. Needs the negative-control rule, which is visible in the export but
  only from one plate.
- **Display smoothing.** §1.6 rules smoothing out of the *analysis*, but a smoothed overlay on the
  chart is a legitimate display option; nothing offers one today.

### Genuinely open

- **CFX's automatic threshold.** §5.2 — the largest remaining source of systematic disagreement,
  and the only place a wrong answer moves every Cq on a plate at once. Two anchors and one
  inequality rule out every rule tried. More anchors need more runs with `autoCalculateThreshold`
  left on *and* exported results; the cheapest single addition would be an export of
  `20260720_Luna_noRT.pcrd`, whose Cy5 is on auto.
- **The exact baseline window rule.** §1.7 brackets it (begin 3–4; end at the last cycle, or
  `round(Cq) − 2`) and §3 implements that bracket, but the best-matching ordinary least-squares fit
  still misses the recovered line by 0.02–0.5 RFU, and eight smoothing/edge variants plus a
  zero-slope variant all did worse. The consequence is bounded and small: §1.8's end-to-end
  agreement of ≤0.11 cycles, against 1e-10 when CFX's own curves are used.
- **Where the last 2 × 10⁻⁴ of colour separation goes.** Seven of the 24 exported curves — six Cy5
  wells and Tex 615 G4 — fit the straight line only to 0.14–0.46 RFU rather than 5e-3. It is
  present on flat, no-Cq curves where no filter runs, and is dye- and well-specific (Cy5 C4 misses
  while FAM C4 in the same well is exact), so it belongs to
  [`calibration.md`](./calibration.md) §8 rather than here. Well factors are ruled out — this
  `.pcrd`'s `wellFactorsCollection` is the default identity table.
- **`pCRDisplayMode`** (`SinglePoint` vs `AllPoints`) is understood to select how a multi-read
  cycle is reduced to one value per cycle, but its interaction with Cq has not been checked.
