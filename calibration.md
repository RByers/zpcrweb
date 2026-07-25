# Channel→Dye Color Separation

The 6 optical channels a Bio-Rad CFX instrument reads don't map one-to-one onto the dyes loaded
in a plate: every dye bleeds some fluorescence into its neighboring channels (see the worked
example in [`dcal.md`](./dcal.md) §6 — Cal Gold 540 puts 31% of its signal into channel 1, Cy5-5
puts 17% into channel 4). **Color separation** is the process of "unmixing" that cross-talk:
given the 6 raw channel readings for a well and the pure-dye calibration data for the dyes on
the plate, estimate how much each dye actually contributed.

> **Status:** implements the algorithm below in full (§§2–5), including preprocessing (§4) —
> [`packages/core/src/calibration.ts`](./packages/core/src/calibration.ts) (linear algebra in
> [`linalg.ts`](./packages/core/src/linalg.ts)), tested against the calibration data in the
> committed sample archives. The open item is the *absolute* RFU scale: which additive
> background belongs in §4.2, and a residual gap against CFX Manager's own reported RFU that
> no §§2–5 choice explains — both worked through in §8.

---

## 1. Overview

The algorithm takes:

- **Calibration data**: for each dye of interest, a pure-dye measurement and a matching
  empty-plate measurement across all 6 channels, at four reference block temperatures (20/40/60/
  80 °C) — exactly what a `.Dcal` file holds. See [`dcal.md`](./dcal.md).
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

3. **Background subtraction** (§4.2), if enabled:

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

**It would be reasonable to expect more: that the instrument compares all 12 live reference
columns against a factory-measured baseline, every cycle, to derive a per-channel correction
factor that tracks optical drift in real time. It does not.** The reference-level read described
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

### 4.2 The additive background: which zero point?

Distinct from the reference level, there is a genuinely additive background to remove — and
there are **two different candidates for it**. They are alternatives, not stages: subtracting
both would double-count. Whichever is chosen is **subtracted outright** from every channel
reading, after the gain correction.

**Dark data (LED off).** A reading taken with the **excitation source off**, capturing detector
dark current and electronic offset — signal present regardless of illumination. Stored per plate
read as **one record per channel, not per well** (see [`plateread.md`](./plateread.md)'s
`DARKDATA`), because the offset is a property of the detection channel rather than of any plate
position. Re-read every cycle. Skipped entirely when a plate read carries no dark record.

**The empty-plate background.** The `.Dcal` `empty` blocks (§2), read as absolute values rather
than differenced away — the fluorescence of an empty vessel of this plate type at this block
temperature. It is *larger* than the dark level, by the plate/optics autofluorescence a LED-off
reading cannot see: on the committed sample, channel 1 at 60 °C reads ≈2516 empty-plate against
≈2124 dark, a ≈390 RFU gap. Static per run (a calibration constant), not per cycle.

**The empty-plate reading is the coordinate-consistent choice**, and this is the single most
important thing to get right here. §2 defines every matrix column as `dyeReading − emptyReading`,
so the matrix's origin — the point where all dye concentrations are zero — *is* the empty plate.
Feeding it a reading measured from a different origin mixes coordinate systems: the leftover
constant is unmixed into the dyes as though it were signal, lifting every dye's whole curve by a
fixed amount. Subtracting the dark level alone removes part of that constant, not all of it, and
is the one option that is consistent with neither origin.

That is the argument from the math. It is **not** what matches observed instrument output, which
is why the choice is exposed rather than settled — see §8, and note that all three options shift
a curve by a constant and so change reported RFU but never curve shape, ΔRq or Cq.

The reference level is a different mechanism again, and should not be conflated with either:

| | Reference level (§4.1) | Dark data (§4.2) | Empty plate (§4.2) |
|---|---|---|---|
| Illumination | LED **on** | LED **off** | LED **on** |
| Source | Reference row, per scan | `DARKDATA`, per scan | `.Dcal` `empty` blocks, static |
| Captures | Optical/common-mode level through the real light path | Detector dark current + electronic offset | Dark current **plus** plate/optics autofluorescence |
| Applied as | **Pivot** for gain scaling — removed then restored | **Subtracted** outright | **Subtracted** outright |
| Net effect if gain correction is off | None | Still subtracted | Still subtracted |

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
  buildPlateBackgroundCurve,
  averagePlateBackground,
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

