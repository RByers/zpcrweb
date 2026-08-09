# Channel→Dye Color Separation

The 6 optical channels a Bio-Rad CFX instrument reads don't map one-to-one onto the dyes loaded
in a plate: every dye bleeds some fluorescence into its neighboring channels (see the worked
example in [`dcal.md`](./dcal.md) §6 — Cal Gold 540 puts 31% of its signal into channel 1, Cy5-5
puts 17% into channel 4). **Color separation** is the process of "unmixing" that cross-talk:
given the 6 raw channel readings for a well and the pure-dye calibration data for the dyes on
the plate, estimate how much each dye actually contributed.

> **Status:** implements the algorithm below in full (§§2–5), including preprocessing (§4) —
> [`packages/core/src/calibration.ts`](../packages/core/src/calibration.ts) (linear algebra in
> [`linalg.ts`](../packages/core/src/linalg.ts)), tested against the calibration data in the
> committed sample archives — and, as of 2026-07-28, **cross-validated end-to-end against CFX
> Manager's own per-cycle output** on `20260726_S183-S185_RVP.pcrd`: 17 of 24 curves agree to
> 4–9 × 10⁻³ RFU up to the baseline both sides remove, the other 7 to ~2 × 10⁻⁴ relative. That
> discharges the largest caveat this document used to carry — the suspected per-dye scale factor,
> now bounded at ~10⁻⁶ — and leaves a much smaller open question. See §8, and
> [`threshold.md`](./threshold.md) §A.7 for the measurement.
>
> The web app's **Calibration** view plots the §2 response curves this is all built on (block
> temperature on x, RFU on y, one line per dye × channel), marked at the block temperature the
> run's own analysis samples them at — see
> [`apps/web/ARCHITECTURE.md`](../apps/web/ARCHITECTURE.md#calibration-view).

---

## 1. Overview

The algorithm takes:

- **Calibration data**: for each dye of interest, a pure-dye measurement and a matching
  empty-plate measurement across all 6 channels, at four reference block temperatures (20/40/60/
  80 °C) — exactly what a `.Dcal` file holds. See [`dcal.md`](./dcal.md).

  This half of the input is a property of **the instrument, not the run**. The same set rides
  along in every run the machine writes and doesn't change until it's recalibrated: across the
  committed samples, the four `.zpcr` files (2019, 2023 and two from 2026, all alpha `SG16130`)
  carry bit-identical values across all 145,152 calibration readings, and the two `.pcrd` files
  agree with them to 5e-3 RFU absolute — the `.pcrd`'s text round-trip, not a difference. See
  [`dcal.md` §4](./dcal.md#a-property-of-the-instrument-not-the-run) for the measurement.

  Two consequences worth keeping in view. Everything §§2–3 derive — response curves, and the
  calibration matrix at a given block temperature — is therefore constant per instrument too, so
  it can be built once and reused across runs, and a difference in results between two runs on
  one machine is never the calibration. And a matrix carried into a run from *another*
  instrument is simply the wrong matrix: these are that machine's optics, measured on its own
  detector at its own gain.
- **A raw reading**: the 6 per-channel fluorescence values for one well at one cycle, plus the
  block temperature that reading was taken at.

...and produces one concentration/intensity estimate per dye. It's a linear unmixing problem:
build a matrix whose columns are each dye's channel "fingerprint," then solve for the
combination of dyes that best explains the observed channel readings.

Four stages, covered in turn below:

1. Turn each dye's calibration data into a **response curve per channel** (§2).
2. Sample those curves at the reading's block temperature to build a **channel×dye calibration
   matrix** (§3).
3. Apply the same **corrections** a raw reading needs before separation (§4).
4. **Solve** the matrix equation for per-dye concentrations (§5).

**Scope note:** §§2–5 are everything needed to turn one raw 6-channel reading into per-dye
concentrations — the numeric core of what CFX Manager does when it produces a calibrated result
from a `.zpcr` run. They do *not* cover the rest of what CFX Manager does when it opens a `.zpcr`
and writes out a `.pcrd`: embedding the run's `.Dcal` files as `calibrationCollection`, embedding
a (for a `.zpcr`-sourced run, identity) `wellFactorsCollection`, and populating the analysis-state
subtrees ([`pcrd.md`](./pcrd.md) §§2.5–2.6) — those are container/format concerns, not part of the
separation algorithm, and are documented there instead of duplicated here.

## 2. Building a per-dye response curve

For one dye, at each of the four calibration temperatures, the pure-dye response on a channel is
the dye-plate reading minus the matching empty-plate reading, floored at zero:

```
response(channel, T) = max(0, dyeReading(channel, T) − emptyReading(channel, T))
```

Doing this at all four calibration temperatures gives four `(temperature, response)` points per
channel — a small piecewise-linear curve. To evaluate it at an arbitrary block temperature (not
just 20/40/60/80), interpolate linearly between the two bracketing points; below the first point
or above the last, **extrapolate linearly** using that end segment's slope, so any temperature
the instrument reports has a defined response rather than falling off the end of the curve.

Repeat this independently for every channel and every dye in play — the result is one curve per
(dye, channel) pair.

## 3. The channel→dye calibration matrix

For a specific block temperature, build a matrix with one row per optical channel and one column
per dye, where column *d* is dye *d*'s response curve (§2) sampled at that temperature:

```
M[channel][dye] = responseCurve(dye, channel) evaluated at the target temperature
```

Only the rows for the channels a run actually scanned belong in the matrix (`CHANNELMASK` — see
[`plateread.md`](./plateread.md)). Build it restricted from the start rather than dropping rows
from a full 6-channel matrix afterwards, because the per-column norms below have to be measured
over exactly the rows the solve will use.

Before the pseudo-inverse is taken, the matrix's columns are **normalized** so that no single
bright dye dominates the numerics purely because of scale. Two useful modes:

- **Per-dye (column) normalization**: scale each dye's column independently to unit L2 norm —
  `scale = 1 / sqrt(Σ_channel M[channel][dye]²)`. This equilibrates a matrix whose dyes differ
  several-fold in brightness, and is the default here.
- **Whole-matrix (global) normalization**: compute one L2 norm across *every* entry in the
  matrix and scale everything by it.

A third mode, no normalization, is useful for inspecting the raw calibration values directly.

**Normalization is a numerical-conditioning choice only — it must not change the reported RFU
scale.** For a diagonal column scaling `D`, `pinv(M·D) = D⁻¹·pinv(M)` whenever `M` has full
column rank, so the scaling is exactly recoverable: §5 multiplies each solved value back by that
column's scale factor, and all three modes then report the same numbers. What the mode still
changes is which directions fall below the pseudo-inverse's singular-value floor, so it continues
to matter for an ill-conditioned or rank-deficient matrix — that is the whole reason to keep the
setting.

A practical consequence: for any well-posed plate (at least as many scanned channels as dyes)
switching modes provably changes nothing you can see, so this is an internal conditioning knob,
not a user-facing analysis choice — the web app deliberately doesn't offer it as one.

One genuine exception survives: when there are **more dyes than channels**, the system is
underdetermined and the pseudo-inverse returns the minimum-norm solution. Column scaling changes
*which* solution has minimum norm, so `column` can legitimately disagree with `none`/`global`
there. A plate with more fluorophores than scanned channels is not a well-posed unmixing problem
to begin with.

### 3.1 One matrix per vessel

*This library's own — the rule is stated here; the measurement behind the threshold half of it is
Appendix A.*

White and clear plastic have separate pure-dye calibrations, so the matrix above is built **per
vessel type**, and each well is solved against the one for the plastic *it* sits in.

For every plate CFX can write this changes nothing: a `.pltd`/`.pcrd` states the vessel once, on
the root element, so every well gets the same matrix and there is exactly one. Only zpcrweb's own
`.plt.csv` can state a vessel per well ([`pltcsv.md`](./pltcsv.md) §3.1), for a block loaded with
a mix of plastics — which the instrument runs happily and no CFX format can describe. Such a run
builds two matrices and picks between them per well.

Implemented by `runAnalysis.ts`: `plateTubeTypes()` lists the vessels present, one `DyeSolver`
(matrix + column channels) is built per vessel, and `computeFluorCurves()` takes a
`solverFor(row, col)` rather than a single matrix. Each vessel's matrix covers the dyes *that*
vessel has calibration for, so a dye covered in clear but not white still quantifies in the clear
wells instead of costing the whole run its matrix.

**Thresholds are deliberately left alone** — one per fluorophore, spanning both vessels, exactly
as [`threshold.md`](./threshold.md) §5.2 describes. The reasoning that says they should be split
does not survive contact with the data:

- Baseline subtraction removes a curve's offset, not its gain, and the same dye's `columnNorm`
  really does differ between vessels by a **per-dye 0.85×–4.05×** (Appendix A, measured across
  all 14 dyes the sample archive calibrates). So a mixed plate's group *is* a bimodal population.
- But the automatic threshold is `20 × median(baseline noise)`, and baseline noise turns out to
  be an **instrument floor of ~2 RFU** — flat across every dye, every amplitude and both vessels
  — not a fraction of the signal. So pooling barely moves the median, and the threshold with it.

Measured end to end: pooling a clear run and a white run into shared per-fluor threshold groups
moved every Cq by **≤0.52 cycles, median under 0.1**, and cost no curve its Cq (Appendix A).
Splitting the groups would have meant a new persisted key in `zpcrweb.json`, a migration, and a
second threshold line on the chart, to buy that.

### 3.2 One dye per channel, per well

*This library's own. Measured — Appendix B.*

A plate may carry two dyes that are read on the **same optical channel** — a commercial panel's
ROX beside an operator's own Tex 615, both channel 2 — as long as no single well holds both. The
instrument runs that plate; the question is what matrix each well is solved against.

**Two same-channel dyes must never share a matrix.** Their response vectors are essentially
parallel — ROX, Tex 615 and Cal Red 610 are pairwise 0.999+ collinear across all six channels
(Appendix B.1) — so no linear unmixing can say how much of a channel-2 reading was which. A
matrix holding two of them is ill-conditioned (condition number 408, against 2–3 for the same
matrix with either one alone), and the pseudo-inverse answers with large, oppositely-signed
concentrations for the pair. Built from the plate's whole dye list, that poisons **every** well on
the plate, including wells whose own dyes are perfectly separable.

So the dye set is resolved per well, by `wellDyeSet()` in `runAnalysis.ts`:

```
dyes(well) = the dyes the well carries
           + each remaining plate dye whose primary channel is not already taken
```

- **The well's own dyes always win their channel.** They are what is physically in the tube.
- **Free channels are filled in** from the rest of the plate's dyes, so a well can still be
  *displayed* against a dye it doesn't carry (the app's "Unloaded" toggle) — just never against
  one that would collide with a dye it does.
- **A contested channel, in a well carrying neither rival**, goes to whichever dye more of the
  plate's loaded wells use, then plate fluor order. Only the display of empty wells depends on it.

The channel compared is `Dcal.primaryChannel`, the dye's own calibration, not whatever channel the
plate recorded — a `.plt.csv` states no channels at all.

> A plate with one dye per channel — every plate CFX can write, since a CFX dye layer *is* a
> channel position — has nothing to resolve: every well's set is the plate's whole dye list, and
> results are identical to building one matrix for the run. This rule only ever fires on a plate
> that mixes two assays.

## 4. Preprocessing the raw channel readings

Before a raw reading is fed into the solve, two corrections are applied to each channel value.
Both are **independently optional** — a run may have either, both, or neither active — and the
order matters:

1. Start from the raw per-channel mean fluorescence for the well/cycle.
2. **Per-well gain correction, pivoted on the reference level** (§4.1). This whole step is gated
   by one user-facing setting — apply well factors, on or off — as well as by whether a well-factor
   table is actually present; when it's active:

   ```
   corrected = (raw − referenceLevel) / wellFactor + referenceLevel
   ```

   When it's off, the reference level is not merely inert — it is never read from the plate read at
   all, for any purpose. It exists solely to feed this one calculation.

3. **Dark-current subtraction** (§4.2), if enabled:

   ```
   corrected = corrected − backgroundLevel
   ```

The result is the corrected channel vector that goes into §5.

Note what step 2 is *not*: the reference level is **not subtracted** from the reading. It is
removed, used as the zero point for the gain scaling, and then added straight back. Only the
portion of the signal *above* the reference level is scaled; the reference level itself passes
through untouched. It is not a background term in its own right — it has no role anywhere outside
this one calculation.

Note also that the gain factor **divides** rather than multiplies. Whether a given factor
convention is a divisor or a multiplier is pure convention, but getting it backwards inverts the
correction, so it is worth stating explicitly.

### 4.1 The reference level and the reference row

A CFX block carries **one more row than its nominal plate**: 9 rows of 12 on a 96-well block
(108 positions), 17 rows of 24 on a 384-well block (408). The extra final row is not sample
wells — it is a row of **fixed optical reference positions built into the instrument**, read on
every scan alongside the real wells. Both [`plateread.md`](./plateread.md) and
[`dcal.md`](./dcal.md) describe the resulting geometry; this section is about what analysis does
with it.

The reference row has **12 positions per channel**, one per plate column (R1–R12) — the full
width of a 96-well block's row — and every one of them is decoded and available. Of those 12, the
calibration path uses exactly **one — column 0 (R1)** — as that scan's reference level. The other
11 are not averaged in, not compared against each other, and not otherwise consulted by this
correction; they exist in the decoded data purely for the diagnostic use described below. That one
position is:

- **per-channel** — each optical channel gets its own reference value;
- **per-scan** — re-read every cycle, so it tracks slow changes in the optics over a run rather
  than being a fixed constant;
- **an in-band optical measurement** — taken through the same illumination and detection path as
  the sample wells, with the LED **on**.

That last point is what distinguishes it from dark data below, and it explains why it works as a
pivot rather than as a subtrahend: it is a *level*, a common-mode value the gain correction should
not amplify, not a *background* to be removed.

**Where the well factors themselves come from** is a separate question, and the answer is not the
reference row. They are a factory/service calibration of the instrument's optics, computed once
and stored on the instrument — analysis software just carries the values through unchanged into
the run's analysis state. A `.pcrd` stores them as a per-well × per-channel table,
`wellFactorsCollection` (see [`pcrd.md`](./pcrd.md)), which holds *two* independently-saved sets,
one per optical scan pattern the instrument supports:

- **`SnrWF`** — factors for the **step-and-repeat** scan: the slower mode that stops at each well
  in turn and cycles through every filter before moving on. (`Snr` here abbreviates
  "step-a**N**d-**r**epeat," not "signal-to-noise" — a plausible misreading the field name
  invites.)
- **`FlyoverWF`** — factors for the **flyover** scan: a single faster pass across the plate.

Each is gated by its own `snrSaved`/`flyovrSaved` header flag, and which set actually applies to a
given reading is **not a preference between the two** — it's determined by which scan pattern the
plate was physically read with, the same `scanMode` a plate's setup records (see
[`pltd.md`](./pltd.md)): `AllChannelsScan` is the step-and-repeat mode and selects `SnrWF`; any
other scan mode selects `FlyoverWF`. If the flag for the selected set is clear, that run carries a
synthesized identity table and gets no gain correction at all, regardless of what the other set
holds — that is the case for every sample committed here, where the header records the factors as
"created in Persistence loading" and every value is exactly `1`, and the sample's own `scanMode`
is `AllChannelsScan` (so `SnrWF`, had it been saved, is the set that would have applied). **A
`.zpcr` archive has no equivalent file**, so a run read from one never has a gain correction to
apply, and its reference level correspondingly has no effect.

