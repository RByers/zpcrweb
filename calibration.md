# Channel→Dye Color Separation

The 6 optical channels a Bio-Rad CFX instrument reads don't map one-to-one onto the dyes loaded
in a plate: every dye bleeds some fluorescence into its neighboring channels (see the worked
example in [`dcal.md`](./dcal.md) §6 — Cal Gold 540 puts 31% of its signal into channel 1, Cy5-5
puts 17% into channel 4). **Color separation** is the process of "unmixing" that cross-talk:
given the 6 raw channel readings for a well and the pure-dye calibration data for the dyes on
the plate, estimate how much each dye actually contributed.

> **Status:** implements the algorithm below (§§2–5), including the preprocessing stage (§4) —
> [`packages/core/src/calibration.ts`](./packages/core/src/calibration.ts) (linear algebra in
> [`linalg.ts`](./packages/core/src/linalg.ts)), tested against the calibration data in the
> committed sample archives. Not yet cross-validated end-to-end against a reference instrument's
> own color-separated output, so treat this as "correct per the algorithm below," not
> "byte-for-byte verified." The two problems this document previously tracked are both **fixed**:
> the normalization modes no longer change the reported RFU scale (§3 explains what the cause
> turned out to be — a scale-dependent eigensolver, not the normalization itself), and the web
> app now wires the §4 corrections through (§4). What is still open is the *absolute* RFU scale
> and the choice of well-factor set — see §8.

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

> **Resolved:** this document previously recorded that the modes produced RFU magnitudes "far
> more different than real instrument software's equivalent setting does," and guessed the cause
> was the wrong mode being treated as the reference default. It was neither. Two distinct
> defects:
>
> 1. **A scale-dependent eigensolver.** The Jacobi routine backing the pseudo-inverse
>    ([`linalg.ts`](./packages/core/src/linalg.ts)) tested convergence against an **absolute**
>    threshold on the off-diagonal sum of squares. Scaling a matrix by `s` scales that quantity by
>    `s²`, so a small-magnitude matrix satisfied the test before a single rotation ran and came
>    back with its untouched diagonal reported as the eigenvalues. `global` normalization shrinks
>    the matrix by `‖M‖_F` (≈ 6000 for the committed sample), which was enough to push the solve
>    into that regime: with 14 dyes it produced concentrations around `1e9`. The threshold is now
>    relative to `‖input‖_F`, making the whole pipeline scale-invariant.
> 2. **The normalization was never undone.** Even with a correct solver, each mode divided the
>    output by its own factor — measured at exactly `‖M‖_F` = 6006× between `none` and `global` on
>    a 3-dye matrix. §5 now folds `columnScale` back in, so the mode is invisible in the result.
>
> One genuine exception survives, and it is mathematics rather than a bug: when there are **more
> dyes than channels**, the system is underdetermined and the pseudo-inverse returns the
> minimum-norm solution. Column scaling changes *which* solution has minimum norm, so `column` can
> legitimately disagree with `none`/`global` there. A plate with more fluorophores than scanned
> channels is not a well-posed unmixing problem to begin with.

## 4. Preprocessing the raw channel readings

Before a raw reading is fed into the solve, two corrections are applied to each channel value.
Both are **independently optional** — a run may have either, both, or neither active — and the
order matters:

1. Start from the raw per-channel mean fluorescence for the well/cycle.
2. **Per-well gain correction, pivoted on the reference level** (§4.1). If per-well correction
   factors are in play:

   ```
   corrected = (raw − referenceLevel) / wellFactor + referenceLevel
   ```

3. **Dark-current subtraction** (§4.2), if enabled:

   ```
   corrected = corrected − darkLevel
   ```

The result is the corrected channel vector that goes into §5.

Note what step 2 is *not*: the reference level is **not subtracted** from the reading. It is
removed, used as the zero point for the gain scaling, and then added straight back. Only the
portion of the signal *above* the reference level is scaled; the reference level itself passes
through untouched. If no per-well factors are active, the reference level has **no effect
whatsoever** on the reading — it is not a background term in its own right.

Note also that the gain factor **divides** rather than multiplies. Whether a given factor
convention is a divisor or a multiplier is pure convention, but getting it backwards inverts the
correction, so it is worth stating explicitly.

