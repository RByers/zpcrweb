# Baseline, Threshold and Cq

## 1. The problem

Colour separation ([`calibration.md`](./calibration.md)) turns raw channel readings into an
**amplification curve**: one fluorescence value (RFU) per cycle, for each well and each dye. A curve
is not yet a result. What an assay reports is either

- a **quantification cycle** — Cq, also written Ct: the cycle at which that well's signal first
  becomes reliably distinguishable from its own noise, and the number from which starting
  concentration is derived; or
- **no amplification** — a well where no such cycle exists, which for a diagnostic assay is a result
  in its own right and must not be confused with a failure to analyse.

Getting from one to the other means making three judgements about a curve, none of which the raw
values state directly:

1. **Which part of the curve is baseline.** A well that never amplifies is not flat: the optics and
   the block drift, so its trace is a sloped line plus noise. The pre-amplification cycles of a well
   that *does* amplify look the same. Fluorescence can also rise linearly without any PCR product
   behind it, which is why the baseline is fitted as a **line** rather than a constant — a linear
   rise belongs to the baseline, an exponential one does not.
2. **Where to put the threshold.** Subtracting the baseline puts an unamplified well at zero, so
   "has this well amplified" becomes "does its corrected curve get far enough above zero" — and *far
   enough* is a level in RFU that has to come from somewhere. It has to clear the jitter of a flat
   well and still sit below the shoulder of a real exponential.
3. **Where the curve crosses.** With a level chosen, the Cq is the (fractional) cycle where the
   corrected curve crosses it — and on a noisy curve there may be several crossings, or one that
   means nothing.

The ideal amplification curve is a sigmoid: flat baseline, an exponential rise, then a plateau as
reagents deplete. Recognising that shape is what a human does when they look at a plot, and it is the
intuition behind every rule below. It is worth saying plainly, though, that **this library does not
detect the sigmoid**. There is no shape test, no amplification score and no quality gate: a curve
either crosses its threshold or it does not, and everything else the app reports describes that one
judgement rather than second-guessing it. §6 says why, and §B.1 covers the two shape detectors that
used to be here.

> **Status.** §3–§7 are implemented and shipped. §8 is the app's interface over them, §9 the settings
> a saved experiment carries, §10 what is missing. §A is where the rules come from — most are
> *measured* against the instrument software's own exported results for a run committed in
> `samples/`, not merely plausible — and §B records what was tried and rejected on the way. Read §A
> before changing any number in §3–§7.

## 2. How the app answers it

One pass, in five stages, with one loop in it:

| Stage | Output | Where |
|---|---|---|
| Baseline region (§3) | the cycles that count as baseline, per curve | `baselineRegion()`, `packages/core/src/baseline.ts` |
| Baseline subtraction (§4) | a corrected curve sitting at zero when unamplified | `subtractBaseline()`, same file |
| Baseline noise (§5.1) | a per-curve jitter estimate, σ | `baselineNoise()`, `packages/core/src/threshold.ts` |
| Threshold (§5.2–§5.3) | one RFU level per fluorophore, overridable | `autoThreshold()`, `resolveThreshold()`, same file |
| Cq (§6) | a fractional cycle, or nothing | `computeCq()`, same file |
| End-point RFU (§7) | the plateau level, for assays that report it | `endPointRfu()`, `baseline.ts` |

The stages are not independent: **the baseline region depends on the Cq, and the Cq depends on the
baseline region** (§3.1). `computeCqTable()` in `packages/core/src/analysis.ts` is the entry point
that resolves that circularity over a whole plate, and it is the only correct way to call this
pipeline — a threshold is a property of a *group* of wells (§5.2), so a Cq computed over a subset of
the plate is a different number. `packages/core/src/runAnalysis.ts`'s `computeRunAnalysis()` calls
it once per run, and every consumer — the web app, `tools/zpcr.mjs` — reads the one result rather
than calling it again over a subset.

## 3. The baseline region

> *Measured — §A.7.* Implemented by `baselineRegion()`.

```
begin = 3
end   = (no Cq) ? the last cycle : round(Cq) − 2
```

widened to at least 5 cycles and clamped to the run. That is the whole rule, and each part answers a
specific failure:

- **Begin at cycle 3.** Block and optics are still settling over a run's first reads, so those points
  sit off the line the rest of the region describes and tilt the fit. Every region recovered from the
  instrument's own output begins at cycle 3 or 4 (§A.7), never at 1.
- **A curve with no Cq is baselined over the whole run.** There is no onset to stop before, and its
  entire trace is baseline by definition. This is also what makes a negative well that rises for a
  few early cycles and then goes flat come out flat: the long tail dominates the fit.
- **A curve with a Cq stops two cycles short of it.** The exponential's foot lifts the curve
  measurably a cycle or two before it reaches the threshold; a line fitted through that foot tilts
  upward and drags every later value down. The margin is measured, not chosen: three clean positive
  controls give `round(Cq) − 2` exactly.

### 3.1 The baseline ↔ Cq loop

