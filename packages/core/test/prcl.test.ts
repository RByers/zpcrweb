import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  formatRunDefinitionText,
  isPrclName,
  parsePcrd,
  parsePrcl,
  parseProtocol2,
  parseRunDefinitionText,
  parseZpcr,
} from "../src/index.js";
import { readMultistepBytes } from "./sample.js";
import { readCfxPassword } from "./secrets.js";
import { TEST_PASSWORD, buildEncryptedZip } from "./zipCrypto.js";

const here = dirname(fileURLToPath(import.meta.url));
function sampleText(name: string): string {
  return readFileSync(resolve(here, "../../../samples", name), "utf-8");
}
const PW = readCfxPassword();

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
  const password = TEST_PASSWORD;
  const plaintext = new TextEncoder().encode(PROTOCOL2_XML);
  const zipBytes = buildEncryptedZip(plaintext, password, "synthetic.prcl");

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

// The decoded protocol structure is exercised against the plaintext XML extracted from a real
// sample (committed as samples/Short Qualification_Plate_96.prcl.xml) — no decryption, no
// secret needed. Only the pipeline test below (decrypt → inflate) needs the real password.
describe("parseProtocol2 — real sample (plaintext, no secret needed)", () => {
  const doc = parseProtocol2(sampleText("Short Qualification_Plate_96.prcl.xml"));

  it("parses root attributes and identity", () => {
    expect(doc.name).toBe("Short Qualification_Plate_96.prcl");
    expect(doc.lidTemperatureC).toBe(105);
    expect(doc.volumeUl).toBe(20);
    expect(doc.runDefinition).toContain("PLATEREAD #h3F");
  });

  it("parses the ordered step list, including a melt step with an explicit end temp", () => {
    const steps = doc.steps!;
    expect(steps).toHaveLength(5);
    expect(steps[2]).toMatchObject({ kind: "temperature", tempC: 57.5, plateRead: true });
    expect(steps[3]).toEqual({ kind: "goto", stepNumber: 3, targetStep: 1, repeats: 1 });
    expect(steps[4]).toMatchObject({
      kind: "melt",
      startTempC: 56.5,
      endTempC: 91.5,
      incrementC: 5,
    });
  });
});

describe.skipIf(!PW)("prcl — decryption pipeline (requires secrets.json)", () => {
  it("decrypts the real .prcl entry to the same plaintext committed in samples/", () => {
    const prcl = parseZpcr(readMultistepBytes()).protocols(PW)[0]!.prcl;
    expect(prcl.xml).toBe(sampleText("Short Qualification_Plate_96.prcl.xml"));
  });
});

describe("isPrclName", () => {
  it("matches .prcl case-insensitively", () => {
    expect(isPrclName("Short Qualification_Plate_96.prcl")).toBe(true);
    expect(isPrclName("BurnIn.PRCL")).toBe(true);
    expect(isPrclName("Qualification_Plate_96.pltd")).toBe(false);
  });
});

describe("parsePcrd — protocol2 exposure", () => {
  // A one-off check of how a .pcrd surfaces its embedded protocol2, built with the same shared
  // synthetic-ZIP helper pcrd-synthetic.test.ts uses.
  const xml =
    `﻿<?xml version="1.0" encoding="utf-8"?><experimentalData2 exType="User">` +
    `<identifier identityKey="synthetic.pcrd" /><header currentVersion="06.10" />` +
    `${PROTOCOL2_XML.replace(/^<\?xml[^>]*>\s*/, "")}` +
    `<runData channelCount="6" wellsCount="96"><plateReadDataVector /></runData>` +
    `<protocolRunInfo><RunInfo><KeyValuePairs><Key>Identifier</Key><Value>T</Value></KeyValuePairs></RunInfo></protocolRunInfo>` +
    `</experimentalData2>`;
  const pw = "synthetic-pcrd-password";
  const bytes = buildEncryptedZip(new TextEncoder().encode(xml), pw, "synthetic.pcrd");

  it("exposes the runDefinition text via protocolText, with no separate password", () => {
    const pcrd = parsePcrd(bytes, { password: pw });
    expect(pcrd.error).toBeUndefined();
    expect(pcrd.zpcr!.protocolText).toContain("PLATEREAD #h3F");
  });

  it("does not typed-decode a PrclEntry for the embedded protocol2 (no separate file)", () => {
    const pcrd = parsePcrd(bytes, { password: pw });
    expect(pcrd.zpcr!.protocols()).toEqual([]);
  });
});

describe("the .prcl.txt text form (prcl.md §1.1, §3)", () => {
  const oneLine = "METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 95.0,10;PLATEREAD #h3F;GOTO 4,39;END;";

  it("formats one directive per line under a plaintext header", () => {
    expect(formatRunDefinitionText(oneLine)).toBe(
      "[ProtocolRunDefinition version 06.00]\n" +
        "METHOD CALC;\nHOTLID 105,30;\nVOLUME 25;\nTEMP 95.0,10;\n" +
        "PLATEREAD #h3F;\nGOTO 4,39;\nEND;\n",
    );
  });

  it("round-trips back to the canonical one-line form", () => {
    expect(parseRunDefinitionText(formatRunDefinitionText(oneLine))).toBe(oneLine);
  });

  // The written file is a real plaintext .prcl, not merely a listing of its lines — so the
  // existing sniffing parser reads it back with no new code path (prcl.md §1.1).
  it("is itself a plaintext .prcl that parsePrcl accepts", () => {
    const prcl = parsePrcl(new TextEncoder().encode(formatRunDefinitionText(oneLine)));
    expect(prcl.container.format).toBe("text");
    expect(prcl.protocol!.lidTemperatureC).toBe(105);
    expect(prcl.protocol!.volumeUl).toBe(25);
  });

  it("accepts a header-less list of directives, and an instrument's own single line", () => {
    expect(parseRunDefinitionText("METHOD CALC;\nHOTLID 105,30;\nEND;\n")).toBe(
      "METHOD CALC;HOTLID 105,30;END;",
    );
    expect(parseRunDefinitionText("METHOD CALC;HOTLID 105,30;END\r\n")).toBe(
      "METHOD CALC;HOTLID 105,30;END;",
    );
  });

  it("rejects text that is not a protocol, naming the offending directive", () => {
    expect(() => parseRunDefinitionText("")).toThrow(/no protocol directives/i);
    expect(() => parseRunDefinitionText("<?xml version=\"1.0\"?>\n<protocol2 />")).toThrow(
      /not a thermal protocol/i,
    );
  });
});
