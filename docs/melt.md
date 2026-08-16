# Melt curves — detection, the derivative, and the melting temperature

## 1. What a melt answers, and why the answer isn't the curve

Amplification tells you *whether* a target was there and *how much* — the Cq of
[`threshold.md`](./threshold.md). It cannot tell you **what** was amplified. Two different products
of the same length amplify identically, and a primer-dimer amplifies beautifully while containing
none of the sequence anyone cares about.

A **melt curve** answers that second question. After amplification the block is ramped slowly
upward, reading the plate every fraction of a degree. Double-stranded product holds the
intercalating dye and fluoresces; as the temperature passes the point where the product comes
apart, the dye is released and fluorescence falls. The temperature at which that happens — the
**melting temperature**, Tm — is a property of the product's sequence and length, so it identifies
it. One product gives one transition; a reaction contaminated with primer-dimer gives two.

The complication, and the reason this document exists, is that **the transition is nearly invisible
on the curve itself**. Fluorescence falls across the whole ramp whether or not anything is melting,
because dyes are less bright when hot (§7 quantifies this: some lose a third of their signal
between 60 and 80 °C). What distinguishes melting is not that the curve falls but that it falls
*fastest* at one particular temperature. So the plot everyone actually reads is the **negative
first derivative**, −dF/dT, on which a melting product is a peak, and the Tm is that peak's
position. Everything below is in service of getting that peak's temperature right.

None of this run through the amplification pipeline. A melt has no cycles, no baseline region in
`threshold.md` §3's sense (the curve is sloping from its first point), and no threshold to cross.
Implemented by `packages/core/src/melt.ts` (detection, §2–§3) and
`packages/core/src/meltAnalysis.ts` (the rest), entry points `computeMeltAnalysis()` for the
channel-space form and `meltCurvesFromFluor()` for the colour-separated one (§7).

## 2. Recognizing a melt

**A melt is a plate-read step whose reads sweep temperature.** That is the whole rule, it is read
from the data, and it needs nothing else — `meltSegments(zpcr)` returns one `MeltSegment` per melt
step, empty for an ordinary run.

A step qualifies when all of the following hold of its reads' temperatures:

| Test | Constant | Measured on the committed run (§A.1) |
|---|---|---|
| enough reads to have a shape | `MELT_MIN_POINTS` = 8 | melt 61, amplification 40 |
| never goes backwards (beyond noise) | 0.2 °C tolerance | melt strictly increasing |
| total span | `MELT_MIN_SPAN_C` = **5 °C** | melt **29.88 °C**, amplification **0.01 °C** |
| median step between reads | `MELT_MIN_INCREMENT_C` = 0.05 °C | melt **0.500 °C**, amplification **0.000 °C** |

The span test is the one that does the work, and the margin is why it needs no tuning: the two
steps of the same run are three orders of magnitude apart, so any constant between them separates
them.

> **Deliberately not used: the protocol.** [`protocol.md`](./protocol.md) §6 describes the melt
> idiom — a `GOTO` loop whose body climbs, recognizable by its 31-second equilibration hold — and a
> `.prcl` states a `MeltCurveStep` outright. Neither is the detector here. The `.prcl` is encrypted
> and usually unavailable (it is on the one committed melt run), no stored protocol in this project
> contains the compact `MELT` directive, and matching the long form to the reads it produced needs
> a mapping that §2.1 shows is not the identity. The reads say it directly; the protocol is
> corroboration.

### 2.1 The `STEP` field is not the protocol's step number

A `.Plateread`'s `STEP` (`plateread.md` §3) numbers something different from
`protocol.md` §4's step list, and the two must never be joined. **Measured** on the committed run:

| | Protocol / `.alf` step | `.Plateread` `STEP` |
|---|---|---|
| amplification read | 5 | 3 |
| melt read | 9 | 5 |

The consistent reading is that `STEP` is a 0-based index counting only `TEMP`/`GRAD` steps — the
temperature step a read attaches to — but this project has one file to infer that from, so it is
recorded here as an observation and nothing depends on it. `MeltSegment.step` is the `STEP` value,
because that is what `Zpcr.curves({ step })` filters on.

## 3. The temperature axis

Each read carries several temperatures (`plateread.md` §3). Two can serve as a melt's x axis, and
they are tried in this order:

1. **`SAMPLETEMP`** — the calculated sample temperature, which under `METHOD CALC` is what the
   protocol controls. **Measured**: on the committed run it is an exact uniform grid, 65.0 → 95.0
   in 0.5 °C steps with no other spacing present, matching the protocol's programmed
   `TEMP 65.0,5; INC 0.5` exactly. Preferred because a melt is *programmed* in this quantity and
   because a uniform grid is what makes §4's smoothing exact.