Because `end` needs the Cq and the Cq needs the correction, `baselineCorrectCurve()` iterates to a
fixed point: baseline over the whole run, take a Cq, re-fit ending before it, repeat until the region
stops moving. `computeCqTable()` wraps that in a second, plate-level alternation — whole-run
baselines to get each group's threshold, every curve re-baselined against it, then thresholds
re-resolved from the improved noise.

Both loops are load-bearing, and nothing cheaper reproduces the instrument's numbers: skipping the
iteration entirely puts one well 7.4 cycles late. §B.4 prices every shortcut that was tried.

Regions are always placed with a group's **automatic** threshold, never a manual override of either
kind (§5.3). Where a curve stops looking like a baseline is a property of the curve; letting an
override move baselines would make one well's edit change its plate-mates' noise, and through the
group median their thresholds.

Convergence is quick — most curves never move their region, an amplifying one takes 3–5 passes — but
not guaranteed: of the 1056 curves across the committed samples, exactly one oscillates indefinitely
between two adjacent regions. `MAX_BASELINE_PASSES` (6) exists for that curve, and lowering it from
200 to 6 changed no Cq anywhere.

## 4. Baseline subtraction

> *Measured — §A.7.* Implemented by `subtractBaseline()` and `smoothPlateauTail()`.

Fit a straight line to the region by ordinary least squares and subtract it from every cycle:

```
fit y = m·c + b over [begin..end]        # c = cycle number
corrected[c] = y[c] − (m·c + b)
```

This is the mode a saved experiment calls `LinearBaseLineNormalized`, and it is what every Cq in this
library is computed against. It reduces to subtracting a constant when `m ≈ 0`, and is strictly
better than that whenever the instrument drifts over the run. §9 lists the other modes the file
format can name and what this library does with them.

The corrected curve is **not smoothed** — measured (§A.6) against the instrument's own exported
curves, despite the file naming a digital filter. One cosmetic exception, `smoothPlateauTail()`:
after the Cq is known, a width-3 centred mean is applied to the curve's post-amplification tail
(`floor(Cq) + 3` to the second-to-last cycle). It cannot move a Cq or a threshold — everything before
it is untouched — and exists because it changes the reported plateau, and so §7's end-point RFU.

> **Future:** a smoothed *display* overlay is a legitimate option and nothing offers one today.
> Smoothing the analysed curve is not — §A.6 rules it out.

## 5. The threshold

> Implemented by `baselineNoise()`, `autoThreshold()` and `resolveThreshold()` in
> `packages/core/src/threshold.ts`.

### 5.1 What "noise" means

*This library's own.*

The baseline noise of a curve is the **median absolute second difference** of its corrected values
over the baseline region, scaled to a standard deviation by `1 / (0.6745 × √6) ≈ 0.6053`. That factor
is arithmetic — it makes the statistic agree with σ on white noise — not a tuning knob.

Second differences of a straight line are zero, and a rise occupying a minority of the region cannot
move a median, so this statistic survives being computed over a region the baseline does *not*
describe. It has to: §3's first pass deliberately baselines every curve across its own amplification.
The two obvious alternatives do not survive that, and both were shipped here once (§B.2).

### 5.2 The automatic threshold

*This library's own. **The one number in the shipped pipeline with no measurement behind it.***

```
T = multiplier × median(baseline noise over the fluorophore's wells)      multiplier = 20
```

Two parts of this are settled, and one is not.

**One threshold per fluorophore** is measured: solving the instrument's reported Cq values back for
the level that produces them gives one value per dye to 1e-12 (§A.3), and the file format persists
thresholds per fluorophore with no per-target equivalent anywhere. Grouping by *target* instead
splits one dye's wells into cohorts that differ only in what the experimenter named them — on
`20260720_FirstQualification.zpcr` that produced thresholds 3.3× apart (162 vs 49 RFU) for
near-identical curves, one cohort being a single well.

**The median** is what keeps one unusual well from moving the group.

**The multiplier is a default, not a reproduction.** The evidence says the *form* of the rule is
wrong rather than the constant: on one plate, three dyes read in the same cycles, with baseline noise
within 40% of each other, used thresholds spanning 35× (§A.3, §B.3). No noise-relative rule can
produce that. What the shipped rule is instead is a defensible engineering default — a level a few
tens of multiples above the noise floor clears a flat well's jitter and sits below a real
exponential's shoulder — and the way to get exact agreement with the instrument is to *supply* the
threshold rather than compute it (§5.3).

> **Future:** reproducing the instrument's automatic rule is the largest single source of systematic
> disagreement left, and the only place a wrong answer moves every Cq on a plate at once (§10).
> Because it is unresolved, the multiplier is a slider in the app rather than a constant in the code
> (§8).

### 5.3 Manual overrides

*Read from the file, and measured — §A.3.*

Three levels, finest first: a **per-curve** override, then a **per-fluorophore** override, then
§5.2's automatic value. `resolveThreshold()` applies them in that order.

