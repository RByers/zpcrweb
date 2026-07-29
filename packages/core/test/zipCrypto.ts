import { deflateRawSync } from "node:zlib";

/**
 * Minimal ZipCrypto encryption + single-entry ZIP builder, mirroring `zipcrypto.ts`'s decrypt
 * algorithm in reverse (see `zipcrypto.md`). Test-only: the library never needs to *write* CFX
 * files, so this lives here rather than in `src/`.
 *
 * Used by the `.pcrd` and `.prcl` tests to build synthetic archives — and to re-wrap a committed
 * plaintext sample under a throwaway password — so the full container → decrypt → inflate → parse
 * pipeline is exercised without the real CFX password (which this repo does not ship; see
 * `secrets.ts`).
 */

/** The throwaway password the synthetic-archive tests encrypt with. Not a secret. */
export const TEST_PASSWORD = "synthetic-test-password";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32Byte(crc: number, byte: number): number {
  return (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
}
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = crc32Byte(c, b);
  return (c ^ 0xffffffff) >>> 0;
}

class EncryptKeys {
  k0 = 0x12345678;
  k1 = 0x23456789;
  k2 = 0x34567890;
  constructor(password: string) {
    for (let i = 0; i < password.length; i++) this.update(password.charCodeAt(i) & 0xff);
  }
  update(byte: number): void {
    this.k0 = crc32Byte(this.k0, byte);
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    this.k2 = crc32Byte(this.k2, this.k1 >>> 24);
  }
  encryptByte(plain: number): number {
    const temp = (this.k2 | 2) & 0xffff;
    const keystream = (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
    const cipher = (plain ^ keystream) & 0xff;
    this.update(plain);
    return cipher;
  }
}

/**
 * The 12-byte encryption header, filled from a fixed seed rather than `randomBytes`.
 *
 * ZipCrypto authenticates a password by one byte — the last header byte, checked against the
 * entry's CRC — so a *wrong* password passes that check roughly once in 256. With a random header
 * that made "reports an error on a wrong password" fail about 0.4% of runs, which is exactly often
 * enough to be dismissed as noise. The bytes still vary (nothing here should depend on their
 * values); they just vary the same way every run.
 */
function headerBytes(): Uint8Array {
  let seed = 0x9e3779b9;
  return Uint8Array.from({ length: 12 }, () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 16) & 0xff;
  });
}

function zipCryptoEncrypt(data: Uint8Array, password: string, entryCrc: number): Uint8Array {
  const keys = new EncryptKeys(password);
  const header = headerBytes();
  header[11] = (entryCrc >>> 24) & 0xff;
  const out = new Uint8Array(12 + data.length);
  for (let i = 0; i < 12; i++) out[i] = keys.encryptByte(header[i]!);
  for (let i = 0; i < data.length; i++) out[12 + i] = keys.encryptByte(data[i]!);
  return out;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}
function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Build a single-entry ZipCrypto-encrypted, DEFLATE-compressed ZIP around `plaintext`, named
 * `entryName` — the container shape `.pltd`/`.prcl`/`.pcrd` all share. For test use only.
 */
export function buildEncryptedZip(
  plaintext: Uint8Array,
  password: string,
  entryName: string,
): Uint8Array {
  const entryCrc = crc32(plaintext);
  const compressed = deflateRawSync(plaintext, { level: 6 });
  const encrypted = zipCryptoEncrypt(compressed, password, entryCrc);
  const name = new TextEncoder().encode(entryName);

  const localHeader = concat(
    new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    u16(20),
    u16(0x0001),
    u16(8),
    u16(0),
    u16(0),
    u32(entryCrc),
    u32(encrypted.length),
    u32(plaintext.length),
    u16(name.length),
    u16(0),
    name,
  );
  const cdEntry = concat(
    new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
    u16(45),
    u16(20),
    u16(0x0001),
    u16(8),
    u16(0),
    u16(0),
    u32(entryCrc),
    u32(encrypted.length),
    u32(plaintext.length),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    name,
  );
  const cdOffset = localHeader.length + encrypted.length;
  const eocd = concat(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(cdEntry.length),
    u32(cdOffset),
    u16(0),
  );
  return concat(localHeader, encrypted, cdEntry, eocd);
}
