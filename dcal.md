# Bio-Rad CFX `.Dcal` Pure-Dye Calibration File Format

A `.Dcal` is a **pure-dye calibration**: for one dye, on one plate type, how much that dye's
fluorescence shows up in *each* of the 6 optical channels, measured at four block temperatures.
It carries both a dye-filled plate reading and a matching empty-plate reading at each
temperature, so a consumer can baseline one against the other. `.Dcal` is also the **only**
in-archive source of which optical channel a dye is primarily read on (`PRIMARYCHANNEL`).

> **Status:** fully decoded. Not encrypted, not compressed — `file` reports plain `data`.
> Implemented by [`packages/core/src/dcal.ts`](./packages/core/src/dcal.ts), entry point
> `parseDcal(bytes)`; `zpcr.calibrations()` decodes every `.Dcal` entry in a `.zpcr` archive.

Every `.zpcr` run archive carries **28 `.Dcal` files** — 14 dyes × 2 plate types (`BR Clear`,
`BR White`) — a snapshot of the instrument's full dye calibration library at run start. This is
the complete library, not the run's actual channel assignment; most entries are for dyes the run
never used.

---

## 1. Container — ICFF

`.Dcal` is built on **ICFF**, the same small index container `.Plateread` uses. See
[`icff.md`](./icff.md) for the full container layout (footer, index-entry structure,
endianness); this document covers only what's specific to `.Dcal`'s use of it, decoded via
`packages/core/src/icff.ts`.

**Note on decoding 4-byte fields:** ICFF's generic decoder guesses a field's type from its
length — 4 bytes decodes as a scalar int32/float32, anything else as a string. That heuristic
doesn't hold for `.Dcal`: some string fields (`DYE` = `"FAM"`, `MODEL`, …) are exactly 4 bytes
including their NUL terminator, the same length as a real scalar. `dcal.ts` reads those fields
directly at their own offset/length instead of trusting the generic guess — see `textAt`/`intAt`
in the source if you're extending it.

## 2. Keys

The schema is self-describing and the key set varies between files — always iterate the index,
never assume a fixed layout. A typical live-instrument file carries 33–37 keys.

### The 8 payload blocks

One block per (plate state, block temperature): the dye-filled plate and an empty plate, each
read at four temperatures:

```
Dye0:20:PR    Dye0:40:PR    Dye0:60:PR    Dye0:80:PR
Empty0:20:PR  Empty0:40:PR  Empty0:60:PR  Empty0:80:PR
```

The `0` is the plate rotation in degrees; a `180` variant is defined by the format but not
observed in any file in the wild.

### Metadata keys

| Key | Type | Notes |
|---|---|---|
| `DYE` | string | Dye name, e.g. `FAM`, `HEX`, `Cal Gold 540` — an open string set |
| `PLATE` | string | Plate type, e.g. `BR Clear` or `BR White` |
| `PRIMARYCHANNEL` | int32 | **1-based** optical channel this dye is primarily read on |
| `COLORS` | int32 | Channel count in the payload blocks, 6 |
| `WELLS` | int32 | Wells per channel in the payload blocks: 108 (CFX96) or 408 (CFX384) |
| `FACTORY` | int32 | 1 = factory calibration, 0 = user/instrument calibration |
| `AMBIENTTEMP` | float32 | Ambient temperature during calibration, °C |
| `SHUTTLETEMP` | float32 | Shuttle temperature during calibration, °C |
| `PLATEREADVERSION`, `SHUTTLEENCODING`, `MODEL` | int32 | |
| `NOTES` | string | `\|`-separated free text |
| `ALPHASERIALNUMBER`, `BASESERIALNUMBER`, `HEADSERIALNUMBER`, `FIRMWAREVERSIONS` | string | Instrument identity |
| `SECURITY{YEAR,MONTH,DAY,HOUR,MIN,SEC,TIMEZONE}` | int32 | Calibration timestamp components |
| `SECURITY{USERNAME,FULLNAME,SIGNATURE,COMPUTER,APP,APPVER}` | string | Who/what recorded it |
| `CRC`, `REFSPOTS`, `USERDUPLICATED` | — | Present in some files; not decoded (see §5) |

