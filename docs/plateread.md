# Bio-Rad CFX96 `.Plateread` File Format

Reverse-engineered from the `Read00001.Plateread` … `Read00045.Plateread` files produced by a
Bio-Rad CFX96 (`"96FX"` block, serial `CT019138`) real-time qPCR run
(`20260720_211747_CT019138_Luna_noRT`). One `.Plateread` file is written per plate read,
i.e. once per PCR cycle. This run had 45 reads (protocol `... PLATEREAD; GOTO 2,44`).

> **Status:** fully decoded. The file is **self-describing**: a trailing **descriptor
> dictionary** (§4) lists every field's absolute offset, byte length, and type. The dictionary's
> container format — "ICFF" — is not specific to `.Plateread`; it's documented on its own in
> [`icff.md`](./icff.md) and implemented by `packages/core/src/icff.ts`. Using it, all
> scalar-header fields, strings, and the WELLDATA/DARKDATA arrays decode exactly — no offsets
> need to be hardcoded.

**Endianness is mixed.** The metadata — version words, the scalar header, and the descriptor
dictionary — is **big-endian**. The **WELLDATA and DARKDATA float arrays are little-endian**
(they read as native DSP output), **and so is the `uint32` count word that introduces each
array** (`0x1A4` for WELLDATA, `0x2A28` for DARKDATA) — it belongs to the little-endian array,
not the surrounding big-endian metadata. Fluorescence and temperature values are IEEE-754
32-bit floats; counters/lengths are int32.

> The original reverse-engineering assumed all-little-endian and read the scalar header at
> approximate misaligned offsets — which made e.g. block temperature come out as ~98 °C. Reading
> the descriptor-declared offsets **big-endian** instead gives the correct **60 °C** (the plate
> read happens at the 60 °C step), and every other scalar then matches `RunInfo.xml`/the protocol.
>
> **Erratum (found while cross-validating against the matching `.pcrd` — see `pcrd.md` §3.1):**
> the WELLDATA/DARKDATA count word itself is little-endian too. Reading it big-endian gives
> `2592` as `537526272`; reading it correctly gives `2592`, matching the `.pcrd`'s `PAr` element
> count (2592 = 648 × 4) for the same run.

---

## 1. High-level layout

Every file is exactly **22037 bytes**. The size is fixed because the well grid is fixed
(6 channels × 108 wells). Regions (offsets from the confirmed sample above; the header is
variable-length in principle but constant across this run):

| Region | Offset | Contents |
|--------|--------|----------|
| Magic / version | `0x000` | `00 00 00 01  00 00 00 02  00 00 00 00` (big-endian-looking version words) |
| ASCII strings block | `0x00C` | Base serial, shuttle serial, head serial, and a firmware-version banner, each NUL-terminated |
| Scalar metadata | `0x11C` | Step id, scan index, **cycle number**, temperatures, LED currents, timestamp (see §3) |
| **`WELLDATA`** | `0x1A4` | `uint32` float-count (`2592`, **little-endian**) then 648 records × 4 floats — **the fluorescence table** (§2) |
| **`DARKDATA`** | `0x2A28` | `uint32` float-count (`24`, **little-endian**) then 6 records × 4 floats — dark/background reading per channel |
| `FILEPATH` | `0x2A8C` | ASCII `\Storage Card\CurrentRun\Read0004N.xlateread` |
| Descriptor dictionary | `0x2AB0` | ICFF index: field-name table + descriptors mapping names → data (§4, [`icff.md`](./icff.md)) |
| ICFF footer | end (last 8 bytes) | `[index_offset][entry_stride]`, both u32 LE — points back at the dictionary |

Array fields are framed as **`[uint32 count_of_floats][float32 × count]`**, both little-endian.
The descriptor for each array (in the dictionary) stores the data offset relative to base
`0x1A4` (`WELLDATA` → +4 = `0x1A8`; `DARKDATA` → +0x2884 = `0x2A28`).

---

## 2. WELLDATA — the fluorescence table (the important part)