> **TODO — this deliberately isn't applied.** Because only a `.pcrd` carries well
> factors, applying them would make the same physical run quantify differently depending on which
> file you happened to open, which breaks the format-independence rule (see
> `packages/core/src/runAnalysis.ts` and `apps/web/ARCHITECTURE.md`). `separateDyes`/`preprocessChannelReadings`
> still accept a `wellFactor` — the algorithm is documented in full and a caller may
> supply one — but `computeRunAnalysis` passes none. Revisit if a `.zpcr`-side source for the factors
> is ever found, or if a `.pcrd` with a genuinely non-identity table turns up (none of the samples
> committed here has one, so this correction has never been exercised on real data).

**It would be reasonable to expect more: that the instrument compares all 12 live reference
columns against a factory-measured baseline, every cycle, to derive a per-channel correction
factor that tracks optical drift in real time. It does not** — and §4.1a now measures that
directly, rather than inferring it: every per-cycle reference correction tried degrades agreement
with CFX's own output by 300–940×, and degrades the data on its own merits too. The reference-level read described
above is the *only* per-cycle use of reference-row data anywhere in the run-processing path, full
stop — there is no second routine anywhere that reads columns other than the one, and no routine
that folds a factory/live comparison back into a correction. What the run's metadata does carry is
a **factory calibration of the full reference row** — one static value per (channel, column),
recorded once when the instrument was serviced, not per cycle. The only thing built from it is a
**diagnostic**: this library's
reference-calibration comparison averages each column's *live* readings across the *entire run*
(not per cycle) and reports the delta against that column's factory value, as a drift indicator for
a human to look at, surfaced in a calibration/service view rather than fed into any calculation.
Be careful not to confuse that diagnostic sense of "drift" with the analysis option of the same
name (§6).