A saved experiment that carries a hand-set threshold (`thresholdOverrideValue` with
`autoCalculateThreshold="False"`) has recorded the level its own analysis used. `parsePcrd()` decodes
it into `Zpcr.persistedThresholds`, keyed by dye name, and the app **seeds its per-fluorophore
override** with it when the run loads. That one value is what makes this app reproduce the
instrument's Cq exactly for an overridden dye. Two details that cost time to learn:

- **Match on the fluorophore id, not the first entry.** A file carries analysis parameters for every
  fluorophore the instrument knows about, not only the ones on the plate, so the first override in
  the document usually belongs to a dye the run never used. Ids resolve against the plate's own
  `<dyeLayer>` entries; an id with no dye layer is dropped rather than guessed at.
- **It seeds state; it is not a pipeline input.** A `.pcrd` and the `.zpcr` of the same run must
  quantify identically from the same measurement, and a persisted threshold is a saved *decision*,
  not a measurement. Seeding it as a visible, editable override says so; `zpcrweb.json` — this app's
  own record of the same kind of decision — outranks it.

Per-curve overrides have no equivalent in the file format. They exist because §5.2's median
deliberately refuses to follow any single well, which is right for the default and leaves no other way
to correct one well whose baseline came out wrong. An overridden curve still joins its group's noise
cohort: its noise is a real measurement, and dropping it would change every *other* curve's threshold
as a side effect of editing this one.

> A consequence worth stating plainly: **a Cq is a property of a well *and the group it was computed
> with*, not of the well's curve alone.** Change the set of wells in the group and the median noise
> moves, the threshold moves, and a marginal well can gain or lose its Cq. Compute a Cq once per run
> over the whole plate and then read it; never recompute over whatever subset a caller is looking at.

## 6. Cq — the crossing rule

> *Measured exactly — §A.2.* Implemented by `computeCq()`, asserted against the instrument's own
> numbers by `packages/core/test/cfxExport.test.ts`.

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

Three things here are measurements rather than choices, each having replaced a plausible alternative
this library once shipped: the interpolation is **linear** in RFU, not logarithmic; the abscissa is
the **cycle number as reported**, with no half-cycle offset; and the crossing is selected by the
**longest following monotone-increasing run**, which is what makes a single early noise spike lose to
the real rise. §A.2 and §A.3 are the evidence.

**The one narrowing is that the search starts at cycle 3** — §3's `BASELINE_BEGIN_CYCLE`, with
`min`/`max` taken over the same range. *This library's own; the reference cannot settle it, because no
exported well has the transient it exists for.* It is not a quality gate — it adds no test a curve
can fail — it states the domain the model is defined on: §3 excludes the first reads from the fit
*because* the instrument is still settling there, so corrected values at those cycles are
extrapolations of a line deliberately told not to model them. Well F1 of
`20230829_135443_CT019138_SINGLE_STEP_.zpcr` is the case: a flat well whose raw trace decays steeply
over its first cycles, leaving corrected values of 55.0 and 63.9 at cycles 1–2 straddling a 57.9
threshold. That was the only crossing on the whole curve, and it produced a Cq of **1.32**.

Everything else is a consequence of the rule, not a separate case:

- **Never crosses ⇒ no Cq.** An empty Cq is a meaningful result, not a failure.
- **Starts above the threshold ⇒ no Cq**, by the guard on the first line. This is *the* reason a well
  with an obvious rise can report nothing (§A.4). In the output it is indistinguishable from a flat
  well and means the opposite, so the app calls it out explicitly (§8).
- **Ends below the threshold** is not special and not a reason to withhold a Cq (§A.4).
- **Crosses, falls back, crosses again** is handled by the longest-run rule.

There are **no quality gates** — no amplification test, no baseline-validity test, no
ends-below-threshold test. `T ∈ [min, max]` is the whole of it. This is measured (§A.4), it is
tempting to add anyway, and this library has twice done so and twice removed it: §B.1.

## 7. End-point RFU

> *Measured exactly — §A.5.* Implemented by `endPointRfu()`; reported as `CqTableEntry.endRfu`, the
> Curves table's **End RFU** column and the analysis CSV.

```
endRfu = mean(corrected[N−4 … N])       # the last five cycles, after §4's plateau filter
```

Some assays report no Cq at all and read the well's end-point fluorescence instead. It is deliberately
*not* `deltaRfu`, which `CurveBaselineResult` also carries: `deltaRfu` is the last value minus the
baseline mean — a rise — while `endRfu` is a five-cycle average. On a still-rising well the two differ
by hundreds of RFU.

The end-point **call** (`(+) Positive` / `Negative` / `NoCall` / `Unassigned`) is a separate verdict
and is not implemented. It needs the plate's negative control: in one export, wells at 2906–4773 RFU
are positive, the 1419 RFU negative control is negative, and a well at 675 RFU *with* a Cq of 38.14
is `NoCall`; in another export from the same run, with no negative control, every well is `Unassigned`
regardless of level (including one at 1574 RFU). So the call level derives from the negative control
rather than from a fixed RFU, and Cq and the call are independent verdicts that disagree freely —
neither may be derived from the other.