The well counts are one **row** more than the nominal plate (9×12 for a 96-well plate, not
8×12) — row 8 (0-based) is a reference row, the same convention `.Plateread` uses.

## 3. Payload block layout

Each `*:PR` value is **2617 bytes** (CFX96, 108 wells) or **9817 bytes** (CFX384, 408 wells):

| Offset | Size | Meaning |
|---|---|---|
| 0 | 1 | Block format version |
| 1 | 1 | Channel count |
| 2 | 3 | Zero padding |
| 5 | 4 | Well count, **u32 LE** |
| 9 | 16 | Zeros |
| 25 | `channels × wells × 4` | **float32 LE**, channel-major |

`25 + 6 × 108 × 4 = 2617` and `25 + 6 × 408 × 4 = 9817`, confirming the layout: one float per
(channel, well) — a mean, not a multi-stat tuple. Index into it as `values[channel * wells +
well]`.

**In every file this library has decoded, every well within a channel carries the same value.**
The format supports a full per-well map, so don't assume uniformity in code that needs to be
correct on data this library hasn't seen — but for display or spot-checking, well 0 (`A1`) is
representative.

The unused sixth channel (channel index 5) reads all zeros on CFX96 — 5 usable dye channels plus
one always-empty slot in the payload.

## 4. How to use it

```ts
import { parseZpcr } from "@zpcrweb/core";

const zpcr = parseZpcr(bytes);
for (const { name, dcal } of zpcr.calibrations()) {
  console.log(name, dcal.dye, dcal.plate, "primary channel", dcal.primaryChannel);
}
```

Or decode a single file directly:

```ts
import { parseDcal, findDcalBlock } from "@zpcrweb/core";

const dcal = parseDcal(bytes);
const dyeAt60 = findDcalBlock(dcal, "dye", 60)!;
const emptyAt60 = findDcalBlock(dcal, "empty", 60)!;
// dyeAt60.values / emptyAt60.values are channel-major: values[channel * wellCount + well]
```

`parseDcal()` returns:

- Identity: `dye`, `plate`, `primaryChannel` (0-based, converted from the on-disk 1-based
  field — this library is 0-based everywhere else too), `channelCount`, `wellCount`, `factory`.
- Conditions: `ambientTempC`, `shuttleTempC`, `notes`.
- Provenance: `serials` (instrument serial numbers) and `security` (who/when it was recorded).
- `blocks`: every `Dye*:*:PR`/`Empty*:*:PR` payload, each with `kind`, `rotationDeg`,
  `temperatureC`, `channelCount`, `wellCount`, and the raw `values` array. Use
  `findDcalBlock(dcal, kind, temperatureC, rotationDeg?)` to look one up.
- `fields`: every ICFF index entry, raw, for anything not surfaced above (e.g. `CRC`,
  `REFSPOTS`).

This library only **decodes** the file — it does not attempt color separation or any other
downstream calibration math. Building that on top (e.g. combining the dye and empty readings
across channels and temperatures into a color-separation matrix) is a natural next step but is
out of scope here.

## 5. Open items

- `CRC` — present in some files, algorithm not identified; not needed to read the file.
- `REFSPOTS`, `USERDUPLICATED`, `SHUTTLEENCODING` — present in some files, not decoded.
- The `180°`-rotation blocks (`Dye180:*:PR`, `Empty180:*:PR`) are defined by the key naming
  scheme but have not been observed in any file; `dcal.ts` parses them if present.
- A legacy, differently-keyed dye-file variant (lowercase keys, a different magic string) is
  known to exist for older instruments but is not covered here.