### 4.1a Measured: no per-cycle reference correction, and none would help

The same test that settled the dark current (§4.2a) settles this one, and gives the same shape of
answer for a different reason. Reconstructing CFX's exported corrected curves from this library's
separated curves, with a per-cycle reference correction applied in channel space:

| Reference correction | Median residual vs CFX | |
|---|---|---|
| **None** (current behaviour) | **7.3 × 10⁻³ RFU** | — |
| Divide by R1, renormalized | 3.60 RFU | **490× worse** |
| Divide by mean of R2–R12 | 6.87 RFU | **936× worse** |
| Subtract R1's deviation | 2.22 RFU | **302× worse** |

So the reference row is **not** consulted per cycle to correct sample readings. That is consistent
with the §4.1 finding above — it is a pivot for the well-factor division and nothing else, and with
identity well factors it is mathematically a **no-op**, which is exactly why the "none" row
reproduces CFX at 7e-3 while still passing `referenceLevel` in. Keeping it passed is harmless and
documents the algorithm; it changes no number.

**And it is not a missed opportunity.** Judged purely on its own merits, ignoring what CFX does,
a per-cycle reference correction makes the data *worse* on both axes that matter — measured over
all 288 well/dye curves of the run, cycles 3–20:

| Reference correction | Median baseline noise | Median \|baseline slope\| |
|---|---|---|
| **None** | **1.99** | **0.078** |
| Divide by R1 | 2.58 (1.29×) | 0.260 (3.3×) |
| Divide by mean of R2–R12 | 2.24 (1.12×) | 0.379 (4.9×) |
| Subtract R1's deviation | 2.53 (1.27×) | 0.255 (3.3×) |

