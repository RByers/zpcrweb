import { deflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { isPrclName, parsePcrd, parsePrcl, parseProtocol2 } from "../src/index.js";

// --- Minimal ZipCrypto encryption + single-entry ZIP builder, mirroring zipcrypto.ts's
// decrypt algorithm in reverse. Test-only: the library never needs to *write* CFX files.
// (Duplicated from pcrd-synthetic.test.ts — kept self-contained per file, as that file does.)

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

/** Build a single-entry encrypted `.prcl`-shaped ZIP around `plaintext`, for test use only. */
function buildSyntheticPrcl(plaintext: Uint8Array, password: string): Uint8Array {
  const entryCrc = crc32(plaintext);
  const compressed = deflateRawSync(plaintext, { level: 6 });
  const encrypted = zipCryptoEncrypt(compressed, password, entryCrc);
  const name = new TextEncoder().encode("synthetic.prcl");

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

// The `protocol2` example from prcl.md §2 — a hold/cycle protocol with a plate read, matching
// the committed .pcrd sample's actual protocol.
const PROTOCOL2_XML = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<protocol2 lidTemperature="105" useDefaultLidTemperature="False" shutoffLidEnabled="False"
           shutoffTemperature="30" volume="20" isRealTime="True" isEmailWhenComplete="False"
           runDefinition="METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 95.0,10;TEMP 60.0,30;PLATEREAD #h3F;GOTO 3,44;END;">
  <identifier identityKey="Unknown.prcl" />
  <header tag="TCT" name="Unknown.prcl" currentVersion="06.00" />
  <protocol2BaseList>
    <TemperatureStep temperatureStepTemp="95" temperatureStepHoldTime="60" temperatureStepNumber="0" />
    <TemperatureStep temperatureStepTemp="95" temperatureStepHoldTime="10" temperatureStepNumber="1" />
    <TemperatureStep temperatureStepTemp="60" temperatureStepHoldTime="30" temperatureStepNumber="2">
      <PlateReadOption optionId="PlateReadOption" />
    </TemperatureStep>
    <GotoStep optionGotoCycle="44" optionGotoStep="1" optionGotoStepNumber="3" />
  </protocol2BaseList>
</protocol2>`;

// A melt-curve protocol, matching the `56.5 + 7 × 5 = 91.5` example from prcl.md §2.3.
const MELT_PROTOCOL2_XML = `<protocol2 lidTemperature="105" volume="25" runDefinition="METHOD CALC;END;">
  <identifier identityKey="Melt.prcl" />
  <protocol2BaseList>
    <TemperatureStep temperatureStepTemp="56.5" temperatureStepHoldTime="31" temperatureStepNumber="0" />
    <MeltCurveStep meltCurveStartTemp="56.5" meltCurveHoldTime="5"
                   meltCurveTemperatureIncrement="5" meltCurveStepNumber="1">
      <PlateReadOption optionId="PlateReadOption" />
    </MeltCurveStep>
    <GotoStep optionGotoCycle="7" optionGotoStep="1" optionGotoStepNumber="2" />
  </protocol2BaseList>
</protocol2>`;

const PLAINTEXT_PRCL = `[ProtocolRunDefinition version 06.00]METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 12.0,0;END`;

describe("parseProtocol2 — structured XML parsing", () => {
  it("parses root attributes, identity, and header", () => {
    const doc = parseProtocol2(PROTOCOL2_XML);
    expect(doc.lidTemperatureC).toBe(105);
    expect(doc.useDefaultLidTemperature).toBe(false);
    expect(doc.shutoffLidEnabled).toBe(false);
    expect(doc.shutoffTemperatureC).toBe(30);
    expect(doc.volumeUl).toBe(20);
    expect(doc.isRealTime).toBe(true);
    expect(doc.isEmailWhenComplete).toBe(false);
    expect(doc.name).toBe("Unknown.prcl");
    expect(doc.meta.tag).toBe("TCT");
    expect(doc.runDefinition).toContain("PLATEREAD #h3F");
  });

  it("parses the ordered step list with 0-based step numbers", () => {
    const steps = parseProtocol2(PROTOCOL2_XML).steps!;
    expect(steps).toHaveLength(4);
    expect(steps[0]).toEqual({
      kind: "temperature",
      stepNumber: 0,
      tempC: 95,
      holdSeconds: 60,
      plateRead: false,
    });
    expect(steps[2]).toMatchObject({
      kind: "temperature",
      stepNumber: 2,
      tempC: 60,
      holdSeconds: 30,
      plateRead: true,
    });
    expect(steps[3]).toEqual({
      kind: "goto",
      stepNumber: 3,
      targetStep: 1,
      repeats: 44,
    });
  });

  it("derives MeltCurveStep.endTempC from the closing GotoStep (prcl.md §2.3)", () => {
    const steps = parseProtocol2(MELT_PROTOCOL2_XML).steps!;
    const melt = steps.find((s) => s.kind === "melt")!;
    expect(melt.startTempC).toBe(56.5);
    expect(melt.incrementC).toBe(5);
    expect(melt.endTempC).toBeCloseTo(91.5, 5); // 56.5 + 7 * 5
    expect(melt.plateRead).toBe(true);
  });
});

describe("parsePrcl — plaintext variant (prcl.md §1.1)", () => {
  it("sniffs the non-ZIP form and parses runDefinition without a container", () => {
    const prcl = parsePrcl(new TextEncoder().encode(PLAINTEXT_PRCL));
    expect(prcl.container.format).toBe("text");
    expect(prcl.needsPassword).toBeUndefined();
    expect(prcl.error).toBeUndefined();
    expect(prcl.protocol!.runDefinition).toBe(
      "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 12.0,0;END",
    );
    expect(prcl.protocol!.lidTemperatureC).toBe(105);
    expect(prcl.protocol!.shutoffTemperatureC).toBe(30);
    expect(prcl.protocol!.volumeUl).toBe(25);
    expect(prcl.protocol!.steps).toBeUndefined();
  });
});

describe("parsePrcl — synthetic ZIP round trip (no real password needed)", () => {
  const password = "synthetic-test-password";
  const plaintext = new TextEncoder().encode(PROTOCOL2_XML);
  const zipBytes = buildSyntheticPrcl(plaintext, password);

  it("reports needsPassword (no protocol) when no password is supplied", () => {
    const prcl = parsePrcl(zipBytes);
    expect(prcl.container.format).toBe("zip");
    expect(prcl.container.innerName).toBe("synthetic.prcl");
    expect(prcl.container.compressionMethod).toBe(8);
    expect(prcl.needsPassword).toBe(true);
    expect(prcl.protocol).toBeUndefined();
  });

  it("decrypts, inflates, and parses the protocol", () => {
    const prcl = parsePrcl(zipBytes, { password });
    expect(prcl.error).toBeUndefined();
    expect(prcl.protocol!.name).toBe("Unknown.prcl");
    expect(prcl.protocol!.steps).toHaveLength(4);
  });

  it("reports an error (not needsPassword) on a wrong password", () => {
    const prcl = parsePrcl(zipBytes, { password: "wrong" });
    expect(prcl.needsPassword).toBeUndefined();
    expect(prcl.protocol).toBeUndefined();
    expect(prcl.error).toBeDefined();
  });
});

describe("isPrclName", () => {
  it("matches .prcl case-insensitively", () => {
    expect(isPrclName("Short Qualification_Plate_96.prcl")).toBe(true);
    expect(isPrclName("BurnIn.PRCL")).toBe(true);
    expect(isPrclName("Qualification_Plate_96.pltd")).toBe(false);
  });
});

describe("parsePcrd — embedded protocol2 via protocols()", () => {
  it("exposes the .pcrd's protocol2 subtree with no separate password", () => {
    // Reuses the same synthetic-ZIP builder as pcrd-synthetic.test.ts, inlined here to avoid
    // a cross-file dependency for a one-off check that protocols() is wired up.
    const xml =
      `﻿<?xml version="1.0" encoding="utf-8"?><experimentalData2 exType="User">` +
      `<identifier identityKey="synthetic.pcrd" /><header currentVersion="06.10" />` +
      `${PROTOCOL2_XML.replace(/^<\?xml[^>]*>\s*/, "")}` +
      `<runData channelCount="6" wellsCount="96"><plateReadDataVector /></runData>` +
      `<protocolRunInfo><RunInfo><KeyValuePairs><Key>Identifier</Key><Value>T</Value></KeyValuePairs></RunInfo></protocolRunInfo>` +
      `</experimentalData2>`;
    const pw = "synthetic-pcrd-password";
    const bytes = buildSyntheticPrcl(new TextEncoder().encode(xml), pw);
    const pcrd = parsePcrd(bytes, { password: pw });
    expect(pcrd.error).toBeUndefined();
    const protocols = pcrd.zpcr!.protocols();
    expect(protocols).toHaveLength(1);
    expect(protocols[0]!.name).toBe("protocol2.xml");
    expect(protocols[0]!.prcl.protocol!.steps).toHaveLength(4);
    expect(protocols[0]!.prcl.needsPassword).toBeUndefined();
  });
});
