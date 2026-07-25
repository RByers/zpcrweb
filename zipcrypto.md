# Bio-Rad's ZipCrypto container — shared by `.pltd`/`.prcl` and `.pcrd`

Both the `.pltd`/`.prcl` plate-and-protocol files ([`pltd.md`](./pltd.md)) and the `.pcrd`
saved-experiment files ([`pcrd.md`](./pcrd.md)) are the **same single-entry encrypted ZIP**
container, differing only in the XML payload inside. This doc covers the container and
encryption layer once; the format docs cover only their payload.

> **Status:** fully decoded. Every sample in both formats (32 `.pltd` files, 2019–2023, both
> container variants, plus the `.pcrd` sample) decrypts, decompresses and parses byte-exact
> against a reference `unzip`. Implemented by
> [`packages/core/src/zipcrypto.ts`](./packages/core/src/zipcrypto.ts) +
> [`inflate.ts`](./packages/core/src/inflate.ts).

---

## 1. Container — a single-entry ZIP

The file is an ordinary ZIP archive containing exactly **one** entry, which is the "real"
payload file (its name echoes the outer filename, or is a GUID for files authored later). That
entry is **compressed and ZipCrypto-encrypted**. Two variants appear in the wild; parse via the
**central directory** (authoritative for both) rather than the local header:

| Variant | Leading bytes | GP flag | Method | Notes |
|---------|---------------|---------|--------|-------|
| A | `50 4B 03 04` (local header) | `0x0003` | **9 = Deflate64** | no data descriptor; CRC/size in local header |
| B | `50 4B 07 08` then `50 4B 03 04` | `0x000B` | **8 = Deflate** | leading spanning marker; data descriptor (bit 3); real CRC/size in the central directory |

- GP flag **bit 0 = 1** → the entry data is encrypted (ZipCrypto).
- The central-directory record (`50 4B 01 02`) gives the true `method`, `crc32`,
  `compressedSize`, `uncompressedSize`, filename and local-header offset. Local-header
  offsets are absolute from byte 0 (they already account for the leading spanning marker in
  variant B).
- `version-made-by = 45` and a UTF-16 filename stored in an extra field are consistent
  fingerprints of the writer's ZIP library.

The uncompressed inner file is small but highly repetitive (compression ratios up to ~54× for
`.pltd`), so **Deflate64** (method 9) is common — a standard DEFLATE inflater cannot read those;
the library ships its own inflater ([`inflate.ts`](./packages/core/src/inflate.ts)) covering
both methods.

`.pcrd` has only been observed as variant B, but it's the same writer library that emits
Deflate64 for `.pltd`, so assume both methods are possible there too.

## 2. Encryption — traditional PKWARE (ZipCrypto)

The single entry is encrypted with the legacy PKWARE stream cipher (APPNOTE §6.1): three
32-bit keys seeded from a password, a 12-byte encryption header prepended to the entry, then
the compressed bytes. Standard-mode (non–Security-Edition) plate/protocol/data files all use one
**fixed password**, shared across `.pltd`, `.prcl` and `.pcrd` alike (Security-Edition files use
a per-user password instead).

### This project does not ship the password

To decode a file you must supply the password yourself:

- **Library:** `parsePltd(bytes, { password })` — with no password, an encrypted entry is
  returned as `{ container, needsPassword: true }` and nothing is decrypted.
- **Web app:** the first time you open an encrypted file, it prompts for the password and
  stores it in your browser (`localStorage`, key `zpcr:pltdPassword`), reusing it for every
  file thereafter.

### Finding the password (licensed CFX Manager only)

The fixed standard-mode password is a constant inside the CFX Manager software you already
license. In a legitimate installation you can recover it from the program's managed
assemblies: the value is the string handed to the bundled ZIP component's *default
encryption/decryption password* property (search the assemblies for the
`DefaultEncryptionPassword` / `DefaultDecryptionPassword` setters — the literal loaded
immediately before the call is the password). Enter that value into the app once. Do not
redistribute it.

Once supplied: decrypt the entry, drop the 12-byte header, then inflate (method 8 or 9). See
[`zipcrypto.ts`](./packages/core/src/zipcrypto.ts).