The reason is visible directly in the raw data: **the sample wells share no per-cycle wiggle to
remove.** Mean pairwise correlation of detrended per-cycle residuals across 20 wells is −0.02 to
+0.06 on every channel — each well's jitter is independent read noise, not a common-mode optical
fluctuation. There is nothing for a reference to cancel, so any reference-based correction can only
*add* the reference's own noise (its per-cycle scatter is 1.5–5 counts) to every well, and does.

### 4.1b Two things the reference row is genuinely good for

**R1 is a near-black position, not a bright one.** Worth stating because the name "reference level"
invites the opposite assumption. Across the six channels R1 reads 2248, 2012, 1913, 1931, 2119,
2113 — only **12 to 120 counts above the same channel's dark current** (§4.2b) — while the other
11 columns run from 3180 up to 43,535. R1 is the dimmest position in the row in every channel.
That is what makes it suitable as a pivot: it is a near-zero level, so dividing about it scales
the *signal* rather than the offset.

**The bright columns carry a real, coherent optical trend.** Over a run, R2–R12 dim by 0.3–1.2%
while R1 barely moves, and the plate's *common-mode* residual — the per-cycle residual of the
mean over all 96 wells, which averages away the independent per-well noise — correlates with the
bright columns at **0.25–0.77** depending on channel. So there *is* a shared optical fluctuation,
and the reference row does see it; it is simply far below per-well read noise, which is why
correcting individual wells with it loses more than it gains.

That makes it a **run-quality metric**, not a correction: a channel whose bright reference columns
dim unusually over a run, or stop tracking the plate's common mode, is telling you something about
the optics. It sits alongside the existing whole-run factory-calibration comparison
(`refcal.ts`, surfaced in the Reference view), which answers the slower question of whether the
row has drifted since the instrument was serviced. Neither belongs in the analysis path.

### 4.2 The additive background: dark-current subtraction

> **Resolved 2026-07-28: do not subtract it, and the stage is gone.** This section used to leave
> open "which additive background belongs here". The answer, measured against CFX's own exported
> per-cycle curves ([`pcrd.md`](./pcrd.md) §2.5a), is **none** — see §4.2a. The setting that
> controlled it (`subtractDark`, off by default) has been removed from the app and from
> `zpcrweb.json`; `preprocessChannelReadings` keeps its `backgroundLevel` parameter, which
> documents the alternative and costs nothing, and nothing passes it. `DARKDATA` is now a plotted
> overlay and an instrument diagnostic only (§4.2b).

Distinct from the reference level, there is one genuinely additive background — the **dark
current**. Subtracting it *was* an optional stage of the pipeline, disabled by default; the rest
of this section describes what it would have done and why it is not done.

**Dark data (LED off).** A reading taken with the **excitation source off**, capturing detector
dark current and electronic offset — signal present regardless of illumination. Stored per plate
read as **one record per channel, not per well** (see [`plateread.md`](./plateread.md)'s
`DARKDATA`), because the offset is a property of the detection channel rather than of any plate
position. Re-read every cycle, so the level varies cycle to cycle. Skipped when a plate read
carries no dark record.

**It was never a display-only setting**, which is why removing it rather than defaulting it off
matters. Because `DARKDATA` is re-read every cycle, the level removed is *not* a constant: on the committed `20260720_Luna_noRT.pcrd` the amount taken off
B3/FAM ranges between ≈2099 and ≈2127 RFU over the run. So beyond moving reported RFU by ≈2100,
it slightly perturbs the fitted baseline slope, and — because a dark reading carries its own
measurement noise — it raises the median baseline noise the auto threshold is derived from
(`threshold.md` §5.2). Measured on that run at the default threshold multiplier, enabling the
stage moves the FAM threshold from 131 to 142 and B3/FAM's Cq from 32.1 to 32.2; the ENT rc / Cy5
threshold moves proportionally more (32 → 49), carrying C3's Cq from 20.1 to 20.7 — the largest
shift on the plate, ≈0.6 cycles. (Measured before the analysis rework of `threshold.md` §3; the
figures track the old baseline rule, the conclusion does not depend on it.) The two HMPV Ma / Texas Red wells do not move at all. Expect a
modest Cq change, not none. (The absolute thresholds scale with the multiplier, so these figures
track it; the RFU offset and the direction of the effect do not.)

Not doing it at all is what matches the reference — see §4.2a, which measures this directly and
supersedes the RFU-scale argument §8 used to make.

### 4.2a Measured: the reference does not subtract it

The `20260726_S183-S185_RVP` export makes this testable, because **`DARKDATA` is re-read every
cycle and its cycle-to-cycle variation is random**. A *constant* background is invisible to any
comparison downstream of baselining — a linear baseline removes it exactly — but a per-cycle one
is not: it injects noise that no straight line can absorb. So the question splits cleanly, and
both halves have answers:

- **The observable half.** Reconstructing CFX's exported corrected curve from this library's
  separated curve (the method of [`threshold.md`](./threshold.md) §A.7) gives a median residual of
  **7.3 × 10⁻³ RFU with the stage off, and 1.90 RFU with it on** — a **260× degradation**, rising
  to 280–540× on the cleanest wells. The 1.9 RFU is exactly the injected noise: `DARKDATA`'s
  per-cycle scatter is 1.5–5 counts, amplified by the solve. **The reference does not apply the
  per-cycle dark level.**
