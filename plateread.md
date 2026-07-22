# Bio-Rad CFX96 `.Plateread` File Format

Reverse-engineered from the `Read00001.Plateread` … `Read00045.Plateread` files produced by a
Bio-Rad CFX96 (`"96FX"` block, serial `CT019138`) real-time qPCR run
(`20260720_211747_CT019138_Luna_noRT`). One `.Plateread` file is written per plate read,
i.e. once per PCR cycle. This run had 45 reads (protocol `... PLATEREAD; GOTO 2,44`).

> **Status:** fully decoded. The file is **self-describing**: a trailing **descriptor
> dictionary** (§4) lists every field's absolute offset, byte length, and type. Using it, all
> scalar-header fields, strings, and the WELLDATA/DARKDATA arrays decode exactly — no offsets
> need to be hardcoded (they were originally, and still serve as a fallback).

**Endianness is mixed.** The metadata — version words, the scalar header, and the descriptor
dictionary — is **big-endian**. The **WELLDATA and DARKDATA float arrays are little-endian**
(they read as native DSP output). Fluorescence and temperature values are IEEE-754 32-bit
floats; counters/lengths are int32.

> The original reverse-engineering assumed all-little-endian and read the scalar header at
> approximate misaligned offsets — which made e.g. block temperature come out as ~98 °C. Reading
> the descriptor-declared offsets **big-endian** instead gives the correct **60 °C** (the plate
> read happens at the 60 °C step), and every other scalar then matches `RunInfo.xml`/the protocol.

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

---

## 4. Descriptor dictionary (`0x2AB9`–end) — the authoritative schema

The tail of the file, immediately after the FILEPATH string, is a **self-describing schema**:
a list of **field-name slots**. Each slot is a NUL-padded field name followed **255 bytes
later** by a 9-byte descriptor:

```
[uint32 offset][uint32 length][uint8 type]      offset/length are ABSOLUTE file bytes
```

Field names appear in this order (`ICFFPRFILEVERSION, PLATEREADVERSION, CRC, RUNGUID,
ALPHASERIALNUMBER, BASESERIALNUMBER, HEADSERIALNUMBER, FIRMWAREVERSIONS, SHUTTLEPARAM,
SCANMODE, RETRIEVALTYPE, SCANINDEX, STEPIDENTIFICATION, STEP, CYCLE, ERRORNUMBER,
ERRORDESCRIPTION, BLOCKTEMP, AMBIENTTEMP, SHUTTLETEMP, SAMPLETEMP, LIDTEMP, LEDCURRENT01..06,
FANSTATE, FANOFFTEMP, FANONTEMP, LIDSTATE, LIDFORCE, LIDPOSITION, CHANNELMASK, NUMBERCOLUMNS,
NUMBERROWS, DATETIME, DELTATIME, WELLDATA, DARKDATA, FILEPATH`).

The **offsets are absolute and exact**, verified against the data:

- `WELLDATA` → offset `0x1A4`, length `10372` (= 4-byte count + 648×16 data). Float data at
  `0x1A8`.
- `DARKDATA` → offset `0x2A28`, length `100` (= count + 6×16). Float data at `0x2A2C`.
- `FILEPATH` → offset `0x2A8C`, length `45`.
- `DATETIME`, the serials, and every scalar likewise point at their exact bytes.

So the dictionary can drive decoding directly, with no hardcoded offsets. The array descriptors
point at the `int32` count; the float payload starts 4 bytes later.

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