> **Resolved:** this stage was correctly implemented in `preprocessChannelReadings`, but
> [`apps/web/src/lib/fluorCurves.ts`](./apps/web/src/lib/fluorCurves.ts)'s `computeFluorCurves`
> — the only caller of the color-separation pipeline in the web app — invoked it as
> `preprocessChannelReadings(raw)` with no options object at all, so neither correction was ever
> applied. `computeFluorCurves` now takes a `FluorCorrections` argument and the curves view fills
> it in: the per-scan reference level from the reference row (§4.1), the per-scan dark level from
> the same reads' `DARKDATA` (§4.2), and the per-well gain factors when the run carries them.
>
> One correction to this document's earlier account of the bug: it claimed both
> `referenceLevel` *and* `wellFactor` come "via the reference row." They do not. The reference row
> supplies only the reference level; the well factors are a separate per-well table that a `.zpcr`
> does not carry at all (§4.1). In practice, then, wiring this stage up changes a `.zpcr`-sourced
> run's output **only by the dark subtraction** — with no well factors, the reference level is a
> pivot with nothing to pivot, exactly as specified. It is a real change nonetheless: the dark
> level is per-channel, so subtracting it shifts the channel proportions the solve unmixes rather
> than merely offsetting every dye equally. On the committed sample it takes a well's separated
> FAM value at the last cycle from ≈2131 RFU to ≈142 RFU.

### 4.1 The reference level and the reference row

A CFX block carries **one more row than its nominal plate**: 9 rows of 12 on a 96-well block
(108 positions), 17 rows of 24 on a 384-well block (408). The extra final row is not sample
wells — it is a row of **fixed optical reference positions built into the instrument**, read on
every scan alongside the real wells. Both [`plateread.md`](./plateread.md) and
[`dcal.md`](./dcal.md) describe the resulting geometry; this section is about what analysis does
with it.

Of that whole reference row, the calibration path uses exactly **one position per channel — the
first** — as that scan's reference level. It is:

- **per-channel** — each optical channel gets its own reference value;
- **per-scan** — re-read every cycle, so it tracks slow changes in the optics over a run rather
  than being a fixed constant;
- **an in-band optical measurement** — taken through the same illumination and detection path as
  the sample wells, with the LED **on**.

That last point is what distinguishes it from dark data below, and it explains why it works as a
pivot rather than as a subtrahend: it is a *level*, a common-mode value the gain correction should
not amplify, not a *background* to be removed.

**Where the well factors themselves come from** is a separate question, and the answer is not the
reference row. They are a per-well × per-channel table stored in the run's analysis state:
a `.pcrd`'s `wellFactorsCollection` (see [`pcrd.md`](./pcrd.md)), which holds *two* independently
saved sets — `SnrWF` (signal-to-noise) and `FlyoverWF` (dynamic, measured over the actual plate)
— each gated by its own `snrSaved`/`flyovrSaved` header flag. A run with neither flag set carries
a synthesized identity table and gets no gain correction at all; that is the case for every sample
committed here, where the header records the factors as "created in Persistence loading" and every
value is exactly `1`. **A `.zpcr` archive has no equivalent file**, so a run read from one never
has a gain correction to apply, and its reference level correspondingly has no effect. Which of
the two sets should win when both are saved is an open question — see §8.

The remaining reference positions are recorded in the plate read but are not consumed by this
path. Runs also carry a **factory calibration of the full reference row** in their metadata; that
is recorded for comparison purposes, not used in the per-cycle correction. Comparing it against
the live reference readings is a useful **diagnostic of optical drift** — LED aging, detector or
filter changes since the instrument was calibrated — which is exactly what this library's
reference-calibration comparison surfaces. Be careful not to confuse that diagnostic sense of
"drift" with the analysis option of the same name (§6).

### 4.2 Dark data (LED off)