- **The unobservable half.** A constant offset — the dark level's mean, or any other fixed vector
  — cannot be detected this way and equally **cannot affect any reported number**, since baseline
  subtraction removes it before the threshold, the Cq or the end-point RFU are computed. So the
  question of "which constant" is not open; it is empty.

Together those close the section: subtract nothing, and the residual uncertainty is confined to a
term that provably changes no output.

### 4.2b What `DARKDATA` is actually good for

It is a real measurement and worth keeping — just not as a correction. Across the two committed
`.pcrd` runs (six days apart, same instrument), the per-channel dark level is a **stable
instrument fingerprint**:

| Channel | Level, 20260720 | Level, 20260726 | Drift over run | Per-cycle scatter |
|---|---|---|---|---|
| 0 | 2127.1 | 2126.9 | ≤ 0.4 | 1.6–2.0 |
| 1 | 2002.5 | 2002.3 | ≤ 1.9 | 1.5–2.0 |
| 2 | 1879.8 | 1879.5 | ≤ 3.0 | 1.7–2.0 |
| 3 | 1898.9 | 1898.2 | ≤ 1.7 | 1.6–1.7 |
| **4** | **1908.7** | **1909.7** | **−4.1 / −5.4** | **4.1–5.0** |
| 5 | 2062.6 | 2062.0 | ≤ 2.8 | 1.7–1.8 |

Levels reproduce to **~1 count in 2000 (0.05%)** across runs, and drift under 3 counts within a
run. That makes three uses, all diagnostic:

1. **Instrument health.** A channel whose dark level moves by more than a few counts between runs,
   or drifts within one, indicates a detector or electronics problem. The stability above is what
   "normal" looks like on this instrument.
2. **A known per-channel anomaly.** **Channel 4 is consistently noisier** — 2.5–3× the scatter of
   every other channel, plus the largest drift, in *both* runs. Reproducible across runs, so it is
   a property of this instrument's channel-4 detector rather than a one-off. Worth surfacing.
3. **A sanity floor on the raw readings.** Dark current is the *majority* of a raw well reading
   here — ~1880–2130 counts against well readings of ~2250–2950, so the LED-on optical signal is
   only a few hundred counts above it. A well reading at or below its channel's dark level is
   physically meaningless and should be flagged rather than separated.

The web app already plots the dark curves as a Curves-view overlay; that is the right home for
all three, and no analysis stage consumes them. Surfacing 1–3 as actual checks is
[`TODO.md`](../TODO.md) work; only the removal of the subtraction stage has landed.

> The `.Dcal` `empty` blocks are **not** a second background candidate. They are consumed by §2
> as the per-temperature baseline each matrix column is differenced against
> (`dyeReading − emptyReading`) and have no separate role here.

The reference level is a different mechanism and should not be conflated with this one:

| | Reference level (§4.1) | Dark data (§4.2) |
|---|---|---|
| Illumination | LED **on** | LED **off** |
| Source | Reference row, per scan | `DARKDATA`, per scan |
| Captures | Optical/common-mode level through the real light path | Detector dark current + electronic offset |
| Applied as | **Pivot** for gain scaling — removed then restored | **Subtracted** outright, when enabled |
| Net effect if gain correction is off | None | Still subtracted |

## 5. Solving for dye concentrations

This is now an ordinary linear system: `M · concentrations = correctedChannelReadings`, where
`M` is the channel×dye calibration matrix from §3. Solve it via `M`'s **pseudo-inverse**:

```
concentrations = pinv(M) · correctedChannelReadings
```

- When `M` is **square** (channel count equals dye count) and well-conditioned, the
  pseudo-inverse is just the ordinary matrix inverse — this is the common case for a
  full-channel-count assay.
- When it isn't square (e.g. fewer dyes loaded than channels available), the pseudo-inverse
  gives the least-squares solution: the concentration vector that minimizes the squared error
  between `M · concentrations` and the observed reading.

**Numerical stability matters here.** A pseudo-inverse computed via singular value
decomposition inverts each singular value (`1/σᵢ`); a calibration matrix with two very similar
dyes (near-identical channel fingerprints) or an otherwise poorly-conditioned matrix can have a
singular value very close to zero, and inverting it directly blows up into a huge, meaningless
concentration. The standard fix — and what this library does — is to **threshold small singular
values to zero** before inverting (a cutoff relative to the largest singular value, sometimes
called `rcond`), rather than inverting everything unconditionally. A direct-inversion
implementation with no such floor is a real risk, not a hypothetical one — treat any
color-separation implementation without a documented threshold as suspect.

A floor on the singular values is necessary but not sufficient: the routine that *produces* those
singular values has to be scale-invariant too (§3), or the floor ends up applied to numbers that
are wrong in the first place.

### 5.1 What the reported number means

The raw solve is against `M` as §3 scaled it, so its output carries whatever units that scaling
implies. Two factors turn it into a fixed, reportable quantity, independent of §3's normalization
mode:

```
rfu[dye] = solved[dye] × columnScale[dye] × columnNorm[dye]
```

- `columnScale` is the factor §3 multiplied that column by. Dividing it back out leaves the
  concentration relative to the **pure calibration dye**: `1.0` means "as bright as this dye was
  in its `.Dcal` measurement." That value is normalization-independent but dimensionless, and
  lands around `0.5` for a real well — nothing like an instrument RFU reading.
- `columnNorm` is the L2 norm of that dye's *raw* response column, i.e. the RFU the dye produces
  across the scanned channels at unit concentration. Multiplying by it converts the dimensionless
  concentration into **the RFU that dye contributes to this reading**, on the same scale as the
  raw channel values that went in.

So a reported value is "how much of the observed signal, in RFU, this dye accounts for." On the
committed sample that puts a mid-run well in the low thousands before dark subtraction and the
low hundreds after — the right order of magnitude for an instrument RFU trace. See §8 for the
convention this scale rests on.

## 6. "Drift correction" is a different stage entirely

Analysis software for these instruments exposes a user-facing **drift correction** option, and it
is natural to assume it is the mechanism that compensates for optical drift using the reference
row. **It is not.** Keeping the two apart matters, because they act at different stages on
different data:

- **Optical drift** is a property of the *instrument* — LEDs dim, filters and detectors age. The
  reference row is what makes it observable (§4.1), and the per-scan reference level is what keeps
  the gain correction anchored as it happens. There is no user-facing switch for this; it is part
  of producing a calibrated reading at all.
