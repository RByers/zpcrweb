# Channel→Dye Color Separation

The 6 optical channels a Bio-Rad CFX instrument reads don't map one-to-one onto the dyes loaded
in a plate: every dye bleeds some fluorescence into its neighboring channels (see the worked
example in [`dcal.md`](./dcal.md) §6 — Cal Gold 540 puts 31% of its signal into channel 1, Cy5-5
puts 17% into channel 4). **Color separation** is the process of "unmixing" that cross-talk:
given the 6 raw channel readings for a well and the pure-dye calibration data for the dyes on
the plate, estimate how much each dye actually contributed.

> **Status:** implements the documented algorithm below. Implemented by
> [`packages/core/src/calibration.ts`](./packages/core/src/calibration.ts) (linear algebra in
> [`linalg.ts`](./packages/core/src/linalg.ts)), tested against the calibration data in the
> committed sample archives — see the module's tests for round-trip checks. Not yet
> cross-validated end-to-end against a reference instrument's own color-separated output, so
> treat this as "correct per the algorithm below," not "byte-for-byte verified."

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

Before use, the matrix's columns are typically **normalized** so that no single bright dye
dominates the numerics purely because of scale. Two useful modes:

- **Per-dye (column) normalization**: scale each dye's column independently to unit L2 norm —
  `scale = 1 / sqrt(Σ_channel M[channel][dye]²)`.
- **Whole-matrix (global) normalization**: compute one L2 norm across *every* entry in the
  matrix and scale everything by it. (This is the more commonly used default.)

A third mode, no normalization, is also useful for inspecting the raw calibration values
directly. Any of the three is a valid choice mathematically — normalization affects the *scale*
of the recovered concentrations, not which dye combination best explains the reading, since it's
applied uniformly and undone by the solve in §5.

## 4. Preprocessing the raw channel readings

Before a raw reading is fed into the solve, the same corrections a live instrument would apply
should be applied here too, **in this order**:

1. Start from the raw per-channel mean fluorescence for the well/cycle.
2. Apply a per-channel multiplicative correction factor, if the instrument/run provides one
   (compensates for known per-channel gain differences).
3. Subtract a per-channel black/background level.
4. Subtract a per-channel dark-current reading — an LED-off background measurement taken at scan
   time (the same shape of data a `.Plateread`'s `DARKDATA` holds; see
   [`plateread.md`](./plateread.md)).

The result is the corrected channel vector that goes into §5.

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

## 6. API summary

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

// Sample those curves at this reading's block temperature (§3).
const matrix = buildCalibrationMatrix(curves, blockTemperatureC);

// Apply the same corrections a live reading needs (§4).
const corrected = preprocessChannelReadings(rawChannelMeans, { darkCurrent });

// Solve (§5).
const { dyes, concentrations, failed } = separateChannels(matrix, corrected);
```

`separateDyes(dcals, rawChannelReadings, temperatureC, options)` chains all four steps for the
common case of a one-off separation; use the individual functions instead when reusing a
calibration matrix across many wells or cycles at the same temperature, since rebuilding it per
call is wasted work.

## 7. Limitations / open items

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