## 8. What the user sees, and what they can change

Because the automatic threshold is a default rather than a reproduction (§5.2), the app's job is not
only to report a Cq but to show what it was derived from and let it be corrected. The Curves rail's
**Threshold** section is that surface (`apps/web/src/components/curves/ThresholdSection.tsx`; see
[`apps/web/ARCHITECTURE.md`](./apps/web/ARCHITECTURE.md) for the implementation):

- **The multiplier is a slider** (1–100, default 20), not a buried constant, with the thresholds
  below it updating live as it moves — the one number with no measurement behind it is also the one
  whose effect the user can watch.
- **One row per fluorophore, expandable to the curves behind it.** Each curve's line shows the two
  inputs its group's median is made of — its own baseline region (`cycles a–b`) and its own σ — so a
  surprising threshold can be traced to the curve responsible.
- **Both levels are editable and the finer one wins** (§5.3). A hand-set value is tinted so it never
  reads as something the run computed; a reset per row returns it to the derived default.
- **Hovering explains rather than merely highlights.** A fluorophore row isolates its curves and
  draws a dotted line at its threshold; a single curve's row additionally traces the exact cycle span
  its baseline was fitted over, with σ labelled at the end.
- **A curve whose whole corrected trace sits above its threshold is flagged** (⚠), because §6 gives
  it no Cq and that is otherwise indistinguishable from a flat well.
- **A row with no Cq is greyed, never hidden**, so a well's disqualification stays visible; with no
  quality gates left, "no Cq" has exactly one cause, and greying reacts live to editing a threshold.

Baselining itself is deliberately not user-configurable: it is always §4's automatic linear fit. The
per-curve baseline region is visible — in the hover overlay, and as a fitted formula in the Curves
table — but not editable.

> **Future:** manual baseline windows, per well. The instrument offers them and this app does not; a
> curve whose region comes out wrong can today only be corrected indirectly, by overriding its
> threshold.

## 9. The settings a saved experiment carries

*Read from the file.* A saved experiment stores analysis settings **per fluorophore**, in the subtree
[`pcrd.md`](./pcrd.md) §2.5 describes:

