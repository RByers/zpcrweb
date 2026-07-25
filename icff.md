# "ICFF" — Bio-Rad's index container format

`ICFF` is a small, hand-rolled index container Bio-Rad's CFX instrument software uses for
several binary file formats. It is not ZIP, not XML, and (by itself) not encrypted — `file`
reports plain `data`. It is the container for `.Plateread` (see [`plateread.md`](./plateread.md)),
and — per private reverse-engineering notes not included in this repo — also for `.Dcal`
dye-calibration files and (with a different magic/key casing) legacy MJ Research dye files.

> **Status:** fully decoded and verified against every `.Plateread` in the committed sample
> (`samples/`), and independently against `.Dcal` files during private research. Implemented by
> `packages/core/src/icff.ts`.

## Layout

Values come *first*; the index is at the *end*, and the last 8 bytes of the file point back at
it:

```
[ value blob — every field's raw data, packed back-to-back from offset 0 ]
[ "ICFF" magic (4 bytes) ]
[ N × 264-byte index entries ]
[ u32 LE index_offset ][ u32 LE entry_stride (= 264) ]
```

To read it: take the file's final 8 bytes as `[index_offset, entry_stride]` (both **u32 LE**),
seek to `index_offset`, confirm the 4 bytes there read `ICFF`, then walk `entry_stride`-byte
entries starting immediately after the magic until you reach the footer (`file_length - 8`).
This requires no prior knowledge of the file's fields — the index is fully self-describing, and
the entry count falls out of `(footer_offset - entries_start) / entry_stride`.

Do **not** locate the index by scanning for a known field name (an earlier version of this
decoder did, anchoring on the first field's name). That approach is fragile — it happened to
work only because the magic bytes and the first entry's name sit back-to-back in the file — and
it also swallows the magic into the field name (`"ICFF" + "PRFILEVERSION"` reads as
`"ICFFPRFILEVERSION"`, but the real field name is `PRFILEVERSION`). Read the footer instead.

## Index entry (264 bytes)

| Offset | Size | Meaning |
|---|---|---|
| 0 | 255 | Key name, ASCII, NUL-padded |
| 255 | 4 | Value offset from file start, **u32 LE** |
| 259 | 4 | Value length in bytes, **u32 LE** |
| 263 | 1 | Flag/count byte, `0x01` in every entry observed |

## Endianness

The container's own bookkeeping (`index_offset`/`entry_stride` in the footer, and each entry's
`offset`/`length`) is **little-endian**. What the *values themselves* mean is up to the format
built on top of ICFF, but both known consumers agree on the same convention: scalar `int32`/
`float32` values are **big-endian**, while any bulk float array payload (e.g. `.Plateread`'s
`WELLDATA`/`DARKDATA`, `.Dcal`'s per-channel response arrays) is **little-endian float32**. A
generic reader can decode a 4-byte entry both ways and let the consuming format's schema decide
which applies.

## Schema is self-describing and per-file

The set of keys, and their order, varies between files of the same format — always iterate the
index rather than assuming fixed offsets or a fixed count. `.Plateread` files in this repo's
samples carry 42 entries; `.Dcal` files carry anywhere from 33 to 37 depending on which optional
metadata (`REFSPOTS`, `AMBIENTTEMP`, …) the calibration run recorded.

## Reference implementation

`packages/core/src/icff.ts` exports:

- `IcffEntry` — one decoded index entry: `name`, `offset`, `length`, `flag`, plus best-effort
  decoded `int` (BE), `float` (BE), and `text` (NUL-terminated ASCII) when the length makes one
  plausible.
- `parseIcff(bytes)` — walks the footer-located index and returns every `IcffEntry`, or `[]` if
  the file has no ICFF footer/magic.
- `icffFieldMap(entries)` — convenience `name → IcffEntry` lookup.

`plateread.ts` builds `.Plateread`'s field dictionary and typed accessors (cycle number, block
temperature, well/dark tables, …) on top of these. A future `.Dcal` reader can reuse the same
`icff.ts` for its container layer and layer its own key semantics (§2 of the private `dcal.md`
notes) on top, the same way `plateread.ts` does.
