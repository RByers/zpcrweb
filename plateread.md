# Bio-Rad CFX96 `.Plateread` File Format

Reverse-engineered from the `Read00001.Plateread` … `Read00045.Plateread` files produced by a
Bio-Rad CFX96 (`"96FX"` block, serial `CT019138`) real-time qPCR run
(`20260720_211747_CT019138_Luna_noRT`). One `.Plateread` file is written per plate read,
i.e. once per PCR cycle. This run had 45 reads (protocol `... PLATEREAD; GOTO 2,44`).

> **Status:** the fluorescence table — the payload the user cares about — is fully decoded and
> verified. Some scalar-header fields and the trailing descriptor dictionary are described but not
> every byte is pinned down.

All multi-byte numbers are **little-endian**. Fluorescence and temperature values are
**IEEE-754 32-bit floats**; counters/lengths are **int32**.

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
| **`WELLDATA`** | `0x1A4` | `int32` float-count (`2592`) then 648 records × 4 floats — **the fluorescence table** (§2) |
| **`DARKDATA`** | `0x2A28` | `int32` float-count (`24`) then 6 records × 4 floats — dark/background reading per channel |
| `FILEPATH` | `0x2A8C` | ASCII `\Storage Card\CurrentRun\Read0004N.xlateread` |
| Descriptor dictionary | `0x2AB0` | Field-name table + descriptors mapping names → data (§4) |
| Trailer | end | Pointers into the dictionary/string pool |

Array fields are framed as **`[uint32 count_of_floats][float32 × count]`**. The descriptor for
each array (in the dictionary) stores the data offset relative to base `0x1A4`
(`WELLDATA` → +4 = `0x1A8`; `DARKDATA` → +0x2884 = `0x2A28`).

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

## 3. Scalar metadata header (`0x11C`–`0x1A3`)

Serialized C-struct-style, mixing int32 fields, float temperatures, and a length-prefixed
timestamp string, so it is **not uniformly 4-byte aligned**. Confirmed fields:

| Offset | Type | Field | Read01 | Read45 |
|--------|------|-------|--------|--------|
| `0x11C` | int32 | step identification | 3 | 3 |
| `0x120` | int32 | **cycle number** | 1 | 45 |
| `0x128`/`0x12C` | int32 | scan/step index + cycle repeat | 2 / 1 | 2 / 45 |
| `~0x133` | float | block temperature (~98 °C region) | — | 97.98 |
| `~0x12F,0x137,0x13F` | float | ambient / shuttle / lid temps (~32 °C) | — | 32.0 |
| `0x148`–`0x17C` | int16/int32 | LED currents (6 ch) + fan/lid state | — | — |
| `0x182` | string | timestamp, length-prefixed | — | `Tue, 21 Jul 2026 06:22:23 GMT` |

The cycle number at `0x120`/`0x12C` was the decisive tell: it is the only header int that tracks
1→45 across the file series.

---

## 4. Descriptor dictionary (`0x2AB0`–end)

The tail of the file is a self-describing schema: a list of **field-name slots** (each name in a
fixed ~`0x108`-byte slot) followed by descriptors. Field names appear in this order:

```
ICFFPRFILEVERSION, PLATEREADVERSION, CRC, RUNGUID, ALPHASERIALNUMBER,
BASESERIALNUMBER, HEADSERIALNUMBER, FIRMWAREVERSIONS, SHUTTLEPARAM, SCANMODE,
RETRIEVALTYPE, SCANINDEX, STEPIDENTIFICATION, STEP, CYCLE, ERRORNUMBER,
ERRORDESCRIPTION, BLOCKTEMP, AMBIENTTEMP, SHUTTLETEMP, SAMPLETEMP, LIDTEMP,
LEDCURRENT01..06, FANSTATE, FANOFFTEMP, FANONTEMP, LIDSTATE, LIDFORCE,
LIDPOSITION, CHANNELMASK, NUMBERCOLUMNS, NUMBERROWS, DATETIME, DELTATIME,
WELLDATA, DARKDATA, FILEPATH
```

A descriptor carries `[uint32 length][uint32 dataOffset (relative to base 0x1A4)][uint8 type]`
plus the name/name-pointer. `CHANNELMASK`, `NUMBERCOLUMNS` (12), `NUMBERROWS` (8) corroborate the
6×108 grid derived above.

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

- **Channel → dye mapping** is not determinable from the `.Plateread` payload alone; channels are
  stored in scan order 0–5. The run's calibration (`.Dcal`) files list the dye set
  (FAM, HEX, VIC/Cal Gold 540, ROX/Tex 615/Cal Orange 560, Cy5, Quasar 670/705). In this data the
  amplifying dye is channel index 2.
- Exact byte alignment of individual temperature/LED-current fields in §3 is approximate.
- The `0x000`–`0x00B` version words read most naturally as big-endian; everything from the payload
  onward is little-endian.
- `DARKDATA` (6 records, one per channel) is the LED-off/background reading used for baseline
  subtraction; same 4-float record layout as `WELLDATA`.