- **Drift correction (the option)** operates much later, on the *already colour-separated
  amplification curve*, and is a **baseline** setting. It sits alongside the other per-fluorophore
  baseline and threshold parameters — baseline start/end cycles, baseline method, automatic vs
  manual thresholds — and it governs how the curve's baseline is fitted and removed before a
  quantification cycle (Cq) is determined. Its concern is a **sloping baseline in the
  amplification trace**, not the optical path. The application's own menu wording names it
  *baseline* drift correction.

Consequences worth knowing:

- Drift correction consumes **neither the reference row nor the dark data**. It runs on data that
  has already been through §4 and §5.
- It is a **per-fluorophore** setting, persisted with the run's analysis parameters, not a global
  instrument property.
- Enabling it forces baselines to be **recomputed automatically** rather than reused from stored
  values, so toggling it can change Cq values for wells whose baselines had been manually set.
- Because it is downstream of colour separation, it has no bearing on the correctness of the
  calibration described in this document. **Nothing in §§2–5 changes when it is toggled.**

This library implements §§2–5 only. Baseline fitting and Cq determination — and therefore drift
correction — are not part of the colour-separation path; the closest thing here is the simple
delta-baseline helper, which is a display transform rather than a baseline-fitting algorithm.

## 7. API summary

```ts
import {
  buildDyeResponseCurve,
  buildCalibrationMatrix,
  interpolateResponse,
  preprocessChannelReadings,
  separateChannels,
  separateDyes,
} from "@zpcrweb/core";

// One curve per dye, from its .Dcal data (§2).
const curves = dcals.map((dcal) => buildDyeResponseCurve(dcal));

// Sample those curves at this reading's block temperature, over the scanned channels (§3).
const matrix = buildCalibrationMatrix(curves, blockTemperatureC, { channels: zpcr.channels() });

// The optional dark-current level (§4.2), from this plate read's own DARKDATA — one record per
// channel. Omit `backgroundLevel` entirely to leave the stage off, which is the default.
const backgroundLevel = zpcr.channels().map((ch) => darkByChannel.get(ch)!.mean[cycle]!);

// Apply the same corrections a live reading needs (§4).
const corrected = preprocessChannelReadings(rawChannelMeans, {
  referenceLevel,
  wellFactor,
  backgroundLevel,
});

// Solve (§5). `concentrations` is per-dye RFU, independent of the normalization mode above.
const { dyes, concentrations, failed } = separateChannels(matrix, corrected);
```

`separateDyes(dcals, rawChannelReadings, temperatureC, options)` chains all four steps for the
common case of a one-off separation; use the individual functions instead when reusing a
calibration matrix across many wells or cycles at the same temperature, since rebuilding it per
call is wasted work.

## 8. Limitations / open items

> **The per-dye scale factor below is contradicted by a much stronger measurement, and should be
> treated as withdrawn pending re-testing.** See the new first bullet.

- **Cross-validated end-to-end on one run, and it matches.** `20260726_S183-S185_RVP.pcrd` ships
  with CFX Manager's own exported per-cycle results (see [`pcrd.md`](./pcrd.md) §2.5a). Running
  this library's separation over that `.pcrd` and subtracting CFX's exported baseline-corrected
  curve leaves, for 17 of 24 curves, **a straight line in the cycle number with a residual RMS of
  4–9 × 10⁻³ RFU** — see [`threshold.md`](./threshold.md) §A.7. Since baselining subtracts a
  straight line, that is the strongest agreement the comparison can show: this library's dye-space
  curve and CFX's differ by nothing except the baseline that both then remove.

  It also **bounds any multiplicative term to ~10⁻⁶**. A scale error `k` would leave a residual
  proportional to the curve's own amplification, and FAM well E9 rises 4653 RFU while
  reconstructing to 4.5 × 10⁻³ RFU. A `k` of 1.0975 would leave ~450 RFU. Fitting `k` explicitly
  over the pre-amplification range of the nine wells with a Cq gives 1 ± 2 × 10⁻⁵ for every FAM
  well. The 8–10% per-dye constant reported below is excluded on this run by four orders of
  magnitude.

  The remaining 7 curves (six Cy5 wells and Tex 615 G4) fit the line only to 0.14–0.46 RFU —
  ~2 × 10⁻⁴ relative. That is real but small, is present on flat curves where no analysis stage
  runs, and is dye-and-well specific (Cy5 C4 misses while FAM in the same well is exact). Well
  factors are ruled out: this `.pcrd` carries the default identity table. **This is the open
  question that replaces the one below**, and it is two orders of magnitude smaller.

- **Why the older comparison probably misread.** The measurements below pair this library's *raw,
  un-baselined* cycle-45 value against CFX's **End RFU**, and those are not the same quantity:
  End RFU is the mean of the last five cycles of the **baseline-corrected** curve
  ([`threshold.md`](./threshold.md) §A.5). Re-running the comparison like-for-like on the same
  `20260720_Luna_noRT.pcrd` wells makes the disagreement *worse*, not better — this library's
  baselined end-point comes out at 0.29–0.61× the quoted figures, and C3/FAM at −46 RFU against a
  quoted 2115 — which says the quoted numbers are not baselined mean-of-five values either, and so
  cannot be interpreted without knowing what analysis mode produced them. Two scalars of uncertain
  definition, one of them read off a chart, lose to a full-curve comparison on 24 curves.
  **Getting a CSV export for that run would settle it**; until then the RVP result stands.