2. **`BLOCKTEMP`** — the block's own measured temperature, the fallback for a run whose reads carry
   no sample temperature. Real but noisier and unevenly spaced (measured: 64.98, 65.34, 65.83, …
   where `SAMPLETEMP` reads 65.0, 65.5, 66.0).

`MeltSegment.source` records which was used. A source that states its axis outright rather than
through per-read headers reports `"file"` — see §6.

The axis reaches ordinary curve data through `WellCurve.temperaturesC`, which `toCurves` fills for
every curve whenever the reads carry a temperature. That field is *not* a melt judgement — it is
simply the temperature each point was read at — which is what keeps the melt rules out of the
pivot.

## 4. Smoothing, then the derivative

`meltDerivative(temperaturesC, values)` returns −dF/dT per °C, in two stages.

**Smooth first.** A derivative is a difference of neighbouring readings, which multiplies their
noise; differentiating raw data gives a spiky curve whose highest point is the loudest pair of
samples rather than the melting product. The filter is a **Savitzky–Golay quadratic over a 5-point
window** (`savitzkyGolay5`) — quadratic rather than a plain moving average because an average
flattens peaks, and a peak's height and position are the entire result here. The two points at each
end keep their original values (a truncated window would bias them) and §5 excludes them anyway.

**Then difference.**

```
derivative[i] = −(smoothed[i+1] − smoothed[i−1]) / (T[i+1] − T[i−1])
```

Negated so a melting product — falling fluorescence — reads as a positive peak, which is the
convention every melt plot uses. Dividing by the *actual* temperature span rather than an assumed
increment keeps the result a true per-°C rate on the unevenly spaced `BLOCKTEMP` fallback of §3.
The smoothing is in index space, exact on a uniform grid and an approximation otherwise.

## 5. The melting temperature

`meltPeak(temperaturesC, derivative)` finds the derivative's highest interior point and refines it.

- **The ends are excluded** — two points at each end (`PEAK_EDGE_EXCLUDE`). This is where the
  smoothing window is truncated and the ramp is still settling, and it is exactly where spurious
  calls land: unguarded, flat wells on the committed CFX run pile up at the 95 °C edge, and the
  Biomeme device reports its own first grid point, 60.5 °C, for several signal-free wells.
- **One peak is called**, the tallest. A melt often has more than one — a primer-dimer peak sits
  below the product's — and every peak stays visible on the plotted derivative, but only the
  tallest gets a number. *(Future: calling secondary peaks by prominence.)*
- **The peak is refined below the grid** by fitting a parabola through the winning point and its
  two neighbours and taking its vertex. Worth doing because the grid is coarse next to the
  precision the number is read at: a 0.5 °C rung against replicate spreads of 0.12 °C (§A.2).
  The vertex is **clamped to half a grid step** — the parabola refines a maximum already located,
  so its vertex belongs between that sample's neighbours. Unclamped, a fit through a near-flat trio
  solves far outside the data; it put melting temperatures at 38 °C on a ramp starting at 65 (§B.2).

### 5.1 When no Tm is reported

Every curve has a highest point, so without a gate every empty well is handed a confident melting
temperature. The gate is on the **curve**, not on the peak: what makes a peak real is that the
fluorescence it describes actually fell.

`hasMeltSignal(values)` requires the curve's total span to be at least
`MELT_MIN_SIGNAL_FRACTION` = **3%** of the curve's own median level. Expressing it as a fraction of
the well's own reading is what lets one constant serve instruments whose readings differ by an
order of magnitude. **Measured** (§A.3): curves carrying real product score 0.060 – 1.98, curves on
dark channels or empty wells score 0.0008 – 0.017 — a factor of two of margin either way.

A signal-to-noise test was tried first and **does not work**; see §B.1.

## 6. One derivative, whoever computed it

A Biomeme melt export ([`biomeme.md`](./biomeme.md) §5) already contains its derivative. Rather
than making that a second kind of melt curve, the format difference is absorbed at the parser:
`biomeme.ts` converts the file's −ΔF *per temperature step* into the per-°C rate everything else
means and puts it on `WellCurve.meltDerivativePerC`; `computeMeltAnalysis` uses that array where it
is present and calls §4 where it isn't.

Everything downstream sees one `MeltCurve.derivative` and one `tmC`, computed by the same §5 for
both instruments. There is deliberately **no** file-versus-computed toggle of the kind
`threshold.md` §5.3's baseline and Cq have. That toggle exists because the file's answer and this
library's genuinely disagree and the operator has to choose; here the file supplies an *input* to
one shared computation, not a competing answer. `MeltAnalysis.derivativeSource` reports which
happened, for display, and forks nothing.

The device's own called peak is parsed and shown in the decoded view — nothing a file contains is
dropped — but drives nothing. It agrees with §5 to within 0.2 °C on every well where the signal is
unambiguous (§A.4).