// The empty-plate origin those columns are measured from (§4.2) — every dye's .Dcal measures
// the same physical empty plate, so average them rather than trusting one file.
const background = averagePlateBackground(dcals.map((d) => buildPlateBackgroundCurve(d)))!;
const backgroundLevel = zpcr
  .channels()
  .map((ch) => interpolateResponse(background.channels[ch] ?? [], blockTemperatureC));

// Apply the same corrections a live reading needs (§4). `backgroundLevel` takes either the
// empty-plate level above or the plate read's DARKDATA — one or the other, never both.
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

- **The absolute RFU scale does not yet reproduce the instrument software's, and the residual
  looks like a per-well gain rather than anything in §§2–5.** Worked example, from the committed
  `20260720_Luna_noRT.pcrd`, well B3 (FAM/Texas Red/Cy5), block 59.99 °C:

  | Quantity | Cycle 1 | Cycle 45 |
  |---|---|---|
  | Raw channel 1 mean | 3336.7 | 9069.7 |
  | Separated FAM, no background subtracted | 3273.5 | 8965.4 |
  | Separated FAM, dark subtracted (dark = 2123.9) | 1152.5 | 6845.9 |
  | Separated FAM, empty plate subtracted (empty = 2516) | ≈765 | ≈6459 |
  | **CFX Manager's own curve** | **just over 3000** | **8169** (its End RFU) |

  The cycle-1 reading settles two questions at once:

  1. **CFX's End RFU is an absolute end point, not a baseline-subtracted one** — its curve
     starts near 3000, not near zero. So the amplitude argument that would have been needed
     otherwise (≈1.44× ours, unreachable anywhere in §§2–5) does not arise.
  2. **`none` is the right background default.** Only the no-subtraction curve starts in the
     right place; dark subtraction starts at 1152 and empty-plate subtraction at ≈765, both far
     below what the instrument plots. This is what §4.2's default rests on — note that it is an
     empirical match, and that it is *not* the choice §4.2's own coordinate argument prefers.

  What is left is a near-constant **≈0.91 ratio** (8169/8965.4 at cycle 45; a pure scale would
  put cycle 1 at 2983). Everything §§2–5 could contribute has been ruled out: §3's normalization
  cancels exactly (§5.1), the temperature the curves are sampled at cancels, the `.Dcal`
  response is bit-identical across all 108 wells so the well-0 read below is not it, and the
  channel-6 row the `.Dcal` leaves empty is a zero row, which contributes nothing to a
  least-squares solve whether it is present or dropped.

  That leaves a **per-well, per-channel gain** — §4.1's well factors — as the leading
  explanation: `1/1.0975 ≈ 0.91`, or ≈1.13 read as a pivoted correction against this scan's
  reference level of 2259. This file cannot confirm it, because its `wellFactorsCollection` is
  the synthesized identity table (§4.1) — which would mean CFX Manager derives the factors from
  the run rather than reading them back, something this project has no evidence for either way.
  **The test that would settle it:** compare CFX's End RFU against this library's for the *same
  fluor in several different wells*. A ratio that varies well to well confirms a per-well gain;
  a ratio that stays at 0.91 means the remaining error is a global scale convention after all.

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
- `buildDyeResponseCurve` reads well `0` (A1) of each calibration block by default. Every file
  this library has decoded carries a uniform value across all wells in a channel (see
  [`dcal.md`](./dcal.md) §3), so this is representative in practice, but the parameter exists so
  a caller can pass a different well if that ever isn't true.
- The pseudo-inverse here is computed from the eigen-decomposition of the calibration matrix's
  Gram matrix (`Mᵀ·M`), which is mathematically equivalent to an SVD-based pseudo-inverse for
  these purposes but is a simpler implementation suited to the small (≤6×6) matrices this
  library handles — not a general-purpose numerical linear algebra routine.
