import { describe, it, expect } from "vitest";
import { parsePcrd } from "../src/index.js";
import { TEST_PASSWORD, buildEncryptedZip } from "./zipCrypto.js";

/**
 * A small, hand-built `<experimentalData2>` document matching the schema `pcrd.md`
 * documents, wrapped by `zipCrypto.ts` in a real ZipCrypto-encrypted single-entry ZIP (built
 * here, not fixture data) so the full container → decrypt → inflate → parse pipeline is exercised
 * without depending on the real CFX password (which this repo does not ship — see
 * `pcrd.test.ts` for the password-gated tests against the real committed sample).
 */
function buildPlateRead(cycle: number, blockTmp: string, wellBase: number): string {
  const wellValues = Array.from({ length: 648 }, (_, i) => {
    const rec = i % 4;
    const v = wellBase + Math.floor(i / 4) + rec * 0.1;
    return v.toFixed(3);
  }).join(";");
  const darkValues = Array.from({ length: 24 }, (_, i) => (10 + i).toFixed(2)).join(";");
  return `<plateRead><PlateRead V="1"><SerVersion>2</SerVersion><Hdr><PlateReadDataHeader V="1"><SerVersion>9</SerVersion><CRC>0</CRC><HeadSerNum>SG00000</HeadSerNum><ScMode>0</ScMode><ScIdx>1</ScIdx><RtrvlType>3</RtrvlType><StepId>0</StepId><Step>2</Step><Cycle>${cycle}</Cycle><ErrNum>0</ErrNum><ErrDesc /><BlockTmp>${blockTmp}</BlockTmp><ShtTmp>44.4</ShtTmp><AmbTmp>28</AmbTmp><ChNum>0</ChNum><NumCols>12</NumCols><NumRows>9</NumRows><Time>Tue, 21 Jul 2026 05:23:17 GMT</Time><PRVersion>2</PRVersion><ChCount>6</ChCount><ChMask>63</ChMask><SamTmp>60</SamTmp><LidTmp>105</LidTmp><FanState>1</FanState><LidForce>1</LidForce><LidState>1</LidState><LidPos>0</LidPos><DrkCrnt><PAr V="1">${darkValues}</PAr></DrkCrnt><FanOffTmp>35</FanOffTmp><FanOnTmp>40</FanOnTmp><FWVersions /></PlateReadDataHeader></Hdr><Data><PAr V="1">${wellValues}</PAr></Data><Unique>0</Unique><Time>-1</Time><Name /><Interp>False</Interp></PlateRead></plateRead>`;
}

/**
 * A `<wellFactorsCollection>` with the SNR set marked saved and the flyover set not, so the
 * decoder has to pick SNR as the active one. Factor for (channel, well) is `1 + ch/10 + well/1000`,
 * distinct per cell so an indexing mistake can't pass.
 */
function buildWellFactors(): string {
  const set = (offset: number): string =>
    Array.from({ length: 6 }, (_, ch) => {
      const values = Array.from(
        { length: 108 },
        (_, well) => (offset + 1 + ch / 10 + well / 1000).toFixed(4),
      ).join(";");
      return `<Ch${ch}><PAr V="1">${values}</PAr></Ch${ch}>`;
    }).join("");
  const factors = (offset: number): string =>
    `<WellFactors V="1"><SerVersion>1</SerVersion><Channels>6</Channels>${set(offset)}</WellFactors>`;
  return (
    `<wellFactorsCollection><WellFactorsCollection V="1"><SerVersion>1</SerVersion><WFHeader>` +
    `<WellFactorsHeader V="1"><SerVersion>1</SerVersion><Channels>6</Channels><Wells>108</Wells>` +
    `<snrSaved>True</snrSaved><flyovrSaved>False</flyovrSaved><user>synthetic</user>` +
    `</WellFactorsHeader></WFHeader><SnrWF>${factors(0)}</SnrWF><FlyoverWF>${factors(10)}</FlyoverWF>` +
    `</WellFactorsCollection></wellFactorsCollection>`
  );
}