## 7. The two spaces a melt is read in

A melt is derived twice, from the same reads, and which one is on screen is the Curves view's own
View toggle — the same Channel / Fluorophore / Target / Table control an amplification step gets.

**Channel space** (`computeMeltAnalysis`) is one curve per optical channel, unmixed by nothing. It
is the form that always works: it needs no plate definition and no password, which the committed
melt run requires, its plate being encrypted. It is also where the number quoted in Appendix A was
first measured.

**Dye space** (`meltCurvesFromFluor`) is one curve per well and fluorophore, after the channel→dye
colour separation of [`calibration.md`](./calibration.md). The caller supplies the separated curves
rather than this recomputing them, because the app already holds them:
`computeRunAnalysis(zpcr, …, meltStep).allFluorCurves` *is* the melt step's separation. A dye-space
source (Biomeme) arrives per-dye already and needs no unmixing at all, so it reaches the same place
by a shorter route.

The separation is what makes the ramp tractable. A dye's response is a function of block
temperature, and a melt sweeps 30 °C of it, so the matrix is sampled at **each read's own
`BLOCKTEMP`** rather than once for the step — `calibration.md` §2.1, which is also where the cost
of doing that is accounted for. Above 80 °C, where the `.Dcal` knots stop, the response is
extrapolated from the last calibrated segment and floored at zero.

Two consequences worth stating plainly:

- **The Tm does not move.** On the committed run — one dye, SYBR, on one channel — the separation
  is close to a rescaling, and the 54 curves carrying real product report the same peak in both
  spaces to within 0.5 °C, median shift 0.000 °C (§A.5). Where the two disagree at all is on five
  flat wells whose derivative peaks at 10–13 RFU/°C against the product's 100–5900, i.e. wells with
  no melting transition to locate.
- **Thermal quenching is still visible on the plotted curve.** Fluorescence falls with temperature
  whether or not anything is melting — **measured** from the committed calibration set, between 60
  and 80 °C FAM's response falls 18% and Cy5's 38% — and a separated value is deliberately reported
  on an RFU scale (`calibration.md` §5.1), which carries that fall back into the number. What the
  per-read matrix corrects is the *unmixing*: which share of a channel's reading belongs to which
  dye, whose proportions do change across a ramp (§A.5 measures the rotation). Dividing the
  quenching out as well would mean reporting a melt on a different scale from every other curve in
  the app, and is not done.

## 8. Future work

> **Genuinely unknown:** how the Biomeme device chooses its own peak. Its value is the argmax of its
> stored derivative on wells with signal, but not on flat ones, so there is peak-selection logic
> (edge exclusion, prominence, or both) that this project has not recovered. It does not matter,
> since that value is not used.

Not implemented and not planned: multiple called peaks per curve (§5), melt-curve *shape*
comparison (high-resolution melting genotyping), and any use of the `.prcl`'s `MeltCurveStep`.

---

## Appendix A — Measurements

All from the committed samples, using the shipped code.

### A.1 Detection (`samples/20230829_135443_CT019138_SINGLE_STEP_.zpcr`)

Protocol text, verbatim — note it contains no `MELT` directive; the melt is the long form of
`protocol.md` §6, and the `.prcl` beside it is encrypted:

```
METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 50.0,600;TEMP 95.0,60;TEMP 95.0,10;TEMP 60.0,30;
PLATEREAD #h3F;GOTO 3,39;TEMP 65.0,31;TEMP 65.0,5;INC 0.5;RATE 0.5;PLATEREAD #h3F;GOTO 8,60;END
```

| `STEP` | reads | first °C | last °C | span | monotonic | median Δ | melt? |
|---|---|---|---|---|---|---|---|
| 3 | 40 | 59.99 | 59.98 | **0.01** | no | **0.000** | no |
| 5 | 61 | 64.98 | 94.86 | **29.88** | yes | **0.500** | **yes** |

(°C above are `BLOCKTEMP`; `SAMPLETEMP`, which is the axis actually used, reads exactly 65.0 → 95.0
in 0.5 °C steps.)

### A.2 Tm reproducibility

Of the 576 curves on the melt step, 27 channel-0 curves have a peak taller than 3000 RFU/°C — one
product across replicate wells:

```
85.55 85.56 85.57 85.58 85.58 85.58 85.60 85.60 85.60 85.60 85.60 85.60 85.60 85.60
85.60 85.61 85.61 85.61 85.61 85.61 85.62 85.62 85.62 85.64 85.64 85.66 85.67
```

**Spread 0.120 °C**, median 85.60 °C. Six further curves are called between 76.07 and 83.82 °C —
genuinely different products, not scatter. Channels 3 and 4, which carry no signal, are called
**zero** times.

### A.3 The signal gate (§5.1), both runs

