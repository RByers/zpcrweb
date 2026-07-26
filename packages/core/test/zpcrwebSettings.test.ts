import { describe, it, expect } from "vitest";
import {
  attachPlateToZpcr,
  formatZpcrwebSettings,
  hasZpcrwebSettings,
  parseZpcr,
  parseZpcrwebSettings,
  parseZpcrwebSettingsJson,
  plateToCsv,
  writeZpcrwebSettings,
  ZPCRWEB_SETTINGS_NAME,
  ZPCRWEB_SETTINGS_VERSION,
  type ZpcrwebSettings,
} from "../src/index.js";
import { readSampleBytes } from "./sample.js";

const SETTINGS: ZpcrwebSettings = {
  version: ZPCRWEB_SETTINGS_VERSION,
  generator: "zpcrweb test",
  analysis: {
    thresholdOverrides: { FAM: 120.5, "Texas Red": 49 },
    curveThresholdOverrides: { "3,2,Texas Red": 120, "0,0,FAM": 88.25 },
    thresholdMultiplier: 32,
    subtractDark: true,
    calibrationNormalization: "column",
  },
};

describe("zpcrweb.json in a .zpcr archive", () => {
  it("round-trips through writeZpcrwebSettings → parseZpcr → parseZpcrwebSettings", () => {
    const augmented = writeZpcrwebSettings(readSampleBytes(), SETTINGS);
    const zpcr = parseZpcr(augmented);
    expect(zpcr.archive.entries).toContain(ZPCRWEB_SETTINGS_NAME);
    expect(parseZpcrwebSettings(zpcr)).toEqual(SETTINGS);
  });

  it("leaves the rest of the archive, and everything parseZpcr derives, untouched", () => {
    const original = parseZpcr(readSampleBytes());
    const zpcr = parseZpcr(writeZpcrwebSettings(readSampleBytes(), SETTINGS));

    // Same entries plus exactly one.
    expect(zpcr.archive.entries.filter((e) => e !== ZPCRWEB_SETTINGS_NAME).sort()).toEqual(
      original.archive.entries.slice().sort(),
    );
    // Byte-identical payloads for every pre-existing entry.
    for (const name of original.archive.entries) {
      expect(zpcr.archive.bytes(name)).toEqual(original.archive.bytes(name));
    }
    expect(zpcr.metadata).toEqual(original.metadata);
    expect(zpcr.reads.length).toBe(original.reads.length);
    expect(zpcr.curves({ includeReference: false })).toEqual(
      original.curves({ includeReference: false }),
    );
  });

  it("replaces an existing entry rather than accumulating them", () => {
    const once = writeZpcrwebSettings(readSampleBytes(), SETTINGS);
    const twice = writeZpcrwebSettings(once, {
      version: ZPCRWEB_SETTINGS_VERSION,
      analysis: { thresholdMultiplier: 10 },
    });
    const zpcr = parseZpcr(twice);
    expect(zpcr.archive.entries.filter((e) => e === ZPCRWEB_SETTINGS_NAME)).toHaveLength(1);
    expect(parseZpcrwebSettings(zpcr)?.analysis).toEqual({ thresholdMultiplier: 10 });
  });

  it("survives a later attachPlateToZpcr, and vice versa", () => {
    const withSettings = writeZpcrwebSettings(readSampleBytes(), SETTINGS);
    const withPlate = attachPlateToZpcr(withSettings, {
      name: "MyPlate.csv",
      bytes: new TextEncoder().encode(plateToCsv(parseZpcr(withSettings).plates()[0]!.pltd.plate!)),
    });
    expect(parseZpcrwebSettings(parseZpcr(withPlate))).toEqual(SETTINGS);
  });

  it("returns null for a file with no settings entry", () => {
    expect(parseZpcrwebSettings(parseZpcr(readSampleBytes()))).toBeNull();
  });

  it("writes human-readable JSON with a trailing newline", () => {
    const text = formatZpcrwebSettings(SETTINGS);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "analysis": {');
    expect(JSON.parse(text)).toEqual(SETTINGS);
  });
});

describe("parseZpcrwebSettingsJson", () => {
  it("rejects documents that aren't objects", () => {
    for (const text of ["", "not json", "[]", '"hello"', "null", "7"]) {
      expect(parseZpcrwebSettingsJson(text)).toBeNull();
    }
  });

  it("defaults a missing version and drops an unknown top-level key", () => {
    const parsed = parseZpcrwebSettingsJson('{"somethingNew": {"a": 1}}');
    expect(parsed).toEqual({ version: ZPCRWEB_SETTINGS_VERSION });
  });

  it("keeps the valid fields of a partly-corrupt analysis block", () => {
    const parsed = parseZpcrwebSettingsJson(
      JSON.stringify({
        version: 99,
        analysis: {
          thresholdOverrides: { FAM: 120, HEX: "nope", ROX: -3, CY5: null, "": 5, VIC: 7 },
          curveThresholdOverrides: { "0,0,FAM": 12, "1,1,HEX": 0 },
          thresholdMultiplier: "40",
          subtractDark: "true",
          calibrationNormalization: "sideways",
        },
      }),
    );
    // A newer version number is honored as-is: field-level validation is what protects us.
    expect(parsed).toEqual({
      version: 99,
      analysis: {
        thresholdOverrides: { FAM: 120, VIC: 7 },
        curveThresholdOverrides: { "0,0,FAM": 12 },
      },
    });
  });

  it("drops an analysis block that survives validation with nothing in it", () => {
    expect(parseZpcrwebSettingsJson('{"analysis": {"thresholdMultiplier": 0}}')).toEqual({
      version: ZPCRWEB_SETTINGS_VERSION,
    });
    expect(parseZpcrwebSettingsJson('{"analysis": []}')).toEqual({
      version: ZPCRWEB_SETTINGS_VERSION,
    });
  });

  it("hasZpcrwebSettings distinguishes an empty document from a meaningful one", () => {
    expect(hasZpcrwebSettings({ version: 1 })).toBe(false);
    expect(hasZpcrwebSettings({ version: 1, analysis: {} })).toBe(false);
    expect(hasZpcrwebSettings({ version: 1, analysis: { subtractDark: false } })).toBe(true);
  });
});