- ~~**The absolute RFU scale does not yet reproduce the instrument software's: a per-dye
  multiplicative constant is missing.**~~ *(Withdrawn — see above. Retained for the record and
  because the ruled-out list is still useful.)* Reference measurements from the committed
  `20260720_Luna_noRT.pcrd` (block 59.99 °C, dark subtraction off — i.e. what this library
  reports by default) against CFX Manager's own figures for the same run. End RFU is from its endpoint
  table (exact); cycle-1 values were read off its chart (approximate):

  | Well | Dye | Cycle 45, here | CFX End RFU | here ÷ CFX | Cycle 1, here | CFX chart |
  |---|---|---|---|---|---|---|
  | B3 | FAM | 8965.4 | 8169 | **1.0975** | 3273.5 | just over 3000 |
  | C3 | FAM | 2295 | 2115 | **1.0850** | — | — |
  | C3 | Cy5 | 3707 | 4038 | **0.9180** | 2337 | just over 2600 |
  | D3 | Texas Red | 6238 | 6232 | **1.0009** | 4018 | a bit over 4000 |

  A **pure per-dye scale with no additive term** fits all seven observations: dividing this
  library's cycle-1 values by the same per-dye ratio gives 2982, 2546 and 4014, against chart
  readings of "just over 3000", "just over 2600" and "a bit over 4000". Three things follow:

  1. **This run had dark subtraction off (§4.2).** *(Now measured directly, and generally — see
     §4.2a.)* The fit needs no additive term at all, and
     enabling the stage would show up as an offset — it would put B3/FAM's cycle 1 at ≈1152
     against an observed ≈3000. That fixes the setting for this comparison; it says nothing
     about the outstanding scale factor, which is multiplicative.
  2. **The constant is per-dye, not global** — Texas Red matches to 0.1% while FAM is 9.8% high
     and Cy5 8.2% low — **and not per-well**: FAM's two wells agree to ≈1%.
  3. **Curve shape, and therefore Cq, is unaffected**, since a per-dye scale is constant across
     cycles. This is a reporting-scale defect only.

  The mechanism is **not yet identified**, and the following are ruled out by measurement on
  this file: §3's normalization (cancels exactly, §5.1); the temperature the curves are sampled
  at (cancels — and no single reference temperature fits both FAM, which would need ≈70 °C, and
  Cy5, which would need ≈57 °C); the well `0` sample below (the `.Dcal` response is bit-identical
  across all 108 wells); the empty channel-6 row (a zero row is a no-op in a least-squares
  solve); the other vessel type (`BR White` runs ≈4× larger, not 0.9×); §4.1's well factors
  (this run's `wellFactorsCollection` really is the identity table — `snrSaved` and `flyovrSaved`
  are both `False` — and a well factor derived from each well's cycle-1 reading against the plate
  mean gives 1.44/1.02/1.11/2.02 where 1.098/1.085/0.918/1.001 is needed); a `factory`-flagged
  alternative calibration block (each `.Dcal` here holds exactly 8 blocks, 4 temperatures ×
  dye/empty, with no second set); and re-weighting the least-squares rows, tried three ways
  (by `‖M row‖`, by 1/reading and by 1/std², none of which lands near the observed pattern).

  Worth noting as a lead: Texas Red — the one dye that matches — is also the one whose response
  is essentially flat in temperature (4758/4769/4744/4761 across 20–80 °C), while FAM and Cy5
  both fall with temperature and miss in *opposite* directions.

- **The absolute RFU scale is a convention.** §5.1's `columnNorm` factor puts the output on an RFU
  scale that is self-consistent, stable across normalization modes, and the right order of
  magnitude. The specific choice — the L2 norm of the dye's response across the scanned channels —
  is this library's, made because it is the quantity that is both scale-invariant and
  dimensionally an RFU. An alternative would be to normalize on the dye's **primary channel**
  response alone instead; for these dyes the primary channel dominates the column, so the two
  differ by only a few percent. Relative curve shape and Cq are unaffected either way.
- This library always derives the calibration matrix from `.Dcal` files. Some systems also
  support a user-edited override matrix that takes precedence over the calibration-derived one;
  that override mechanism isn't modeled here.