```xml
<dataAnalysisParameters algorithmCtDetection="Threshold" …>
  <dataAnalysisParam smoothFilterWidthPref="5" BeginCyclesSkip="0" EndCyclesSkip="0" …>
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

**Exactly one of these is read by this library:** `thresholdOverrideValue`, when
`autoCalculateThreshold` is `False` (§5.3). The rest are measured inert, measured misleading, or
unexercised by any sample in hand:

| Setting | Status |
|---|---|
| `pCRDigitalFilter`, `smoothFilterWidthPref` | **Inert.** No smoothing appears in the exported curves (§A.6). |
| `baselineBeginRepeat` / `EndRepeat` | **Misleading.** They are the defaults an automatic search starts from, not the regions actually used — several wells' real regions are nowhere near 2–9 (§A.7). |
| `pCRBaseLine` | Six modes. `Raw` and `RawBaseLineSubtracted` produce no Cq at all; `LinearBaseLineNormalized` is what §4 implements; `LinearBaseLineNormalizedCurveFit` is that plus §4's plateau filter, and is the observed default; the two `Reference…` modes normalise against a passive reference dye first, and are not implemented (§10). |
| `algorithmCtDetection` | `Threshold` is §6. A `NoThreshold` mode takes Cq from curve shape instead; not implemented (§10). |
| `pDriftCorrection` | Not implemented; a baseline setting rather than an optical one, but see [`calibration.md`](./calibration.md) §6. |
| `BeginCyclesSkip` / `EndCyclesSkip` | Drop leading/trailing cycles from consideration; 0 in every sample. |
| `pCRBaseLineMethod`'s sub-window (`dataWindowFractionFullCycle`, `…WidthFractionFullCycle`) | 1 and 0.99 in every sample, i.e. the whole run, so their reading as a position and a width is untestable. |
| `pCRDisplayMode` | Selects how a multi-read cycle reduces to one value per cycle; its interaction with Cq is unchecked. |

## 10. Future work and open questions

### Deliberately not implemented

Each is understood well enough to build; none is exercised by any sample in hand, so building it
would mean shipping untested code and a UI control for it.

- **`ReferenceNormalized` / `ReferenceLinearBaseLineNormalized`** — normalising against a passive
  reference dye before baselining. Needs a plate that designates one; none does.
- **`pDriftCorrection`** — see [`calibration.md`](./calibration.md) §6. A controlled A/B pair exists
  (`20260726_S183-S185_RVP-drift-correction.pcrd` differs in this flag alone), but only the `False`
  side has an export, so what the option does is unmeasured. **An export of the drift-corrected run
  would settle it outright**, per well and per cycle.
- **`BeginCyclesSkip` / `EndCyclesSkip`**, and `pCRBaseLineMethod`'s genuine sub-window — §9. A run
  using either would settle its reading.
- **The threshold-free (`NoThreshold`) Cq**, which takes Cq from the curve's shape and so needs no
  threshold at all, making it immune to §5.2's open question. Its values are not comparable with
  threshold-crossing values, which is why it cannot simply be an alternative source for the same
  column: it would have to be reported as a quantity of its own, beside the Cq rather than instead of
  it. This library implemented a version of it once and deleted it (§B.1).
- **The end-point call** — §7. Needs the negative-control rule, visible in the export but only from
  one plate.
- **Manual baseline windows** (§8) and a **smoothed display overlay** (§4).

### Genuinely open

- **The instrument's automatic threshold.** §5.2 — the largest remaining source of systematic
  disagreement. Two anchors and one inequality rule out every rule tried (§B.3); more anchors need
  more runs with `autoCalculateThreshold` left on *and* exported results. The cheapest single
  addition would be an export of `20260720_Luna_noRT.pcrd`, whose Cy5 is on auto.
- **The exact baseline window rule.** §A.7 brackets it (begin 3–4; end at the last cycle, or
  `round(Cq) − 2`) and §3 implements that bracket, but the best-matching least-squares fit still
  misses the recovered line by 0.02–0.5 RFU, and eight smoothing/edge variants plus a zero-slope
  variant all did worse. The consequence is bounded and small: §A.8's end-to-end agreement of ≤0.11
  cycles, against 1e-10 when the instrument's own corrected curves are used.
- **Sigmoid-shape reporting.** Not a correctness gap — §6 is exact without it — but the app has no way
  to say "this curve crossed, *and* it looks like real amplification". Any such signal must be a
  *label*, never a veto: §B.1 is the record of what happens otherwise.
- **Where the last 2 × 10⁻⁴ of colour separation goes.** Seven of the 24 exported curves fit the
  straight line only to 0.14–0.46 RFU rather than 5e-3. It is present on flat, no-Cq curves where no
  filter runs, and is dye- and well-specific, so it belongs to
  [`calibration.md`](./calibration.md) §8 rather than here. Well factors are ruled out — that file's
  `wellFactorsCollection` is the default identity table.

---

# Appendix A — How this was measured

*From data files only. `packages/core/test/cfxExport.test.ts` is the executable form of §A.2, §A.4 and
§A.5, and needs no password.*

Most of §3–§7 is not a reasonable-looking algorithm but a recovered one. One run in `samples/` ships
with both the saved experiment *and* the instrument software's own exported results for it, which
makes the input and the output of each stage separately known.

### A.1 The dataset

`samples/20260726_S183-S185_RVP.pcrd` is a 45-cycle, 3-fluorophore (FAM, Cy5, Tex 615) run.
Alongside it, `samples/20260726_S183-S185_RVP-export.zip` holds the CSVs exported for that same
experiment:

| Export | What it gives |
|---|---|
| `Quantification Amplification Results_<fluor>.csv` | **The reference baseline-corrected RFU, per cycle, per well** — the output of §3–§4. |
| `Quantification Cq Results_0.csv` | Cq per well/fluor, to 15 significant digits — the output of §5–§6. |
| `End Point Results_<fluor>.csv` | End RFU and the end-point call per well. |
| `Quantification Plate View`, `Summary`, `Standard Curve`, `Melt Curve`, `Gene Expression` | Derived views over the same numbers. |

So the *input* to §5–§6 (the corrected curve) and its *output* (the Cq) are both known exactly,
independently of whether this library's §3–§4 reproduce the correction.

### A.2 The Cq rule, reproduced exactly

Feeding the reference's own corrected curves and its own threshold into §6's rule reproduces **all 14
reported Cq values, and all 10 reported no-Cq wells, to ~1e-10 cycles** — exactly, to the precision
the CSV carries. Four facts fall out, each having replaced a plausible alternative this library had
shipped:

1. **Linear interpolation, not logarithmic.** The corrected RFU itself is interpolated, between
   exactly two points. Log interpolation is physically appealing — the curve really is roughly
   exponential between reads — and lands a few hundredths of a cycle early, so it cannot match.
2. **The abscissa is the cycle number as exported** — 1, 2, 3, … — with no half-cycle offset (§A.3
   tests this directly).
3. **The crossing is selected by the longest following monotone-increasing run**, not by the start of
   the final above-threshold run. On clean curves the two coincide; they differ on a curve that
   crosses, falls back and crosses again (§A.4).
4. **The only "no amplification" gate is `T ∉ [min(y), max(y)]`** — no amplification squelch, no
   baseline-validity gate, no "no Cq if the trace ends under the threshold" rule (§A.4).

### A.3 Solving the reported Cq back for the threshold

The check that pins both the abscissa and the one-threshold-per-fluorophore grouping. For each well
with a Cq, take the bracketing cycle pair and solve the linear interpolation for `T`:

| Fluor | Wells with a Cq | Implied `T`, `x = cycle` | Spread | Implied `T`, `x = cycle + ½` |
|---|---|---|---|---|
| FAM | 6 | **92.0212554931641** | 4e-12 | 60.9 … 68.2 |
| Tex 615 | 3 | **8.06451415811512** | 8e-13 | 1.2 … 7.5 |

Both readings are decisive, and the FAM value is independently confirmed: the `.pcrd` persists
`thresholdOverrideValue="92.0212554931641"` for `fluorId="5"` (FAM) — **the same 15 digits**. That
single equality validates the abscissa, the interpolation form, the per-fluorophore grouping and the
file field all at once.

The third dye is bounded rather than pinned: Cy5 well D9 rises to 278.3 RFU and gets no Cq, so Cy5's
threshold **exceeds 278**. Together with baseline noise of ~2.3 (FAM), ~2.5 (Tex 615) and ~1.8 (Cy5),
these three readings are what §B.3 uses to rule out every noise- and shape-relative rule.

### A.4 Two wells that settle the quality-gate question

Both are Tex 615, both from the run above:

**B4 — pure noise, and the reference reports a Cq of 14.8211331477313.** Its corrected curve never
amplifies; it drifts from −24 RFU up to about +6 and sits there, ending at −1.8. Exactly one cycle,
cycle 15, pokes above the threshold at 8.5 RFU, and the crossing between cycle 14 (5.8) and cycle 15
is interpolated and reported.

**E4 — a clear monotone rise from 19.7 to 107 RFU, and the reference reports no Cq.** Not because it
failed an amplification test: because after baseline correction its *minimum* is 19.7, above the 8.06
threshold, so `T < min(y)` and the curve never crosses.

Together they show the reference asks only "does this curve cross this line", and answers with
interpolation. Everything that looks like quality control in its output is a consequence of where the
*threshold* landed, not of a gate applied to the curve — a real simplification, and the reason §6 has
no gates.

### A.5 End-point RFU: the mean of the last five cycles

The **End RFU** column equals the arithmetic mean of the last **5** values of the same well's
corrected curve — exactly, to full CSV precision, for all 14 wells across FAM and Tex 615. Not the
last value (which differs by up to 320 RFU on a still-rising well), not the last 3, not the last 10:

| Well (FAM) | End RFU | last value | mean of last 3 | **mean of last 5** | mean of last 10 |
|---|---|---|---|---|---|
| A4 | 674.826 | 906.139 | 796.622 | **674.826** | 395.067 |
| E9 | 4622.190 | 4653.062 | 4639.122 | **4622.190** | 4534.335 |
| H9 | 1418.779 | 1739.195 | 1607.959 | **1418.779** | 866.369 |
| C4 | −1.693 | 0.672 | −0.940 | **−1.693** | −0.793 |

### A.6 The analysed curve is not smoothed

The digital filter the file names (`pCRDigitalFilter="WeightedMean"`, `smoothFilterWidthPref="5"`)
does **not** appear in the exported corrected curves, and neither does any other smoothing.

Test: for a flat well, take first differences of the corrected curve and measure their lag-1
autocorrelation. White noise gives −0.5; a width-5 triangular weighted mean of white noise gives +0.5
(simulated, 4000 points). Measured over cycles 5–45 of every non-amplifying well in the run:

| Wells | lag-1 autocorrelation of first differences |
|---|---|
| 12 flat wells across Cy5, FAM, Tex 615 | **−0.26 … −0.60**, mean ≈ −0.42 |
| simulated white noise | −0.50 |
| simulated width-5 weighted mean | +0.50 |

Independently confirmed by §A.7, which reproduces the corrected curve from the raw dye curve to 5e-3
RFU with no filter of any kind in the model; a width-5 weighted mean would leave residuals of tens of
RFU. So the filter named in the file is not applied to the curve that is baselined, thresholded,
reported and exported — and this library does not smooth it either. That deleted a whole stage from
the pipeline.

### A.7 The baseline stage, recovered

Subtracting the exported corrected curve from this library's own colour-separated raw dye curve for
the same well exposes the reference baseline directly. Take `d = raw − corrected`:

**`d` is a straight line in the cycle number, to a residual RMS of 4–9 × 10⁻³ RFU** on 17 of the 24
exported curves. For a non-amplifying well that holds across all 45 cycles; for an amplifying well it
holds up to a break point identified below. So the correction is

```
corrected[c] = raw[c] − (slope·c + intercept)
```

with `c` the cycle number — an ordinary linear baseline subtracted from an unsmoothed curve. Fitting
`d` gives the reference's own `slope` and `intercept` per well, to five significant figures.

#### The plateau filter

On a well with a Cq, `d` departs the straight line at one specific cycle and stays off it. On FAM E9
(Cq 23.0733) the residual is a textbook line from cycle 1 to 25 — 2.45, 2.25, 2.05, … −2.37, stepping
by 0.205 a cycle — and then jumps to −43 at cycle 26. Modelling the departure as a **width-3 centred
mean applied to the corrected curve's tail** reproduces it exactly:

```
for c = floor(Cq) + 3 … N−1:                       # N = last cycle; the last cycle is NOT filtered
    out[c] = (corrected[c−1] + corrected[c] + corrected[c+1]) / 3