| Population | n | span / level |
|---|---|---|
| CFX ch0, real product | 33 | 1.06 – 1.98 |
| CFX ch5, real product | 33 | 0.69 – 1.04 |
| Biomeme FAM, real product | 4 | 0.14 – 0.20 |
| CFX ch0, weak wells | 41 | 0.060 – 0.219 |
| CFX ch3 (dark channel) | 96 | 0.0031 – 0.0091 |
| CFX ch4 (dark channel) | 96 | 0.0029 – 0.0151 |
| Biomeme flat wells | 19 | 0.0008 – 0.0169 |

The constant is 0.03.

### A.4 Against the Biomeme device's own peak

Wells clearing §5.1's gate, file value against this library's:

| Well / dye | file `peak` | computed Tm |
|---|---|---|
| FAM well 0 | 79.5 | 79.58 |
| FAM well 3 | 81 | 80.81 |
| FAM well 1 | 89 | 89.09 |
| FAM well 2 | 79 | 78.79 |

Worst disagreement 0.21 °C, under half the file's own 0.5 °C grid step.

### A.5 Channel space against dye space (§7)

The same melt run, derived both ways — channel 0 raw, and SYBR after colour separation with a
matrix per read (`calibration.md` §2.1). 96 wells, one dye:

| Cohort | n | Tm agreement |
|---|---|---|
| peak > 100 RFU/°C (real product) | 54 | all within 0.5 °C; **median shift 0.000 °C** |
| all called wells | 96 | 91 within 0.5 °C |
| the five that disagree | 5 | peaks of 10.2 – 13.4 RFU/°C, three tallest derivative points within 1% of each other |

The five are flat wells that squeaked past §5.1's gate; on those, reordering the top of a
featureless derivative is not a Tm changing but noise being noise. The plateau below the transition
(65 → 75 °C) drifts −18.1% raw and −17.7% separated, which is §7's second point measured: the
reported RFU scale carries the quenching back in on purpose.

What the per-read matrix does change is the unmixing, which only a multi-dye plate can show. On
`samples/20260726_S183-S185_RVP.zpcr` (FAM / Tex 615 / Cy5, six channels), sampling the same
calibration at 65 °C and at 95 °C:

| Dye | channel-3 response, 65 °C → 95 °C | rotation of its unmixing direction |
|---|---|---|
| FAM | — | 3.72° |
| Tex 615 | — | 2.05° |
| Cy5 | 0.3549 → 0.1499 (−58%) | 1.68° |

A single matrix for the whole ramp applies the 65 °C proportions to a 95 °C reading; a per-read
matrix does not.

## Appendix B — What didn't work

### B.1 A signal-to-noise gate

The obvious gate for §5.1 is the one `threshold.md` §5.2 uses for amplification: estimate the
curve's noise and require the peak to stand some multiple of it clear. It was implemented first and
**does not separate the populations at all**:

| Population | peak height / noise |
|---|---|
| CFX ch0 real product | 4.8 – 109 |
| Biomeme real product | 1.7 – 6.6 |
| CFX dark channels | 1.3 – 7.3 |
| Biomeme flat wells | 1.2 – 4.0 |

The reason is that **a flat curve is also a smooth one**. The noise estimator — a median absolute
difference between neighbours — collapses toward zero on a well with nothing happening in it, so
its meaningless highest point divides by almost nothing and scores as highly significant. A Biomeme
well spanning 10 RFU on a level of 8800 scored 23.7 σ. Topographic prominence as a fraction of peak
height was tried too and separates no better (real 0.80 – 0.99, junk −2.19 – 2.77). What actually
distinguishes a melt is not that its peak is sharp but that its fluorescence *moved*, which is what
§5.1 measures.

### B.2 An unclamped parabolic vertex

The sub-grid refinement of §5 originally used the parabola's vertex as computed. On real data this
produced melting temperatures of 38.37 °C on a ramp spanning 65 – 95 °C, and 52.94 °C on one
spanning 60 – 95 °C. The cause: at the edge of the search window the trio the parabola is fitted
through is often still rising or nearly flat, and its vertex then solves to a point far outside the
three samples it was fitted to. Clamping the offset to half a grid step fixes it, and is what the
refinement always meant — it adjusts *within* a maximum already located.

### B.3 Running the amplification pipeline over a melt step

Before this existed, selecting the melt step in the Curves view plotted its 61 reads as 61 cycles
and ran baseline, threshold and Cq over them. Every number that came out was meaningless: the
"baseline" was a line fitted to the top of a melting transition, and the "Cq" was the cycle index
at which a falling curve crossed a threshold derived from its own slope. The Biomeme melt export
was worse — its zeroed `cq`/`threshold`/background fields produced a one-point baseline region, and
its derivative was displayed as though it were a baseline-corrected amplification curve.