function buildSyntheticXml(): string {
  const plateSetup2 =
    `<plateSetup2 rows="8" columns="12" dyes="1" standardUnits="" plateType="OtherStdTemplate" ` +
    `scanMode="AllChannelsScan" plateName="Test Plate"><header currentVersion="06.00" /><geneNameList>` +
    `<geneName shortName="TargetA" /></geneNameList><conditionNameList />` +
    `<dyeLayersList><dyeLayer><fluor fluorName="FAM" channelPosition="0" fluorId="1" />` +
    `<wellSample plateIndex="0" wellSampleType="wcSample" wellLoadedFluor="True" geneName="TargetA" />` +
    `</dyeLayer></dyeLayersList></plateSetup2>`;
  const protocol2 =
    `<protocol2 lidTemperature="105" volume="20" ` +
    `runDefinition="METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 60.0,30;PLATEREAD #h3F;GOTO 2,1;END;" />`;
  const runInfo = `<protocolRunInfo><RunInfo>
    <KeyValuePairs><Key>Identifier</Key><Value>TEST-RUN-1234</Value></KeyValuePairs>
    <KeyValuePairs><Key>DataFile</Key><Value>synthetic.zpcr</Value></KeyValuePairs>
    <KeyValuePairs><Key>BaseSerialNumber</Key><Value>CT000000</Value></KeyValuePairs>
    <KeyValuePairs><Key>BlockDescription</Key><Value>"96FX"</Value></KeyValuePairs>
    <KeyValuePairs><Key>ScanMask</Key><Value>63</Value></KeyValuePairs>
    <KeyValuePairs><Key>NumberPlateColumns</Key><Value>12</Value></KeyValuePairs>
    <KeyValuePairs><Key>NumberPlateRows</Key><Value>8</Value></KeyValuePairs>
    <KeyValuePairs><Key>NumberReferenceRows</Key><Value>1</Value></KeyValuePairs>
  </RunInfo></protocolRunInfo>`;
  const log =
    `<log lgNm="CT000000" level="INFO" ts="2026-07-20T13:18:18.000-08:00" ` +
    `assemblyName="Satellite Service" sev="Info" data="0" tag="Unassigned" msgNm="" msg="Run started" />`;
  const reads = [buildPlateRead(1, "59.99", 1000), buildPlateRead(2, "60.01", 1100)].join("");
  const runData = `<runData channelCount="6" wellsCount="96"><calibrationCollection><CalibrationCollection V="1"><SerVersion>1</SerVersion><Fluors /></CalibrationCollection></calibrationCollection><plateReadDataVector>${reads}</plateReadDataVector></runData>`;
  const dataAnalysisParameters = `<dataAnalysisParameters V="1"><SerVersion>1</SerVersion><selectedStepNumber>2</selectedStepNumber></dataAnalysisParameters>`;

  return (
    `﻿<?xml version="1.0" encoding="utf-8"?><experimentalData2 exType="User">` +
    `<identifier identityKey="synthetic.pcrd" /><header currentVersion="06.10" createdByClientApp="BioRadCFXManager.exe" />` +
    `${plateSetup2}${protocol2}${runData}${dataAnalysisParameters}${runInfo}${log}` +
    `${buildWellFactors()}` +
    `<auditHeader user="test" /></experimentalData2>`
  );
}

