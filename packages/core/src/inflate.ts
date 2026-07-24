/**
 * Raw DEFLATE and DEFLATE64 (a.k.a. "Enhanced Deflate", ZIP method 9) decompression.
 *
 * `fflate` (used elsewhere for the outer `.zpcr`) inflates standard DEFLATE but not
 * DEFLATE64, which is what CFX uses for larger `.pltd` payloads. Rather than special-case
 * two libraries, this is a small self-contained inflater that handles both — the DEFLATE64
 * differences are localized to two code-table entries (see below).
 *
 * The decoder follows the canonical-Huffman approach of zlib's reference `puff.c`
 * (count/symbol tables, bit-at-a-time decode) — compact and easy to verify.
 *
 * DEFLATE64 vs DEFLATE (per PKWARE APPNOTE / the Deflate64 spec):
 *  - Length symbol 285: DEFLATE = fixed length 258 (0 extra bits); DEFLATE64 = base 3 with
 *    **16** extra bits (lengths up to 65538).
 *  - Two extra distance symbols 30/31: base 32769/49153, 14 extra bits each (distances up
 *    to 65536, matching the 64 KB history window).
 */

const MAX_BITS = 15;

// Length codes 257..285 → base length and extra bits (standard DEFLATE).
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

// Distance codes 0..29 (standard) plus 30/31 for DEFLATE64.
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
  2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 32769, 49153,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
  13, 13, 14, 14,
];

const CODE_LENGTH_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

interface Huffman {
  /** count[len] = number of codes of bit-length `len`. */
  count: Int32Array;
  /** symbols sorted by (length, then symbol value). */
  symbol: Int32Array;
}

class BitReader {
  private byte = 0;
  private bitcnt = 0;
  constructor(
    private readonly data: Uint8Array,
    private pos = 0,
  ) {}

  /** Read `n` bits, LSB-first (DEFLATE bit order). */
  bits(n: number): number {
    let val = this.byte;
    let cnt = this.bitcnt;
    while (cnt < n) {
      if (this.pos >= this.data.length) throw new Error("inflate: unexpected end of input");
      val |= this.data[this.pos++]! << cnt;
      cnt += 8;
    }
    this.byte = val >> n;
    this.bitcnt = cnt - n;
    return val & ((1 << n) - 1);
  }

  /** Drop to the next byte boundary (for stored blocks). */
  align(): void {
    this.byte = 0;
    this.bitcnt = 0;
  }

  readByte(): number {
    if (this.pos >= this.data.length) throw new Error("inflate: unexpected end of input");
    return this.data[this.pos++]!;
  }
}

function buildHuffman(lengths: number[], n: number): Huffman {
  const count = new Int32Array(MAX_BITS + 1);
  for (let i = 0; i < n; i++) {
    const l = lengths[i]!;
    count[l] = count[l]! + 1;
  }
  // (count[0] holds unused symbols; ignored during decode.)

  const offsets = new Int32Array(MAX_BITS + 1);
  for (let len = 1; len < MAX_BITS; len++) offsets[len + 1] = offsets[len]! + count[len]!;

  const symbol = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (lengths[i] !== 0) symbol[offsets[lengths[i]!]!++] = i;
  }
  return { count, symbol };
}

function decodeSymbol(br: BitReader, h: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= MAX_BITS; len++) {
    code |= br.bits(1);
    const cnt = h.count[len]!;
    if (code - cnt < first) return h.symbol[index + (code - first)]!;
    index += cnt;
    first = (first + cnt) << 1;
    code <<= 1;
  }
  throw new Error("inflate: invalid Huffman code");
}

/** Prebuilt fixed literal/length and distance tables (fixed-Huffman blocks). */
function fixedTables(): { lit: Huffman; dist: Huffman } {
  const litLengths: number[] = [];
  for (let i = 0; i < 144; i++) litLengths[i] = 8;
  for (let i = 144; i < 256; i++) litLengths[i] = 9;
  for (let i = 256; i < 280; i++) litLengths[i] = 7;
  for (let i = 280; i < 288; i++) litLengths[i] = 8;
  const distLengths = new Array(32).fill(5);
  return { lit: buildHuffman(litLengths, 288), dist: buildHuffman(distLengths, 32) };
}