Located at file offset **`0x1A8`** (immediately after its `int32` count `2592` at `0x1A4`).

### Record structure — 16 bytes, 4 × float32

Each well/channel reading is a **16-byte record of four floats**:

| Float | Meaning |
|-------|---------|
| 0 | **mean** fluorescence (the primary value; this is what forms the amplification curve) |
| 1 | **std dev** (small, typically 4–60) |
| 2 | **min** raw sample |
| 3 | **max** raw sample |

This is the same 4-tuple used by the `FactoryRefRowCal` field in `RunInfo.xml`
(there ordered mean, min, max, std).

### Grid dimensions — 648 records = 6 channels × 108 wells

```
record_index = channel * 108 + row * 12 + col
data_offset  = 0x1A8 + 16 * record_index
```

The decoder reshapes this flat, channel-major array into the nested
`PlateRead.wells[channel][row][col]` table (`buildWellTable` in `plateread.ts`); the flat
indexing above describes the bytes on disk, not the API.

- **6 channels**, index 0–5 (the run's `ScanMask = 63` = `0b111111` = all 6 optical channels).
- **108 wells per channel**, laid out **row-major**: `well = row*12 + col`.
  - `col` = 0–11  → plate columns 1–12
  - `row` = 0–8  → **9 rows**: 0–7 are plate rows **A–H**, and **row 8 is the reference row**
    (`NumberReferenceRows = 1` in `RunInfo.xml`). The reference row holds real optical readings
    and is stored inline just like the sample rows.

Ordering was confirmed empirically: under row-major, **every** well whose signal changed between
read 1 and read 45 lands in **column 3, rows A–D** — exactly the loaded wells 3A/3B/3C/3D.
Column-major scatters them, so row-major is correct.

### Verification — amplification curves

Well 3A = `row 0, col 2`. Channel-2 mean fluorescence across the run shows a textbook qPCR
sigmoid; the channel-0 negative stays flat:

```
Cycle | ch0 3A | ch2 3A | ch2 3B | ch2 3D
    1 |  3212  |  4289  |  4208  |  4099
   10 |  3268  |  4442  |  4277  |  4134
   30 |  3276  |  4516  |  4349  |  4202
   35 |  3278  |  4653  |  4497  |  4284   <- exponential phase begins
   40 |  3284  |  6008  |  5737  |  5489
   45 |  3290  |  6852  |  6515  |  6315   <- plateau
```

Wells outside 3A–3D and channels other than the amplifying ones stay near their baseline
(≈1900–4300 depending on well/channel), matching the expectation that most of the plate is
empty/flat.

---

## 3. Scalar metadata header (`0x000`–`0x1A3`)

Everything up to WELLDATA is described by the descriptor dictionary (§4): each field's exact
offset and length come from the file itself, and **the values are big-endian**. The header is
byte-packed (variable-length strings shift later fields off 4-byte alignment), which is why it
looked misaligned until read via the descriptors.

The three big-endian words at `0x000` are the version/magic: `1, 2, 0`
(`ICFFPRFILEVERSION`-ish / `PLATEREADVERSION` = 2 / `CRC` = 0).

Decoded values for Read45 (offset from the descriptor dictionary; BE int / BE float):

| Field | Offset | Len | Value | Notes |
|-------|--------|-----|-------|-------|
| `PLATEREADVERSION` | `0x04` | 4 | 2 | |
| `RUNGUID` | `0x0C` | 9 | `CT019138` | string |
| `ALPHASERIALNUMBER` | `0x15` | 8 | `SG16130` | (shuttle) |
| `BASESERIALNUMBER` | `0x1D` | 9 | `CT019138` | |
| `HEADSERIALNUMBER` | `0x26` | 11 | `785BR13647` | (ORM) |
| `FIRMWAREVERSIONS` | `0x31` | 227 | `PXA270 - '0001', …` | banner string |
| `RETRIEVALTYPE` | `0x119` | 4 | 3 | |
| `SCANINDEX` | `0x11D` | 4 | 45 | |
| `CYCLE` | `0x129` | 4 | **45** | tracks 1→45 across the series |
| `BLOCKTEMP` | `0x132` | 4 | **59.99 °C** | float — the 60 °C plate-read step |
| `AMBIENTTEMP` | `0x136` | 4 | 32.0 °C | |
| `SHUTTLETEMP` | `0x13A` | 4 | 45.08 °C | matches `ShuttleTargetTemperature=45` |
| `SAMPLETEMP` | `0x13E` | 4 | 60.0 °C | |
| `LIDTEMP` | `0x142` | 4 | 105.1 °C | matches `HOTLID 105` |
| `LEDCURRENT01..06` | `0x146`+4·n | 4 | 92,97,76,123,185,161 | = `LEDDACValsCal` |
| `CHANNELMASK` | `0x176` | 4 | 63 | = `ScanMask` (6 channels) |
| `NUMBERCOLUMNS` | `0x17A` | 4 | 12 | |
| `NUMBERROWS` | `0x17E` | 4 | **9** | 8 sample rows + 1 reference row |
| `DATETIME` | `0x182` | 30 | `Tue, 21 Jul 2026 06:22:23 GMT` | NUL-terminated string |
| `DELTATIME` | `0x1A0` | 4 | 0 | |

`STEP` and `STEPIDENTIFICATION` both point at `0x121` (they alias the same 4 bytes).

### Temperatures

Five **measured** temperatures (big-endian float32 °C) and two **set points** (big-endian
int32 °C) are all the file carries:

| Field | Kind | Read45 | Cross-check |
|-------|------|--------|-------------|
| `BLOCKTEMP` | measured | 59.99 | the protocol's 60 °C plate-read step |
| `AMBIENTTEMP` | measured | 32.00 | — |
| `SHUTTLETEMP` | measured | 45.08 | `ShuttleTargetTemperature=45` in `RunInfo.xml` |
| `SAMPLETEMP` | measured | 60.00 | block target |
| `LIDTEMP` | measured | 105.10 | `HOTLID 105` |
| `FANOFFTEMP` | set point | 35 | `FanControlOffTemperature=35` |
| `FANONTEMP` | set point | 40 | `FanControlOnTemperature=40` |

The two kinds share a type tag (1) and are distinguished only by plausibility: an int set
point like `35` reinterpreted as float32 is a denormal (~4.9e-44), and a measured `59.99`
reinterpreted as int32 is in the billions, so at most one reading ever lands in a sane
temperature range. `temps.ts` extracts **any** field whose name contains `TEMP`, so a
firmware emitting more needs no decoder change.

**There are no per-row or per-zone block temperatures**, and the decoder has no notion of them.
The CFX96 reports one block temperature for the whole block; every byte of the file is accounted
for by the dictionary (§4), and neither the `.alf` run log, `runlog.xml`, nor `RunInfo.xml`
carries per-row values either. Every sample archive — a 2019 qualification run, a 2026
amplification run, and a **gradient** run holding rows A–H at 55–65 °C
(`samples/20260725_GRADIENTTEST.zpcr` and the matching `gradient-test-empty.pcrd`), all
`PLATEREADVERSION 2` — has exactly the same 42 dictionary fields with the same seven
whole-block temperatures. The gradient's span survives only as the protocol's `GRAD
55.0,65.0,30` step (`GradientStep`, `prcl.md` §5), never as measured per-row data; the `.pcrd`'s
XML likewise has no per-row temperature element. A gradient run is the strongest possible test
case for such a field, so this is treated as settled rather than merely unobserved —
`temps.test.ts` guards it.

### LED currents

Six **LED drive currents** (big-endian int32), `LEDCURRENT01`…`LEDCURRENT06`, one per optical
channel: the calibrated DAC setting the instrument drives each excitation LED at. They match
`RunInfo.xml`'s `LEDDACValsCal` exactly — `92,97,76,123,185,161` in every sample archive here
(same instrument) — and are constant across every read of a run: they are calibration settings,
not measurements, so a step in one would mean the instrument re-drove that LED mid-run.

The values are **DAC counts, not milliamps**: nothing in the archive gives the DAC→current
transfer function, so no unit conversion is applied. `leds.ts` extracts **any** field whose name
starts with `LEDCURRENT`, with the trailing 1-based number as the channel link, so a firmware
emitting a different channel count needs no decoder change (mirroring `temps.ts`).

---

## 4. Descriptor dictionary (`0x2AB9`–end) — the authoritative schema

The tail of the file, immediately after the FILEPATH string, is an **ICFF** index — a small,
hand-rolled container format Bio-Rad reuses for other file types too. The full container layout
(footer, index-entry structure, endianness rules) is documented separately in
[`icff.md`](./icff.md) and implemented by `packages/core/src/icff.ts`; this section covers only
what's specific to `.Plateread`'s use of it.

Field names appear in this order (`PRFILEVERSION, PLATEREADVERSION, CRC, RUNGUID,
ALPHASERIALNUMBER, BASESERIALNUMBER, HEADSERIALNUMBER, FIRMWAREVERSIONS, SHUTTLEPARAM,
SCANMODE, RETRIEVALTYPE, SCANINDEX, STEPIDENTIFICATION, STEP, CYCLE, ERRORNUMBER,
ERRORDESCRIPTION, BLOCKTEMP, AMBIENTTEMP, SHUTTLETEMP, SAMPLETEMP, LIDTEMP, LEDCURRENT01..06,
FANSTATE, FANOFFTEMP, FANONTEMP, LIDSTATE, LIDFORCE, LIDPOSITION, CHANNELMASK, NUMBERCOLUMNS,
NUMBERROWS, DATETIME, DELTATIME, WELLDATA, DARKDATA, FILEPATH`) — 42 entries in both sample
archives.

> The first field's real name is `PRFILEVERSION`. An earlier version of this decoder located the
> index by scanning for the literal string `ICFFPRFILEVERSION` starting at `0x0100`, which
> happened to work only because the `ICFF` magic sits immediately before that field's name in
> the file — the magic bytes are not part of the name. See [`icff.md`](./icff.md) for why the
> footer-based approach is the correct, general one.

The **offsets are absolute and exact**, verified against the data:

- `WELLDATA` → offset `0x1A4`, length `10372` (= 4-byte count + 648×16 data). Float data at
  `0x1A8`.
- `DARKDATA` → offset `0x2A28`, length `100` (= count + 6×16). Float data at `0x2A2C`.
- `FILEPATH` → offset `0x2A8C`, length `45`.
- `DATETIME`, the serials, and every scalar likewise point at their exact bytes.

So the index can drive decoding directly, with no hardcoded offsets. Array entries point at the
little-endian `uint32` count; the little-endian float payload starts 4 bytes later.

---

## 5. Quick-start decoder (Python)

```python
import struct

def read_plateread(path):
    d = open(path, 'rb').read()
    START, STRIDE = 0x1A8, 16          # WELLDATA float array
    def rec(ch, row, col):             # row 0-7 = A-H, row 8 = reference row
        i = ch * 108 + row * 12 + col  # col 0-11 = plate columns 1-12
        mean, std, mn, mx = struct.unpack_from('<4f', d, START + STRIDE * i)
        return mean                    # mean fluorescence
    return rec

# Example: well 3A (row A=0, col 3 -> index 2) on channel 2
rec = read_plateread('Read00045.Plateread')
print(rec(2, 0, 2))   # -> ~6852
```

## 6. Open items / caveats

- **Per-row temperatures do not exist** in any sample, including a gradient run — see §3. This is
  closed, not open: nothing in the library models them. Should a different block type ever emit
  one, the name-based extraction still surfaces it as an ordinary temperature series.
- **Channel → dye mapping** is not in the `.Plateread` payload; channels are stored in scan order
  0–5. The run's calibration (`.Dcal`) files list the dye set. In this data the amplifying dye is
  channel index 2 (Texas Red in the CFX 5-dye layout). Channel index 5 is a real sixth optical
  channel (FRET) — not dark/reference data.
- **Scalar offsets and endianness are now resolved** (§3/§4): every field is read at its
  descriptor-declared offset, big-endian. The temperatures, LED currents, and states all match
  `RunInfo.xml`/the protocol.
- `type` is `1` for every descriptor in the observed files; its full meaning is unconfirmed, so
  the decoder treats length (4 → scalar, else string/array) rather than the type tag.
- `DARKDATA` (6 records, one per channel) is the LED-off/background reading used for baseline
  subtraction; same 4-float record layout as `WELLDATA`. **Both arrays are little-endian**, unlike
  the big-endian metadata.

## DARKDATA vs. the reference row

The reference row (row 8; see `pivot.ts`'s `REFERENCE_ROW`) and `DARKDATA` are easy to confuse,
since both look like "background". Measured against each other across every committed sample —
6 archives, 2 instruments, 2019–2026, 9 plate-read steps — the relationship is consistent, and
it is what the web app's Reference view "Show dark" overlay puts on screen:

- **Dark sits below *every* reference column, always.** Without exception: in each of the 9
  steps, for each of the 6 channels, `mean(dark) < mean(R1…R12)`. Dark never crosses into the
  reference row's range.
- **R1 is at or within a few RFU of the reference row's floor.** 7–8 of the 12 columns cluster
  within 50 RFU of each other at the bottom (the rest hold progressively brighter reference
  material, up to ~44,000 RFU), so which of them is nominally lowest is often decided by ~1 RFU.
  R1 is the exact minimum in most channels; the exceptions are ch 1 and ch 5 on the 2026
  instrument, where R1 runs 1–13 RFU above the darkest column (R4/R5/R9). **Ch 4 is the one
  channel where R1 is genuinely distinguished:** there the floor cluster is R1 *alone*, with the
  next column ~120 RFU above it.
- **The dark→floor offset is per-channel, and stable to a few RFU across runs years apart** on
  the same instrument — it is a fixed optical property, not noise. It does differ between
  instruments, so it is not a constant of the format.

  | Channel | R1 − dark, CT019138 (2019, 2023) | R1 − dark, 2026 instrument (3 runs) |
  |---|---|---|
  | 0 | 96–100 | 127–133 |
  | 1 | 6.6–7.0 | 9.4–11.8 |
  | 2 | 29.6–30.0 | 32.7–36.7 |
  | 3 | 28.8–29.4 | 31.7–32.2 |
  | 4 | 199–204 | 212–215 |
  | 5 | 27.2–28.4 | 47.7–51.2 |

  As a fraction that is 0.3 % (ch 1) to 10 % (ch 4) of R1 — so dark accounts for **90–99.7 % of
  R1's reading**, but the remainder is a real, channel-specific optical signal, not a rounding
  difference. Ch 4 is the outlier at both ends: the largest offset, and the noisiest dark trace
  (σ ≈ 4–6 RFU per cycle, vs. ≈ 2 for every other channel).
- **They do not track each other cycle to cycle.** Pearson correlation between the dark and R1
  series over a run is ≈ 0 (|r| < 0.35 in every channel of every multi-cycle sample, sign
  varying). Both are flat to ~2 RFU σ over 40–61 cycles, so there is no shared drift to correlate
  — they are independent measurements at a nearly constant level, and neither can substitute for
  the other as a per-cycle background estimate.
- **Caveat:** the oldest sample (`20190516_…SHORT_QUALIF.zpcr`) records the reference row for
  channel 0 only — every other channel's reference wells read exactly 0, so it contributes one
  channel to the above. Its ch-0 offset (96 RFU) does line up with the 2023 run on the same
  instrument.

The upshot: `DARKDATA` is the instrument's floor with the LEDs off, and the dim end of the
reference row is that floor *plus* a small fixed per-channel optical contribution. Neither is
derived from the other in the file, and R1 is not a stored copy of the dark reading.
