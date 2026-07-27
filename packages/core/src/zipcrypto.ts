/**
 * Traditional PKWARE ZIP encryption ("ZipCrypto") — decryption only.
 *
 * Bio-Rad CFX wraps `.pltd`/`.prcl` payloads in a ZIP whose single entry is encrypted with
 * this legacy stream cipher, using a fixed password (see {@link ./pltd.ts}). The scheme is
 * weak but that is not our concern here: we only need to reproduce the decrypt path to read
 * our own plate files.
 *
 * Reference: APPNOTE.TXT §6.1 (Decryption). Three 32-bit keys are seeded from the password
 * and evolved one byte at a time; the first 12 bytes of the entry are an encryption header
 * that is decrypted and discarded.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Byte(crc: number, byte: number): number {
  return (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
}

/** The three evolving keys of the traditional PKWARE cipher. */
class Keys {
  private k0 = 0x12345678;
  private k1 = 0x23456789;
  private k2 = 0x34567890;

  constructor(password: string) {
    // Password bytes are Latin-1 / raw bytes; CFX passwords are ASCII.
    for (let i = 0; i < password.length; i++) this.update(password.charCodeAt(i) & 0xff);
  }

  private update(byte: number): void {
    this.k0 = crc32Byte(this.k0, byte);
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    this.k2 = crc32Byte(this.k2, this.k1 >>> 24);
  }

  /** Decrypt one cipher byte, advancing the key state with the recovered plaintext byte. */
  decryptByte(cipher: number): number {
    const temp = (this.k2 | 2) & 0xffff;
    const keystream = (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
    const plain = (cipher ^ keystream) & 0xff;
    this.update(plain);
    return plain;
  }
}

/** Length of the ZipCrypto encryption header prepended to every encrypted entry. */
const ZIPCRYPTO_HEADER_LEN = 12;

/**
 * Decrypt a ZipCrypto entry: seed the keys from `password`, consume the 12-byte encryption
 * header, and return the decrypted remainder (still compressed — inflate separately).
 */
export function zipCryptoDecrypt(data: Uint8Array, password: string): Uint8Array {
  if (data.length < ZIPCRYPTO_HEADER_LEN) {
    throw new Error("ZipCrypto entry too short to contain an encryption header");
  }
  const keys = new Keys(password);
  for (let i = 0; i < ZIPCRYPTO_HEADER_LEN; i++) keys.decryptByte(data[i]!);

  const out = new Uint8Array(data.length - ZIPCRYPTO_HEADER_LEN);
  for (let i = 0; i < out.length; i++) {
    out[i] = keys.decryptByte(data[i + ZIPCRYPTO_HEADER_LEN]!);
  }
  return out;
}