describe("pcrd — synthetic round trip (no real password needed)", () => {
  const password = TEST_PASSWORD;
  const plaintext = new TextEncoder().encode(buildSyntheticXml());
  const zipBytes = buildEncryptedZip(plaintext, password, "synthetic.pcrd");

  it("decodes the container without a password", () => {
    const pcrd = parsePcrd(zipBytes);
    expect(pcrd.needsPassword).toBe(true);
    expect(pcrd.container.innerName).toBe("synthetic.pcrd");
    expect(pcrd.container.compressionMethod).toBe(8);
  });

  it("decrypts, inflates, and parses into the same shape as a .zpcr", () => {
    const pcrd = parsePcrd(zipBytes, { password });
    expect(pcrd.error).toBeUndefined();
    const zpcr = pcrd.zpcr!;

    expect(zpcr.metadata.identifier).toBe("TEST-RUN-1234");
    expect(zpcr.metadata.baseSerialNumber).toBe("CT000000");
    expect(zpcr.metadata.channelCount).toBe(6);
    expect(zpcr.reads).toHaveLength(2);
    expect(zpcr.reads[0]!.cycle).toBe(1);
    expect(zpcr.reads[0]!.blockTempC).toBeCloseTo(59.99, 2);
    expect(zpcr.reads[1]!.blockTempC).toBeCloseTo(60.01, 2);
    expect(zpcr.reads[0]!.wells).toHaveLength(6);
    expect(zpcr.reads[0]!.dark).toHaveLength(6);
    expect(zpcr.reads[0]!.wells[0]![0]![0]!.mean).toBeCloseTo(1000, 2);
  });

  it("pivots into curves/darkCurves/steps like a .zpcr", () => {
    const zpcr = parsePcrd(zipBytes, { password }).zpcr!;
    const curves = zpcr.curves();
    expect(curves.length).toBeGreaterThan(0);
    expect(curves[0]!.cycles).toEqual([1, 2]);
    expect(zpcr.darkCurves()).toHaveLength(6);
    expect(zpcr.steps()).toEqual([{ step: 2, readCount: 2 }]);
  });

  it("decodes the embedded plate via plates()", () => {
    const zpcr = parsePcrd(zipBytes, { password }).zpcr!;
    const plates = zpcr.plates();
    expect(plates).toHaveLength(1);
    expect(plates[0]!.name).toBe("plateSetup2");
    expect(plates[0]!.pltd.plate!.plateName).toBe("Test Plate");
    expect(plates[0]!.pltd.plate!.fluors).toEqual([{ fluor: "FAM", channel: 0, fluorId: "1" }]);
  });

  it("exposes the real protocol text via protocolText, not a fake archive entry", () => {
    const zpcr = parsePcrd(zipBytes, { password }).zpcr!;
    expect(zpcr.protocolText).toContain("METHOD CALC");
  });

  it("reports an honestly-empty archive — a .pcrd has no inner files", () => {
    const zpcr = parsePcrd(zipBytes, { password }).zpcr!;
    expect(zpcr.archive.entries).toEqual([]);
    expect(() => zpcr.archive.text("anything")).toThrow();
    expect(() => zpcr.archive.bytes("anything")).toThrow();
    expect(() => zpcr.archive.hexDump("anything")).toThrow();
  });

  it("exposes not-yet-decoded subtrees verbatim in the full raw document (Pcrd.xml)", () => {
    const pcrd = parsePcrd(zipBytes, { password });
    expect(pcrd.xml).toContain("<experimentalData2");
    expect(pcrd.xml).toContain("dataAnalysisParameters");
    expect(pcrd.xml).toContain("selectedStepNumber");
    expect(pcrd.xml).toContain("calibrationCollection");
  });

  it("reports an error (not needsPassword) on a wrong password", () => {
    const pcrd = parsePcrd(zipBytes, { password: "wrong" });
    expect(pcrd.needsPassword).toBeUndefined();
    expect(pcrd.error).toBeDefined();
  });

  it("decodes wellFactorsCollection, taking the saved set as the active one", () => {
    const factors = parsePcrd(zipBytes, { password }).zpcr!.wellFactors!;
    expect(factors.channelCount).toBe(6);
    expect(factors.wellCount).toBe(108);
    expect(factors.source).toBe("synthetic");
    // Only SNR is flagged saved here, so the flyover set is decoded as absent and SNR is active.
    expect(factors.snr).toBeDefined();
    expect(factors.flyover).toBeUndefined();
    expect(factors.active).toBe(factors.snr);
    expect(factors.snr![0]).toHaveLength(108);
  });

  it("indexes well factors row-major, matching the plate read's own well layout", () => {
    const factors = parsePcrd(zipBytes, { password }).zpcr!.wellFactors!;
    // Well index is row*12 + col, so B3 (row 1, col 2) is well 14.
    expect(factors.get(1, 2)).toEqual([
      1.014, 1.114, 1.214, 1.314, 1.414, 1.514,
    ]);
    // The reference row (row 8) carries factors of its own, at the end of the 108.
    expect(factors.get(8, 11)![0]).toBeCloseTo(1.107, 6);
  });
});