```

read from the *unfiltered* curve (a plain FIR pass, not applied in place — an in-place variant was
tried and is 7× worse). With that one line, the full reconstruction of the reference corrected curve
from the raw dye curve lands at **4–7 × 10⁻³ RFU RMS over all 45 cycles**, on curves spanning 4653
RFU. Three details, each measured rather than assumed:

- **The start cycle is `floor(Cq) + 3`** — confirmed on all 9 wells with a Cq, across two dyes and Cq
  values from 14.8 to 38.1, with no exceptions.
- **The last cycle is left alone.** Duplicating the edge value instead leaves cycle 45 off by 4.4 RFU
  while every other cycle is exact.
- **Everything before the start cycle is untouched**, so the baseline, the threshold and the Cq are
  unaffected. This filter changes only the reported plateau, and hence §7's end-point value.

This is what the mode name `LinearBaseLineNormalizedCurveFit` denotes: `LinearBaseLineNormalized` plus
this three-point tail average.

#### The baseline window

With `slope` and `intercept` known per well, the remaining question is which cycles were fitted.
Searching every `(begin, end)` pair for the ordinary least-squares fit that reproduces the recovered
line gives a consistent picture:

| Well | Cq | Best-matching window |
|---|---|---|
| FAM B4, D4 | — | cycles 4–45 |
| FAM C4, Cy5 A4, B4, D4, E4, F4 | — | cycles 3–45 |
| Cy5 A9 | — | cycles 4–45 |
| FAM E9 | 23.07 | cycles 3–21 |
| FAM G9 | 23.00 | cycles 3–21 |
| FAM F9 | 21.87 | cycles 3–20 |

Two rules fall out, and they are the ones §3 implements. **A non-amplifying well is baselined over
essentially the whole run** — never the 2–9 the file's own `baselineBeginRepeat`/`EndRepeat` suggest.
**An amplifying well's baseline ends about two cycles before its Cq**: the three clean positive
controls above all give `round(Cq) − 2` exactly. Both begin at cycle 3 or 4.

**But no window is exact.** The best fit is off by 0.02–0.5 RFU on curves of thousands, and that gap
does not close under any variant tried: fitting the line to a smoothed copy of the curve
(triangular-5, boxcar-5, boxcar-3, with shrinking, skipped and clamped edge handling — 8
combinations), or forcing the slope to zero. This residual **cannot** be an error in this library's
colour separation: any affine difference between our raw curve and the reference's cancels out of the
comparison identically, and a non-affine one is bounded at 5e-3 RFU by the straight-line result above.
So the baseline *model* is settled and the window is known to within a cycle or two; the exact
window-selection rule is not (§10).

### A.8 End to end

Running the shipped pipeline — this library's colour separation, §3's regions, §6's Cq — over the RVP
run, with the run's own persisted FAM threshold honoured (§5.3) and Tex 615 on its recovered value:

| Fluor | Well | This library | Reference | Δ cycles |
|---|---|---|---|---|
| FAM | A4 | 38.150 | 38.144 | 0.006 |
| FAM | E4 | 24.857 | 24.848 | 0.009 |
| FAM | E9 | 23.030 | 23.073 | 0.043 |
| FAM | F9 | 21.792 | 21.875 | 0.083 |
| FAM | G9 | 22.895 | 23.002 | 0.107 |
| FAM | H9 | 36.670 | 36.623 | 0.047 |
| Tex 615 | A4 | 32.410 | 32.346 | 0.064 |

Every well the reference quantifies is quantified here, within 0.11 cycles, and every FAM and Cy5
well it leaves unquantified is unquantified here too. The residual is the baseline window of §A.7, not
the Cq rule: given the reference's *own* corrected curves the agreement is 1e-10. Three wells
disagree, all Tex 615 — B4 and G4, where the reference reports a Cq against a threshold of 8 RFU that
sits inside those wells' own jitter (§A.4) and this library reports none, and E4, which the two
baseline differently.

A second file, `20260726_S183-S185_RVP-drift-correction.pcrd`, is the same experiment re-saved with
`pDriftCorrection="True"` and nothing else changed — an A/B pair for the drift-correction question in
[`calibration.md`](./calibration.md) §6, once a matching export exists for it.

---

# Appendix B — What was tried, and what noisy curves do

Every rule in §3–§6 replaced something. The failures are worth keeping, because each was a reasonable
idea that a noisy curve broke, and because several were shipped here before the measurements of §A
existed to overrule them.

The recurring theme: **a real plate is mostly negative wells, and a negative well is not flat.** It
drifts, it jitters, and over 45 cycles it will do something that locally resembles amplification. Any
rule tuned on amplifying curves fails on those, usually by manufacturing a signal rather than missing
one.

### B.1 Onset detection, and quality gates

**Onset detectors.** The baseline region used to be placed by looking for where a curve leaves its
baseline — a second-derivative peak finder, and an iterative regression — with about a dozen tuning
constants between them, none measured. Both fail the same way on a negative well: a few cycles of
early drift look like an onset, the region is cut short there, and the line fitted to that short
region is extrapolated across the whole run. Slope-estimation error on a five-cycle window is enough
to manufacture a rise of hundreds of RFU out of nothing. §3's rule — the whole run when there is no
Cq, `round(Cq) − 2` when there is — has no such failure mode and no tuning constants, at the cost of
the iteration §3.1 needs.

**Quality gates.** Because onset detection manufactured rises, gates were added to suppress them: an
`amplified` flag (total rise against baseline noise, on a 10× constant) and a baseline-validity check,
each able to veto a Cq. Both were added in response to a real failure on a real well, and both are
wrong: §A.4 shows the reference applies neither, reporting a Cq of 14.82 for a pure-noise well that
touches the threshold once, and withholding one from a well that rises cleanly by 87 RFU, purely on
where the threshold fell.

The failures the gates were for do not reappear, because §3 removed their *cause* rather than masking
it: baselining such a well over the whole run leaves it flat, and a flat well crosses nothing. The
gates then survived a while as diagnostics — a label per curve, in the CSV — and that has gone too:
`amplified` was a boolean derived from an unmeasured constant, nothing on screen used it, and the one
question it half-answered ("did this well rise but fail to cross?") the app now answers exactly and
constant-free, by comparing the corrected curve's minimum against its threshold (§6, §8). A CSV reader
seeing `cq` empty and `deltaRfu` at 1500 can see the same thing without being handed a rule they
cannot inspect.

**The threshold-free Cq.** A shape-fitting algorithm — Cq from a fitted sigmoid's derivatives, no
threshold at all — was implemented here and deleted. Its values are not comparable with threshold
crossings, so it cannot be an alternative source for the same column, and nothing validated it. §10
records what bringing it back honestly would take.

### B.2 The noise statistic

§5.1's median absolute second difference replaced two statistics, both of which this library shipped:

- **Standard deviation about the fitted line** answers "how far is this curve from my model?", not
  "how much does it jitter". Over the committed samples, `stdDev ÷ jitter` reaches 4.2× on
  `20260720_FirstQualification.zpcr` and 8.7× on `20230829_135443_CT019138_SINGLE_STEP_.zpcr` —
  baseline mis-fit reported as noise, per well, which is exactly what makes a Cq incomparable across a
  plate.
- **Root-mean-square successive differences** fix the offset half of that but not the rest: a leftover
  slope puts a constant into every difference, and an amplifying well leaves a huge one in the
  differences across its rise.

A median of second differences is blind to both, and agrees with both on a region that really is a
line plus white noise — a strict improvement rather than a different answer.

### B.3 Threshold rules the data rules out

The anchors of §A.3 — FAM at 92.02, Tex 615 at 8.06, Cy5 above 278, against baseline noise of 2.3,
2.5 and 1.8 — are brutal. Three dyes on one plate, read in the same cycles, with noise within 40% of
each other, using thresholds spanning 35×. That rules out:

- **Any noise-relative rule**, including the one shipped (§5.2): the implied multipliers are ~40×, ~3×
  and >150×.
- **A curve-shape rule** — a per-well "where does this curve leave its baseline" value in RFU,
  averaged over the plate — which this document used to propose. Cy5's threshold must exceed 278 RFU
  while every Cy5 curve on the plate is flat noise; the one well that amplifies leaves its baseline at
  ~5 RFU, so nothing read off those curves' shapes can produce a number two orders of magnitude
  larger.
- **Scaling to amplitude**, which fails in the same direction: Cy5's amplifying well is the *smallest*
  of the three dyes' and its threshold is the largest.

Hence §5.2's conclusion: keep a defensible default, expose it (§8), and get exactness by supplying the
threshold rather than computing it.

### B.4 Ways out of the baseline ↔ Cq loop

The circularity of §3.1 is the expensive part of the pipeline, so each way out was priced on the RVP
run against the reference's Cq values (the §A.8 comparison):

| Iteration | Worst Δ vs reference |
|---|---|
| None — every well baselined over the whole run | **7.36 cycles** |
| One re-fit | 2.84 |
| Two | 0.63 |
| To a fixed point (as shipped) | **0.107** |

A whole-run baseline on an amplifying well is fitted straight through the exponential, which tilts the
line up and drags the rise back down under the threshold — hence Cq values 7 cycles late, not merely
imprecise. **Nothing cheaper than the fixed point buys the §A.8 agreement**, and no Cq-free substitute
is available either: the onset detectors that used to place the region without one are exactly what §3
replaced (§B.1).

Two structural variants were tried; neither is an improvement:

- **Collapsing the nested loops into one** global alternation of "place every region, re-resolve every
  threshold" reproduces the shipped numbers exactly on the RVP run, but moves Cq by up to 0.31 cycles
  on the other committed runs, and on `20230829_135443_CT019138_SINGLE_STEP_.zpcr` it does not
  converge — a different fixed point reached less reliably, not a simpler route to this one.
- **Dropping the outer threshold re-resolution** (place regions, then keep the whole-run thresholds)
  moves Cq by up to 0.73 cycles. Both passes are load-bearing.
