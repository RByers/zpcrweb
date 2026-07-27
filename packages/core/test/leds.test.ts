import { describe, it, expect } from "vitest";
import { extractLeds, ledChannel, ledLabel, parseZpcr } from "../src/index.js";
import type { IcffEntry } from "../src/index.js";
import { readMultistepBytes, readSampleBytes } from "./sample.js";

/** Build a minimal ICFF entry for the label/decoding unit tests. */
function field(name: string, extra: Partial<IcffEntry> = {}): IcffEntry {
  return { name, offset: 1, length: 4, flag: 1, hex: "", ...extra };
}

describe("plateread LED currents", () => {
  const zpcr = parseZpcr(readSampleBytes());
  const last = zpcr.reads.at(-1)!;

  it("extracts one field per optical channel, in file order", () => {
    expect(last.leds.map((l) => l.key)).toEqual([
      "LEDCURRENT01",
      "LEDCURRENT02",
      "LEDCURRENT03",
      "LEDCURRENT04",
      "LEDCURRENT05",
      "LEDCURRENT06",
    ]);
    expect(last.leds.map((l) => l.channel)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(last.leds.map((l) => l.label)).toEqual(["Ch1", "Ch2", "Ch3", "Ch4", "Ch5", "Ch6"]);
  });

  it("decodes the DAC settings as big-endian ints matching RunInfo's LEDDACValsCal", () => {
    expect(last.leds.map((l) => l.dac)).toEqual([92, 97, 76, 123, 185, 161]);
    // The same six values RunInfo.xml records as the calibrated drive settings.
    expect(zpcr.metadata.raw["LEDDACValsCal"]).toBe("92,97,76,123,185,161");
  });
});

describe("LED current curves", () => {
  const zpcr = parseZpcr(readSampleBytes());

  it("yields one series per field, aligned with the cycles", () => {
    const curves = zpcr.ledCurves();
    expect(curves.map((c) => c.key)).toEqual([
      "LEDCURRENT01",
      "LEDCURRENT02",
      "LEDCURRENT03",
      "LEDCURRENT04",
      "LEDCURRENT05",
      "LEDCURRENT06",
    ]);
    const first = curves[0]!;
    expect(first.label).toBe("Ch1");
    expect(first.channel).toBe(0);
    expect(first.cycles).toEqual(zpcr.reads.map((r) => r.cycle));
    expect(first.dac).toHaveLength(zpcr.reads.length);
  });

  it("holds each channel's drive setting constant across a healthy run", () => {
    // These are calibration settings, not measurements — a step in one would mean the
    // instrument re-drove that LED mid-run, which is the reason to plot them at all.
    for (const c of zpcr.ledCurves()) {
      expect(new Set(c.dac).size).toBe(1);
    }
  });

  it("filters to a single protocol step", () => {
    const multi = parseZpcr(readMultistepBytes());
    expect(multi.ledCurves(2)[0]!.cycles).toHaveLength(2);
    expect(multi.ledCurves(4)[0]!.cycles).toHaveLength(8);
  });
});

describe("LED field naming", () => {
  it("labels a field by the channel it drives", () => {
    expect(ledLabel("LEDCURRENT01")).toBe("Ch1");
    expect(ledLabel("LEDCURRENT06")).toBe("Ch6");
    expect(ledChannel("LEDCURRENT03")).toBe(2);
  });

  it("keeps an unrecognized LED field readable rather than inventing a channel", () => {
    expect(ledLabel("LEDCURRENTAUX")).toBe("LEDCURRENTAUX");
    expect(ledChannel("LEDCURRENTAUX")).toBeUndefined();
    expect(ledChannel("LEDCURRENT00")).toBeUndefined();
  });

  it("picks up a firmware emitting more channels with no code change", () => {
    const leds = extractLeds(
      Array.from({ length: 8 }, (_, i) =>
        field(`LEDCURRENT0${i + 1}`, { int: 100 + i }),
      ),
    );
    expect(leds).toHaveLength(8);
    expect(leds.at(-1)).toMatchObject({ key: "LEDCURRENT08", label: "Ch8", channel: 7, dac: 107 });
  });

  it("ignores non-LED and implausible fields", () => {
    expect(
      extractLeds([
        field("CYCLE", { int: 45 }),
        field("BLOCKTEMP", { float: 59.99, int: 1_113_927_680 }),
        // A float32 reinterpreted as int32 — in the billions, so not a DAC count.
        field("LEDCURRENT01", { int: 1_113_927_680 }),
        field("LEDCURRENT02", { int: -1 }),
        field("LEDDACSTRING", { length: 12, text: "92,97,76" }),
      ]),
    ).toEqual([]);
  });
});