Dark data is a separate, genuinely additive background: a reading taken with the **excitation
source off**, capturing detector dark current and electronic offset — signal present regardless
of illumination. It is stored per plate read as **one record per channel, not per well** (see
[`plateread.md`](./plateread.md)'s `DARKDATA`), because the offset is a property of the detection
channel rather than of any plate position.

Because it is a true additive offset, it is handled the obvious way: **subtracted outright** from
every channel reading, after the gain correction. It is gated by its own enable flag, and skipped
entirely when a plate read carries no dark record.

The two mechanisms are complementary and should not be conflated:

| | Reference level (§4.1) | Dark data (§4.2) |
|---|---|---|
| Illumination | LED **on** | LED **off** |
| Granularity | Per channel, per scan, from a physical plate position | Per channel, per scan, no plate position |
| Captures | Optical/common-mode level through the real light path | Detector dark current + electronic offset |
| Applied as | **Pivot** for gain scaling — removed then restored | **Subtracted** outright |
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
singular values has to be scale-invariant too, or the floor is applied to numbers that are wrong
in the first place. That was the failure behind §3's normalization symptom.

### 5.1 What the reported number means

The raw solve is against `M` as §3 scaled it, so its output carries whatever units that scaling
implies — which is why the mode used to leak into the answer. Two factors turn it into a fixed,
reportable quantity:

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
low hundreds after — the right order of magnitude for an instrument RFU trace, though see §8: the
absolute scale is still not cross-validated against a reference instrument.

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
  preprocessChannelReadings,
  separateChannels,
  separateDyes,
} from "@zpcrweb/core";

// One curve per dye, from its .Dcal data (§2).
const curves = dcals.map((dcal) => buildDyeResponseCurve(dcal));

// Sample those curves at this reading's block temperature, over the scanned channels (§3).
const matrix = buildCalibrationMatrix(curves, blockTemperatureC, { channels: zpcr.channels() });

// Apply the same corrections a live reading needs (§4).
const corrected = preprocessChannelReadings(rawChannelMeans, {
  referenceLevel,
  wellFactor,
  darkLevel,
});

// Solve (§5). `concentrations` is per-dye RFU, independent of the normalization mode above.
const { dyes, concentrations, failed } = separateChannels(matrix, corrected);
```

`separateDyes(dcals, rawChannelReadings, temperatureC, options)` chains all four steps for the
common case of a one-off separation; use the individual functions instead when reusing a
calibration matrix across many wells or cycles at the same temperature, since rebuilding it per
call is wasted work.

## 8. Limitations / open items

- **The absolute RFU scale is a convention, not a verified match.** §5.1's `columnNorm` factor
  puts the output on an RFU scale that is self-consistent and the right order of magnitude, and it
  is now stable across normalization modes. But the specific choice — the L2 norm of the dye's
  response across the scanned channels — is this library's, made because it is the quantity that
  is both scale-invariant and dimensionally an RFU. A reference implementation could plausibly
  normalize on the dye's **primary channel** response alone instead; for these dyes the primary
  channel dominates the column, so the two differ by only a few percent, and no data here
  distinguishes them. Relative curve shape and Cq are unaffected either way. This is the one
  remaining item that needs cross-validation against a reference instrument's own color-separated
  output.
- **Which well-factor set applies is unresolved.** §4.1's `wellFactorsCollection` carries both an
  `SnrWF` and a `FlyoverWF` table. This library prefers `FlyoverWF` when its `flyovrSaved` flag is
  set, falling back to `SnrWF`, on the reasoning that a dynamic measurement over the actual plate
  should supersede a static one — but that ordering is inferred, not observed. Every committed
  sample has both flags clear and identity factors, so no sample exercises either path, and the
  preference is untested against real data.
- This library always derives the calibration matrix from `.Dcal` files. Some systems also
  support a user-edited override matrix that takes precedence over the calibration-derived one;
  that override mechanism isn't modeled here.
- Correctness is based on implementing the algorithm above, not on a byte-for-byte comparison
  against a reference instrument's own color-separated output — see the "Status" note at the top.
- `buildDyeResponseCurve` reads well `0` (A1) of each calibration block by default. Every file
  this library has decoded carries a uniform value across all wells in a channel (see
  [`dcal.md`](./dcal.md) §3), so this is representative in practice, but the parameter exists so
  a caller can pass a different well if that ever isn't true.
- The pseudo-inverse here is computed from the eigen-decomposition of the calibration matrix's
  Gram matrix (`Mᵀ·M`), which is mathematically equivalent to an SVD-based pseudo-inverse for
  these purposes but is a simpler implementation suited to the small (≤6×6) matrices this
  library handles — not a general-purpose numerical linear algebra routine.