- The empty-plate blocks enter the algorithm **only** through this subtraction — nothing
  downstream reads them again. `buildDyeReadingCurves` returns the dye and empty readings
  separately for callers that want to show the two levels a response is the difference of (the
  web app's Calibration view does); `buildDyeResponseCurve` is defined as the clamped difference
  of its output, so there is one place the blocks are paired up.
- `buildDyeResponseCurve` reads well `0` (A1) of each calibration block by default. Every file
  this library has decoded carries a uniform value across all wells in a channel (see
  [`dcal.md`](./dcal.md) §3), so this is representative in practice, but the parameter exists so
  a caller can pass a different well if that ever isn't true.
- The pseudo-inverse here is computed from the eigen-decomposition of the calibration matrix's
  Gram matrix (`Mᵀ·M`), which is mathematically equivalent to an SVD-based pseudo-inverse for
  these purposes but is a simpler implementation suited to the small (≤6×6) matrices this
  library handles — not a general-purpose numerical linear algebra routine.

## Appendix A. Mixed vessels — what a shared threshold actually costs

The measurement behind §3.1's decision to build a matrix per vessel but leave thresholds pooled.
All numbers from the committed samples, at 60 °C, `normalization: global`.

### A.1 The per-dye vessel gain

`columnNorm` — the RFU a dye produces at unit concentration, and the factor §5.1 multiplies the
solved concentration by — for all 14 dyes `20260720_FirstQualification.zpcr` calibrates, in both
vessels:

| Dye | BR Clear | BR White | White/Clear |
|---|---|---|---|
| HEX | 3725 | 15073 | 4.05 |
| FAM / SYBR | 3951 | 15628 | 3.96 |
| Cal Orange 560 | 2611 | 9860 | 3.78 |
| Cal Gold 540 | 1978 | 7437 | 3.76 |
| Cy5 | 2577 | 9048 | 3.51 |
| Tex 615 / Texas Red | 4751 | 15804 | 3.33 |
| VIC | 5993 | 18908 | 3.16 |
| ROX | 6883 | 21009 | 3.05 |
| Cal Red 610 | 11955 | 20721 | 1.73 |
| Cy5-5 | 5557 | 8033 | 1.45 |
| Quasar 670 | 4226 | 4154 | 0.98 |
| Quasar 705 | 4602 | 3933 | 0.85 |

The ratio is **per dye, not a constant**: 0.85× to 4.05×. Quasar 670 in white and in clear is the
same response to within 2%; FAM differs fourfold.

### A.2 Why that does *not* propagate to the threshold

Two facts, both measured, cancel most of A.1's apparent problem.

**The reported RFU is nearly invariant to which vessel's matrix you use.** §5.1's reconstruction is
`solved × columnScale × columnNorm`; solving against a column that is ¼ the size returns ~4× the
concentration, and `columnNorm` then multiplies by ~¼. Measured on the same 24 physical wells,
white matrix vs clear matrix: FAM's median ΔRFU moves 4177 → 3872, **8%, not 4×**. Picking the
wrong vessel perturbs the *cross-channel unmixing* — which is what §3.1's per-well matrix is for —
not the overall scale.

**Baseline noise is an instrument floor, not a fraction of the signal.** Median `baselineNoise()`
per dye, across three runs and both vessels, spans only **1.87–2.94 RFU** — while median ΔRFU
spans −4 to 5609. A dye at SNR 2533 and one at SNR −2 have the same ~2 RFU noise. So
§5.2's `20 × median(noise)` lands at 37–58 RFU everywhere:

| Run | Vessel | FAM | Tex 615 | Cy5 | VIC | ROX |
|---|---|---|---|---|---|---|
| `20260720_FirstQualification` | BR Clear | 41.1 | 39.6 | 37.5 | — | — |
| `20260726_S183-S185_RVP` | BR Clear | 37.9 | 44.9 | 45.3 | — | — |
| `20260807-YouSeq_RT_-_S56` | BR White | 58.0 | — | 54.8 | 40.1 | 49.3 |

### A.3 The combined-plate experiment

`20260720_FirstQualification` (clear) and `20260807-YouSeq_RT_-_S56` (white) pooled into shared
per-fluorophore threshold groups, against each run analysed on its own. **B** solves each well
with its own vessel's matrix (what §3.1 ships); **C** declares the whole plate clear.

Pooled thresholds: FAM 41.1 / 58.0 → 56.7; Cy5 37.5 / 54.8 → 53.0. Median ΔCq:

| | FAM | Cy5 | VIC | ROX | Tex 615 |
|---|---|---|---|---|---|
| **B**, FirstQualification wells | +0.49 | +0.52 | — | — | 0.00 |
| **B**, YouSeq wells | −0.10 | −0.05 | 0.00 | 0.00 | — |
| **C**, FirstQualification wells | +0.45 | +0.52 | — | — | 0.00 |
| **C**, YouSeq wells | −0.00 | −0.04 | +0.03 | 0.00 | — |

**Worst case 0.52 cycles; no curve gained or lost a Cq.** The FirstQualification wells are the
worst case by construction — 1–3 loaded wells per dye against YouSeq's ~11, so the pooled median
is effectively YouSeq's alone — and the shift is exactly `log2(56.7/41.1) = 0.46`.

That is the whole cost of one threshold per fluorophore on a mixed plate, and it buys keeping
`zpcrweb.json`'s override keys, §5.2's measured "one threshold per fluorophore" rule, and a single
threshold line on the chart.

> **Future:** A.1's gain is a *known* per-dye scalar, so a threshold could be defined in one
> reference vessel's RFU and converted per well, making a mixed plate's Cq comparable across
> plastics by construction. Deliberately not implemented: A.3 measures the thing it would fix at
> under 0.52 cycles, and it would cost a second threshold line on the chart and a persisted-format
> change. Worth revisiting only if a real mixed plate shows a discrepancy this doesn't explain.


## Appendix B. Same-channel dyes — why they cannot share a matrix

The measurement behind §3.2. All numbers from `20260720_FirstQualification.zpcr`'s `.Dcal` set,
BR Clear at 60 °C.

### B.1 The channel-2 dyes are collinear, not merely similar

Four of the dyes Bio-Rad calibrates are read on channel 2. Their raw per-channel response:

| Dye | ch0 | ch1 | ch2 | ch3 | ch4 | ch5 |
|---|---|---|---|---|---|---|
| ROX | 82 | 78 | **6881** | 86 | 6 | 0 |
| Tex 615 | 94 | 43 | **4744** | 252 | 8 | 0 |
| Cal Red 610 | 68 | 52 | **11940** | 593 | 5 | 0 |
| FAM | 3946 | 179 | 10 | 0 | 6 | 0 |
| Cy5 | 73 | 22 | 105 | 2553 | 323 | 0 |

They differ substantially in *brightness* — 4744 to 11940 on their own channel — but hardly at all
in *direction*, which is the only thing a linear solve can use. Cosine similarity of the response
vectors:

| Pair | cos |
|---|---|
| Cal Red 610 vs Tex 615 | **0.99988** |
| Cal Red 610 vs ROX | **0.99927** |
| ROX vs Tex 615 | **0.99915** |
| Cy5 vs Tex 615 | 0.09410 |
| FAM vs Tex 615 | 0.02272 |

A dye pair at cos ≈ 1 is inseparable by any number of channels: the two columns point the same
way, so infinitely many concentration pairs explain the same reading equally well.

**Tex 615 and Texas Red are the same calibration** — byte-identical `.Dcal` blocks under two
names, in both vessels. They are aliases, not rivals, and a plate naming both means one dye.

### B.2 What that does to the solve

Condition number of the calibration matrix (global normalization, 6 channels):

| Dye set | cond |
|---|---|
| {FAM, ROX, Cy5} | 2.7 |
| {FAM, Tex 615, Cy5} | 1.9 |
| {FAM, ROX, Tex 615, Cy5} | **407.7** |

And end to end, on a real plate carrying the YouSeq panel (ROX) in white tubes beside the
operator's RVP multiplex (Tex 615) in clear ones — one matrix over the whole plate's dye list,
against §3.2's per-well sets:

| Dye | one matrix | per-well sets |
|---|---|---|
| FAM | 59.9 | 55.5 |
| VIC | 68.0 | 40.1 |
| ROX | **8119.5** | 49.3 |
| Tex 615 | **6881.6** | 45.4 |
| Cy5 | 333.6 | 52.6 |

With one matrix, ROX's threshold is 165× its normal value, Tex 615 gets no Cq at all, and ΔRFU
swings to −5384 on wells that should read flat — the pair trading enormous opposite
concentrations. With per-well sets every threshold is back in the ordinary tens of RFU, and the
panel's own dyes land within a fraction of a percent of what that panel's run produces alone
(ROX 49.3 and VIC 40.1 are identical to it).
