# Biomeme run export JSON

A [Biomeme](https://biomeme.com/) handheld device (Franklin/Two3/Three9) is a genuinely
different instrument from a Bio-Rad CFX: a handful of tube positions rather than a 96-well
block, and fluorescence reported directly per fluorophore rather than per optical channel that
needs unmixing. Its app exports one run as a single JSON document. This is not a Bio-Rad
format and has no relation to `.zpcr`/`.pcrd`'s binary/ZIP/XML containers — it's documented
here, rather than reverse-engineered field-by-field the way `plateread.md`/`pcrd.md` are,
because the JSON is already self-describing (named keys, no offsets or byte layout to recover).
Implemented by `packages/core/src/biomeme.ts`, entry point `parseBiomeme(bytes)`; see
`ARCHITECTURE.md`'s "A third, non-CFX input: Biomeme" for how it fits the shared `Zpcr` shape.

## 1. Shape

```
{
  id, name, protocol, date, device, location,   // run identity/metadata
  targets: [
    {
      well,                    // wellNumber as a string, e.g. "3"
      fluorophore,              // dye name, e.g. "FAM"
      emissionColor,             // "green"/"amber"/"red" — the channel; see below
      cq,                       // reported Cq, 0-INDEXED (§2.1); or 0 meaning "did not amplify"
      threshold,                 // the threshold this cq was measured against
      endRfu,                    // end-point RFU
      rawData: [...],            // raw fluorescence, one value per cycle
      baselineData: [...],       // the device's own baseline-corrected curve — see §2
      details: {
        strip,                   // tube strip letter, e.g. "A" (informational only — see below)
        wellNumber,               // 0-based position, numbered across all strips
        sampleId,                 // groups every fluorophore tested on the same physical tube
        name,                     // target/gene name, when assigned (empty on the sample seen)
        backgroundLeft, backgroundRight,   // the baseline region, in cycle numbers
        baselineType,              // "lobf" ("line of best fit") on every target observed
      }
    },
    ...
  ]
}
```

One `targets[]` entry is one (well, fluorophore) pair — the same granularity a CFX
`WellCurve`/`CqTableEntry` is keyed at.

**It is the only input format that names its own run.** Top-level `name` (e.g.
`"2024-01-17-22220147"` — the device generates `<date>-<serial>`) becomes
`RunMetadata.experimentName`, and the app shows it rather than deriving a name from the file
name, which is what a `.zpcr`/`.pcrd` has to fall back on (`zpcrweb-json.md` §1.1). `date` is an
ISO-8601 instant and becomes `runStartDate`; `protocol` is the protocol's name, not a step list —
there is none to decode (§4). A name typed for a Biomeme run lasts the session only: the run is
one JSON document, with no archive to hold a `zpcrweb.json`.

**Wells are one row, not a grid.** A handheld device's tube positions are a single strip of
holders, not a plate — `details.strip` is a physical fact about which sub-strip a tube sits in
(informational, and unused for layout), but `parseBiomeme` places every well at row 0 and
assigns the column by rank among the run's distinct `details.wellNumber`s, in ascending order.
On the committed sample (`samples/biomeme-2024-01-17.json`, a 9-tube device) that numbering is
already global across strips (strip A holds wellNumber 0–2, B holds 3–5, C holds 6–8), so the
result is a single row of 9 columns — 3 or 6 for a device using fewer strips, an arbitrary count
driven by the data rather than a fixed shape. `Zpcr.metadata.numberPlateRows`/`PlateDefinition.
rows` are `1` accordingly, and the app's well-selection grid and plate map both suppress the
now-constant row letter for a one-row plate rather than showing an always-"A" column — see
`apps/web/ARCHITECTURE.md`'s "A third format: Biomeme". `details.sampleId` is shared by every
fluorophore tested on the same tube (well 0's three targets all carry `sampleId: "1"`), which is
how `parseBiomeme` derives one sample name (`"1"`, used verbatim) per well rather than per curve.

**Channels come from `emissionColor`, not the fluorophore name.** `WellCurve.channel` is the
device's actual optical channel: green → channel 1, amber → channel 3, red → channel 4 (0-based
internally: 0/2/3, leaving channel 2 unused — see below). On the committed sample that's FAM
(green), `TexRedX` (amber) and `ATTO-647N` (red) — but the mapping is keyed on the *color*, a
physical fact about which LED/filter pair a channel reads through, not on those particular dye
names, since an assay can rename or swap which dye occupies a given channel. `excitationColor`
is deliberately not used for this — it names the LED driving the well, not the emitted signal
being read back, which is what "channel" means everywhere else in this library. A fluorophore
whose emission color isn't one of the three known ones still gets a channel (the next index not
already claimed), so an unrecognized color degrades to "some channel" rather than failing to
load.

