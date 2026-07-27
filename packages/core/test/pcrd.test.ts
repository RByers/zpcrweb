import { deflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { parsePcrd, parseZpcr } from "../src/index.js";
import { readCfxPassword } from "./secrets.js";

const here = dirname(fileURLToPath(import.meta.url));

// Same fixture the .md docs cross-validate against: the CFX Manager saved-experiment document
// for the run also committed as samples/20260720_FirstQualification.zpcr.
const PCRD_PATH = resolve(here, "../../../samples/20260720_Luna_noRT.pcrd");
const PCRD_XML_PATH = resolve(here, "../../../samples/20260720_Luna_noRT.pcrd.xml");
const ZPCR_PATH = resolve(here, "../../../samples/20260720_FirstQualification.zpcr");

function readBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const PW = readCfxPassword();

describe("pcrd — container + password handling (no secret needed)", () => {
  it("decodes the container and reports needsPassword without a password", () => {
    const pcrd = parsePcrd(readBytes(PCRD_PATH));
    expect(pcrd.container.encrypted).toBe(true);
    expect(pcrd.container.innerName).toMatch(/\.pcrd$/);
    expect(pcrd.needsPassword).toBe(true);
    expect(pcrd.zpcr).toBeUndefined();
    expect(pcrd.error).toBeUndefined();
  });

  it("reports an error (not needsPassword) on a wrong password", () => {
    const pcrd = parsePcrd(readBytes(PCRD_PATH), { password: "wrong" });
    expect(pcrd.needsPassword).toBeUndefined();
    expect(pcrd.zpcr).toBeUndefined();
    expect(pcrd.error).toBeDefined();
  });
});

// --- Minimal ZipCrypto encryption + single-entry ZIP builder, mirroring zipcrypto.ts's
// decrypt algorithm in reverse. Test-only: the library never needs to *write* CFX files.
// (Duplicated from pcrd-synthetic.test.ts/prcl.test.ts — kept self-contained per file.) Used
// here to re-wrap the committed plaintext sample (extracted once, for real, using the real
// password — see the pipeline test below) under a throwaway test password, so the decode
// assertions exercise the exact real-world document without needing the real secret.

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

function zipCryptoEncrypt(data: Uint8Array, password: string, entryCrc: number): Uint8Array {
  const keys = new EncryptKeys(password);
  const header = randomBytes(12);
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

/** Re-wrap `plaintext` as a single-entry encrypted `.pcrd`-shaped ZIP, for test use only. */
function buildSyntheticPcrd(plaintext: Uint8Array, password: string): Uint8Array {
  const entryCrc = crc32(plaintext);
  const compressed = deflateRawSync(plaintext, { level: 6 });
  const encrypted = zipCryptoEncrypt(compressed, password, entryCrc);
  const name = new TextEncoder().encode("20260720_211747_CT019138_Luna_noRT.pcrd");

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

describe("pcrd — decoded structure (real document, re-wrapped, no secret needed)", () => {
  const password = "synthetic-test-password";
  const plaintext = readBytes(PCRD_XML_PATH);
  const zipBytes = buildSyntheticPcrd(plaintext, password);
  const pcrd = parsePcrd(zipBytes, { password });

  it("decodes into the same Zpcr shape as the matching .zpcr, cross-validated field for field", () => {
    expect(pcrd.error).toBeUndefined();
    const zpcr = pcrd.zpcr!;
    const reference = parseZpcr(readBytes(ZPCR_PATH));

    expect(zpcr.metadata.identifier).toBe(reference.metadata.identifier);
    expect(zpcr.metadata.baseSerialNumber).toBe(reference.metadata.baseSerialNumber);
    expect(zpcr.reads).toHaveLength(reference.reads.length);
    expect(zpcr.reads.length).toBe(45);

    // Every WELLDATA/DARKDATA value across all 45 reads matches the binary .Plateread files
    // bit-for-bit (see pcrd.md §3.1).
    for (let i = 0; i < zpcr.reads.length; i++) {
      const a = zpcr.reads[i]!;
      const b = reference.reads[i]!;
      expect(a.cycle).toBe(b.cycle);
      expect(a.step).toBe(b.step);
      expect(a.channelMask).toBe(b.channelMask);
      expect(a.blockTempC).toBeCloseTo(b.blockTempC!, 2);
      // `LedCur01`…`LedCur06` decode to the same DAC settings the binary `LEDCURRENT*` fields
      // carry, so both formats feed one LED-current pivot.
      expect(a.leds).toEqual(b.leds);
      for (let ch = 0; ch < a.wells.length; ch++) {
        for (let row = 0; row < a.wells[ch]!.length; row++) {
          for (let col = 0; col < a.wells[ch]![row]!.length; col++) {
            const x = a.wells[ch]![row]![col]!;
            const y = b.wells[ch]![row]![col]!;
            expect(x.mean).toBeCloseTo(y.mean, 2);
            expect(x.min).toBeCloseTo(y.min, 2);
            expect(x.max).toBeCloseTo(y.max, 2);
          }
        }
      }
      for (let d = 0; d < a.dark.length; d++) {
        expect(a.dark[d]!.mean).toBeCloseTo(b.dark[d]!.mean, 2);
      }
    }
  });

  it("exposes its XML header as PlateRead.fields, the same key/value table a .zpcr read has", () => {
    const read = pcrd.zpcr!.reads[0]!;
    expect(read.fields.length).toBeGreaterThan(0);
    // Same shape as a binary read's, minus the ICFF provenance — there are no byte offsets
    // behind an XML element — and minus the file, since a .pcrd read isn't one.
    expect(read.fields.every((f) => f.binary === undefined)).toBe(true);
    expect(read.binaryFile).toBeUndefined();
    expect(read.fields.map((f) => f.name)).toContain("BlockTmp");
    expect(Number(read.fields.find((f) => f.name === "BlockTmp")!.value)).toBeCloseTo(
      read.blockTempC!,
      2,
    );
    // DrkCrnt is the nested DARKDATA array, surfaced as `dark`, not as a header scalar.
    expect(read.fields.map((f) => f.name)).not.toContain("DrkCrnt");
  });

  it("pivots into curves/darkCurves/temperatureCurves/ledCurves like a .zpcr", () => {
    const zpcr = pcrd.zpcr!;
    const curves = zpcr.curves();
    expect(curves.length).toBeGreaterThan(0);
    expect(curves[0]!.cycles).toHaveLength(45);
    expect(zpcr.darkCurves()).toHaveLength(6);
    expect(zpcr.ledCurves().map((c) => c.label)).toEqual([
      "Ch1",
      "Ch2",
      "Ch3",
      "Ch4",
      "Ch5",
      "Ch6",
    ]);
    expect(zpcr.channels().length).toBeGreaterThan(0);
    expect(zpcr.steps().length).toBeGreaterThan(0);
  });

  it("decodes the embedded plate setup via plates()", () => {
    const zpcr = pcrd.zpcr!;
    const plates = zpcr.plates();
    expect(plates).toHaveLength(1);
    const plate = plates[0]!.pltd.plate!;
    expect(plate.plateName).toBe("BR Clear");
    expect(plate.rows).toBe(8);
    expect(plate.columns).toBe(12);
    expect(plate.fluors.map((f) => f.fluor)).toEqual(["FAM", "Texas Red", "Cy5"]);
  });

  it("exposes the real protocol text via protocolText and reports an empty archive", () => {
    const zpcr = pcrd.zpcr!;
    expect(zpcr.protocolText).toContain("METHOD CALC");
    expect(zpcr.archive.entries).toEqual([]);
  });

  it("exposes not-yet-decoded subtrees verbatim in the full raw document (Pcrd.xml)", () => {
    expect(pcrd.xml).toContain("<experimentalData2");
    expect(pcrd.xml).toContain("dataAnalysisParameters");
  });

  it("decodes calibrations() from calibrationCollection, matching the .zpcr's real .Dcal files", () => {
    const zpcr = pcrd.zpcr!;
    const reference = parseZpcr(readBytes(ZPCR_PATH));

    const entries = zpcr.calibrations();
    const refEntries = reference.calibrations();
    // 14 dyes x {BR Clear, BR White}, same library the .zpcr carries as 28 real .Dcal files.
    expect(entries).toHaveLength(28);
    expect(refEntries).toHaveLength(28);

    const byKey = (list: typeof entries) =>
      new Map(list.map((e) => [`${e.dcal.dye}|${e.dcal.plate}`, e.dcal]));
    const fromPcrd = byKey(entries);
    const fromZpcr = byKey(refEntries);
    expect([...fromPcrd.keys()].sort()).toEqual([...fromZpcr.keys()].sort());

    for (const [key, a] of fromPcrd) {
      const b = fromZpcr.get(key)!;
      expect(a.primaryChannel).toBe(b.primaryChannel);
      expect(a.channelCount).toBe(b.channelCount);
      expect(a.wellCount).toBe(b.wellCount);
      expect(a.factory).toBe(b.factory);
      expect(a.notes).toBe(b.notes);

      expect(a.blocks).toHaveLength(b.blocks.length);
      for (const blockA of a.blocks) {
        const blockB = b.blocks.find(
          (x) => x.kind === blockA.kind && x.temperatureC === blockA.temperatureC,
        )!;
        expect(blockB).toBeDefined();
        expect(blockA.channelCount).toBe(blockB.channelCount);
        expect(blockA.wellCount).toBe(blockB.wellCount);
        for (let i = 0; i < blockA.values.length; i++) {
          expect(blockA.values[i]!).toBeCloseTo(blockB.values[i]!, 2);
        }
      }
    }
  });

  it("recovers the calibration timestamp/operator the .pcrd's copy carries (unlike this run's .zpcr .Dcal snapshot)", () => {
    const zpcr = pcrd.zpcr!;
    const fam = zpcr
      .calibrations()
      .find((e) => e.dcal.dye === "FAM" && e.dcal.plate === "BR Clear")!.dcal;
    expect(fam.security.date?.getUTCFullYear()).toBe(2026);
    expect(fam.security.username).toBe("Bio-Rad Service");
    expect(fam.security.app).toBe("BioRadCFXManager");
  });

  it("decodes wellFactorsCollection, with no active set for this run's unsaved factors", () => {
    const factors = pcrd.zpcr!.wellFactors!;
    expect(factors.channelCount).toBe(6);
    expect(factors.wellCount).toBe(108);
    // This run saved neither set (`snrSaved`/`flyovrSaved` are both False — the header notes
    // the factors were synthesized during persistence loading), so no gain correction applies.
    expect(factors.source).toMatch(/Persistence loading/);
    expect(factors.snr).toBeUndefined();
    expect(factors.flyover).toBeUndefined();
    expect(factors.active).toBeUndefined();
    expect(factors.get(0, 0)).toBeUndefined();
  });

  it("has no wellFactors on a .zpcr, which stores no equivalent", () => {
    expect(parseZpcr(readBytes(ZPCR_PATH)).wellFactors).toBeUndefined();
  });
});

describe.skipIf(!PW)("pcrd — decryption pipeline (requires secrets.json)", () => {
  it("decrypts the real .pcrd file to the same plaintext committed in samples/", () => {
    const pcrd = parsePcrd(readBytes(PCRD_PATH), { password: PW });
    expect(pcrd.error).toBeUndefined();
    expect(pcrd.xml).toBe(new TextDecoder("utf-8").decode(readBytes(PCRD_XML_PATH)));
  });
});
