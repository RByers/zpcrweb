import { describe, expect, it } from "vitest";
import {
  formatScanMaskOperand,
  parseRunDefinition,
  parseScanMask,
  parseScanMaskOperand,
  type GotoDirective,
  type HotLidDirective,
  type PlateReadDirective,
} from "../src/runDefinition.js";

/** The `.pcrd` sample's authored protocol — one cycling loop (`prcl.md` §3). */
const CYCLING =
  "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 95.0,10;TEMP 60.0,30;" +
  "PLATEREAD #h3F;GOTO 2,44;END;";

/** `samples/Short Qualification_Plate_96.prcl.xml`'s protocol: a cycling loop then a melt. */
const CYCLING_AND_MELT =
  "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 98.0,10;TEMP 98.0,5;TEMP 57.5,10;" +
  "PLATEREAD #h3F;GOTO 2,1;TEMP 56.5,31;TEMP 56.5,5;INC 5.0;RATE 5.0;PLATEREAD #h3F;" +
  "GOTO 7,7;END;";

describe("scan mask (usb.md §3.1)", () => {
  it("splits the byte into channels and sweep mode", () => {
    const all = parseScanMask(0x3f);
    expect(all.channels).toEqual([1, 2, 3, 4, 5, 6]);
    expect(all.flyover).toBe(false);
    expect(all.summary).toBe("all 6 channels, step-and-repeat");

    const fast = parseScanMask(0x81);
    expect(fast.channels).toEqual([1]);
    expect(fast.flyover).toBe(true);
    expect(fast.summary).toBe("channel 1 only, flyover scan");
    expect(fast.unknownBits).toBe(0);
  });

  it("round-trips the wire form, unpadded uppercase hex", () => {
    expect(formatScanMaskOperand(0x3f)).toBe("#h3F");
    expect(formatScanMaskOperand(0x81)).toBe("#h81");
    expect(parseScanMaskOperand("#h3F")).toBe(0x3f);
    expect(parseScanMaskOperand("#h81")).toBe(0x81);
    // RunInfo.xml records the same value in decimal (usb.md §3.1).
    expect(parseScanMaskOperand("129")).toBe(0x81);
    expect(parseScanMaskOperand("SYBR")).toBeNull();
  });
});

describe("parseRunDefinition", () => {
  it("reads the header settings the XML form exposes as attributes", () => {
    const p = parseRunDefinition(CYCLING);
    expect(p.method).toBe("CALC");
    expect(p.lidTemperatureC).toBe(105);
    expect(p.shutoffTemperatureC).toBe(30);
    expect(p.volumeUl).toBe(20);
    expect(p.unknownVerbs).toEqual([]);
  });

  it("numbers steps so GOTO's 1-based target resolves — the cycling case", () => {
    const p = parseRunDefinition(CYCLING);
    // METHOD/HOTLID/VOLUME are setup, END is a terminator: neither is a numbered step.
    expect(p.steps.map((s) => s.text)).toEqual([
      "TEMP 95.0,60",
      "TEMP 95.0,10",
      "TEMP 60.0,30",
      "PLATEREAD #h3F",
      "GOTO 2,44",
    ]);
    const goto = p.directives.find((d) => d.verb === "GOTO") as GotoDirective;
    expect(goto.targetStep).toBe(2);
    // Which the XML step list confirms: optionGotoStep="1", 0-based (prcl.md §3).
    expect(p.steps[goto.targetStep - 1]!.text).toBe("TEMP 95.0,10");
    expect(goto.description).toContain("TEMP 95.0,10");
    expect(goto.description).toContain("45 passes");
  });

  it("numbers PLATEREAD/INC/RATE as steps too — the melt case, where GOTO 7 needs it", () => {
    const p = parseRunDefinition(CYCLING_AND_MELT);
    const gotos = p.directives.filter((d): d is GotoDirective => d.verb === "GOTO");
    expect(gotos.map((g) => g.targetStep)).toEqual([2, 7]);
    expect(p.steps[gotos[0]!.targetStep - 1]!.text).toBe("TEMP 98.0,5");
    // Step 7 is only the melt's per-pass hold if the PLATEREAD and the first GOTO were
    // themselves numbered — the measurement behind protocol.md §4.
    expect(p.steps[gotos[1]!.targetStep - 1]!.text).toBe("TEMP 56.5,5");
  });

  it("decodes each directive's operands and describes it", () => {
    const p = parseRunDefinition(CYCLING);
    const hotlid = p.directives.find((d): d is HotLidDirective => d.verb === "HOTLID")!;
    expect(hotlid.stepNumber).toBeUndefined();
    expect(hotlid.description).toBe("Heated lid at 105 °C, off below 30 °C");

    const read = p.directives.find((d): d is PlateReadDirective => d.verb === "PLATEREAD")!;
    expect(read.scanMask!.raw).toBe(0x3f);
    expect(read.description).toBe("Read the plate — all 6 channels, step-and-repeat");
    expect(p.scanMasks.map((m) => m.raw)).toEqual([0x3f]);

    const temp = p.steps[0]!;
    expect(temp.description).toBe("Hold 95 °C for 60 s");
    expect(p.directives.every((d) => d.description.length > 0)).toBe(true);
  });

  it("reads a zero hold as an indefinite one (BurnIn.prcl's TEMP 12.0,0)", () => {
    const p = parseRunDefinition("METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 12.0,0;END");
    expect(p.steps[0]!.description).toBe("Hold 12 °C indefinitely");
  });

  it("keeps an unrecognized directive rather than dropping it", () => {
    const p = parseRunDefinition("METHOD CALC;WOBBLE 3;END;");
    expect(p.unknownVerbs).toEqual(["WOBBLE"]);
    expect(p.directives.map((d) => d.verb)).toEqual(["METHOD", "UNKNOWN", "END"]);
  });

  it("accepts the line-per-directive text form's layout", () => {
    const p = parseRunDefinition("METHOD CALC;\nHOTLID 105,30;\nTEMP 95.0,10;\nEND;\n");
    expect(p.lidTemperatureC).toBe(105);
    expect(p.steps).toHaveLength(1);
  });
});