The indices (1/3/4, not 1/2/3) are chosen to land on the same hues a `.zpcr`/`.pcrd` run's own
channels 1/3/4 already draw as in the web app (`channelColors.ts`'s green/orange/red) — green,
orange and red are what a Biomeme run's own app calls these three channels, and the web app's
fixed six-channel palette happens to already have exactly those hues at slots 1/3/4, so
`EMISSION_CHANNELS` reuses them instead of asserting a fourth, Biomeme-only meaning for channel
2's yellow. Channel 2 is left with no fluor on a Biomeme run rather than the indices being
compacted down to 1/2/3, which would divorce a fluor's channel number from the color actually
drawn for it.

## 2. `rawData` vs `baselineData`

`baselineData` is **not** a residual or an offset — reconstructing `rawData[i] −
baselineData[i]` for every target on the committed sample recovers a straight line over
`details.backgroundLeft..backgroundRight` (confirmed by ordinary-least-squares fit: residuals
inside that region are ≤0.4 RFU on curves spanning thousands of RFU). So `baselineData` **is**
the finished baseline-corrected curve — the same quantity `subtractBaseline()`
(`baseline.ts`) produces — and `endRfu` matches its last value (or the tail mean, matching
this library's own `endPointRfu()` convention within measurement noise). `parseBiomeme`
therefore:

- carries `baselineData` verbatim as `FileAnalysis.correctedValues` (the file's own arithmetic,
  not re-derived), and
- recovers the baseline **line** itself (slope/intercept — `LinearBaselineFit`, the same shape
  `fitLinearBaseline()` returns) by fitting `rawData − baselineData` over
  `backgroundLeft..backgroundRight`, since the file states only the corrected curve and not the
  line it was corrected against.

`cq: 0` is the device's "did not amplify" sentinel (never a real Cq on any target observed) and
is normalized to `null`, matching this library's own `computeCq()` convention.

### 2.1 `cq` is 0-indexed — corrected on the way in

**The file's `cq` counts cycles from zero.** Every other cycle number in this library — and
Biomeme's own app and website, which report a Cq one higher than the file states for the same
run — counts from one. `parseBiomeme` therefore stores `cq + 1` in `FileAnalysis.cq`, and
everything downstream sees a 1-indexed Cq like every other format's. The sentinel test happens
*before* the shift, so a non-amplifying `0` still becomes `null` rather than a Cq of 1.

This is read off the file's own arithmetic rather than inferred from the field name. Interpolating
where `baselineData` crosses the target's own `threshold` — the definition of a Cq, computed
entirely from two fields of the same record — and expressing that crossing as a **0-based array
index** reproduces the stated `cq` on all 19 amplified targets of the committed sample to within
0.001 cycles. Expressed as a 1-based cycle number it is uniformly 1.000 too high. Three targets
(well 1/ATTO-647N, 4/TexRedX, 9/TexRedX) start already above threshold as their baseline decays
through it; using the *last* upward crossing matches those too, so the rule holds across all 19
without a special case.

> **Future:** whether `details.backgroundLeft`/`backgroundRight` share this 0-indexing is
> **unknown** — the sample can't distinguish it. Both readings of the window are consistent with
> §2's straight-line reconstruction to within 0.02 RFU, since shifting a 15–25-cycle baseline
> window by one cycle barely moves the fitted line. `parseBiomeme` reads them as 1-indexed cycle
> numbers; if a future sample settles it, fix them there.

## 3. Measured: agreement with this library's own algorithm

`packages/core/test/biomeme.test.ts` runs `computeCqTable()` (`threshold.md`'s pipeline,
unmodified) over the committed sample's curves and compares every result to the file's own
`cq` (as corrected by §2.1 — both sides 1-indexed, so the comparison isn't carrying a constant
one-cycle offset). The two are **independent analyses of the same raw data**, not a reproduction target the
way `cfxExport.test.ts` is for CFX — the device states no derivation for its per-curve
threshold beyond `baselineType: "lobf"`, while `computeCqTable` resolves one threshold per
*fluorophore* from the group's median baseline noise (`threshold.md` §5.2). Measured over the
sample's 27 curves:

| | |
|---|---|
| Agree on amplified-or-not | 19 / 27 |
| Both report a Cq | 15 / 27 |
| Median absolute difference (both report one) | 4.0 cycles |
| Max absolute difference | 14.5 cycles |

The divergence is large enough that neither number should be presented as "the" Cq without
saying which algorithm produced it — the motivation for the web app's file/computed toggle
(`apps/web/ARCHITECTURE.md`'s "File vs. computed analysis") rather than picking one silently.

## 4. What's absent

No `.Dcal` calibration (there is no channel mixing to calibrate against — see `dyeSpace`
above), no `.prcl`/protocol step list (only the protocol's name), no reference row, no
per-well gain factors, no raw archive to browse (`Zpcr.archive` is honestly empty, like a
`.pcrd`'s — see `pcrd.md` §1). `parseBiomeme` leaves each of these absent rather than
fabricating a plausible-looking value.