/**
 * Inflate a raw DEFLATE / DEFLATE64 stream.
 *
 * @param data raw compressed bytes (no zlib/gzip wrapper).
 * @param expectedSize uncompressed size, when known — pre-sizes the output buffer.
 * @param deflate64 enable the DEFLATE64 length/distance extensions (ZIP method 9).
 */
export function inflateRaw(
  data: Uint8Array,
  expectedSize?: number,
  deflate64 = false,
): Uint8Array {
  const br = new BitReader(data);
  let out = new Uint8Array(expectedSize && expectedSize > 0 ? expectedSize : 1024);
  let len = 0;

  const ensure = (extra: number): void => {
    if (len + extra <= out.length) return;
    let cap = out.length * 2;
    while (cap < len + extra) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(out.subarray(0, len));
    out = bigger;
  };

  const lengthBase = LENGTH_BASE.slice();
  const lengthExtra = LENGTH_EXTRA.slice();
  if (deflate64) {
    // Symbol 285 becomes base 3 + 16 extra bits instead of the fixed length 258.
    lengthBase[28] = 3;
    lengthExtra[28] = 16;
  }
  const distSymbols = deflate64 ? 32 : 30;

  let final = false;
  while (!final) {
    final = br.bits(1) === 1;
    const type = br.bits(2);

    if (type === 0) {
      // Stored block: length + one's complement, then raw bytes.
      br.align();
      const blockLen = br.readByte() | (br.readByte() << 8);
      br.readByte();
      br.readByte(); // ~blockLen, ignored
      ensure(blockLen);
      for (let i = 0; i < blockLen; i++) out[len++] = br.readByte();
      continue;
    }

    let lit: Huffman;
    let dist: Huffman;
    if (type === 1) {
      ({ lit, dist } = fixedTables());
    } else if (type === 2) {
      const hlit = br.bits(5) + 257;
      const hdist = br.bits(5) + 1;
      const hclen = br.bits(4) + 4;
      const clLengths = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) clLengths[CODE_LENGTH_ORDER[i]!] = br.bits(3);
      const clTable = buildHuffman(clLengths, 19);

      const allLengths = new Array(hlit + hdist).fill(0);
      let i = 0;
      while (i < hlit + hdist) {
        const sym = decodeSymbol(br, clTable);
        if (sym < 16) {
          allLengths[i++] = sym;
        } else if (sym === 16) {
          const prev = allLengths[i - 1]!;
          for (let r = br.bits(2) + 3; r > 0; r--) allLengths[i++] = prev;
        } else if (sym === 17) {
          for (let r = br.bits(3) + 3; r > 0; r--) allLengths[i++] = 0;
        } else {
          for (let r = br.bits(7) + 11; r > 0; r--) allLengths[i++] = 0;
        }
      }
      lit = buildHuffman(allLengths.slice(0, hlit), hlit);
      dist = buildHuffman(allLengths.slice(hlit), hdist);
    } else {
      throw new Error("inflate: invalid block type 3");
    }

    // Decode literals / matches until the end-of-block symbol (256).
    for (;;) {
      const sym = decodeSymbol(br, lit);
      if (sym === 256) break;
      if (sym < 256) {
        ensure(1);
        out[len++] = sym;
        continue;
      }
      const li = sym - 257;
      if (li >= lengthBase.length) throw new Error("inflate: invalid length symbol");
      const matchLen = lengthBase[li]! + br.bits(lengthExtra[li]!);

      const dsym = decodeSymbol(br, dist);
      if (dsym >= distSymbols) throw new Error("inflate: invalid distance symbol");
      const distance = DIST_BASE[dsym]! + br.bits(DIST_EXTRA[dsym]!);
      if (distance > len) throw new Error("inflate: distance beyond output start");

      ensure(matchLen);
      let from = len - distance;
      for (let k = 0; k < matchLen; k++) out[len++] = out[from++]!;
    }
  }

  return out.subarray(0, len);
}
