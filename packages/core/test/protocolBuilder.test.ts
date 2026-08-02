import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProtocolBuilder, ProtocolBuilderError } from "../src/protocolBuilder.js";
import { parseRunDefinition } from "../src/runDefinition.js";
import { parseZpcr } from "../src/zpcr.js";

const SAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../samples");

/** The `.pcrd` sample's authored protocol — one cycling loop (`prcl.md` §3). */
const CYCLING =
  "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 95.0,10;TEMP 60.0,30;" +
  "PLATEREAD #h3F;GOTO 2,44;END;";

/** `samples/Short Qualification_Plate_96.prcl.xml`'s protocol: a cycling loop then a melt. */
const CYCLING_AND_MELT =
  "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 98.0,10;TEMP 98.0,5;TEMP 57.5,10;" +
  "PLATEREAD #h3F;GOTO 2,1;TEMP 56.5,31;TEMP 56.5,5;INC 5.0;RATE 5.0;PLATEREAD #h3F;" +
  "GOTO 7,7;END;";

describe("ProtocolBuilder — reading", () => {
  it("round-trips a cycling protocol byte for byte", () => {
    expect(ProtocolBuilder.fromRunDefinition(CYCLING).toRunDefinition()).toBe(CYCLING);
  });

  it("round-trips a melt curve, modifiers and all (protocol.md §6)", () => {
    expect(ProtocolBuilder.fromRunDefinition(CYCLING_AND_MELT).toRunDefinition()).toBe(
      CYCLING_AND_MELT,
    );
  });

  it("folds modifiers onto the step they follow rather than keeping them as steps", () => {
    const b = ProtocolBuilder.fromRunDefinition(CYCLING_AND_MELT);
    // Six text directives of the melt group, four step numbers (§4, §6) — and here two steps,
    // since INC/RATE are fields of the hold they modify.
    expect(b.stepCount).toBe(9);
    expect(b.step(6)).toEqual({
      kind: "temp",
      tempC: 56.5,
      holdSeconds: 5,
      incrementC: 5,
      rateCPerSecond: 5,
    });
  });

  it("reads the header", () => {
    expect(ProtocolBuilder.fromRunDefinition(CYCLING).header).toEqual({
      method: "CALC",
      lidTemperatureC: 105,
      shutoffTemperatureC: 30,
      volumeUl: 20,
    });
  });

  it("accepts a protocol whose END carries no semicolon (protocol.md §8)", () => {
    const bare = CYCLING.replace(/END;$/, "END");
    expect(ProtocolBuilder.fromRunDefinition(bare).toRunDefinition()).toBe(CYCLING);
  });

  it("reads back every committed `.zpcr`'s recorded protocol unchanged", () => {
    const names = readdirSync(SAMPLES).filter((n) => n.toLowerCase().endsWith(".zpcr"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const buf = readFileSync(resolve(SAMPLES, name));
      const zpcr = parseZpcr(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      const text = zpcr.protocolText;
      if (!text) continue;
      const rewritten = ProtocolBuilder.fromRunDefinition(text).toRunDefinition();
      // The recorded text varies in terminator and whitespace by carrier (§8), so what has to
      // match is the decoded directive list, not the bytes.
      expect(parseRunDefinition(rewritten).directives.map((d) => d.text), name).toEqual(
        parseRunDefinition(text).directives.map((d) => d.text),
      );
    }
  });

  it("refuses text it could not write back", () => {
    const cases: [string, RegExp][] = [
      ["METHOD CALC;TEMP 95.0,10;WIGGLE 3;END;", /Unrecognized directive/],
      ["METHOD CALC;INC 1.0;TEMP 95.0,10;END;", /no step to modify/],
      ["METHOD CALC;GRAD 55.0,65.0,30;INC 1.0;END;", /can't modify a GRAD step/],
      ["METHOD CALC;TEMP 95.0,10;PLATEREAD #h07;END;", /isn't one of the configurations/],
      ["METHOD CALC;TEMP 95.0,10;END;TEMP 60.0,30;END;", /comes after END/],
      ["METHOD CALC;TEMP nine,10;END;", /isn't a number/],
      ["METHOD FRED;TEMP 95.0,10;END;", /Unknown thermal control method/],
      // A GOTO can only go backwards, and not onto another GOTO.
      ["METHOD CALC;TEMP 95.0,10;GOTO 2,4;END;", /can't represent/],
      ["METHOD CALC;TEMP 95.0,10;GOTO 1,4;GOTO 2,4;END;", /can't represent/],
    ];
    for (const [text, message] of cases) {
      expect(() => ProtocolBuilder.fromRunDefinition(text), text).toThrow(ProtocolBuilderError);
      expect(() => ProtocolBuilder.fromRunDefinition(text), text).toThrow(message);
    }
  });

  it("reports rather than throws through tryFromRunDefinition", () => {
    expect(ProtocolBuilder.tryFromRunDefinition(CYCLING).builder).toBeInstanceOf(ProtocolBuilder);
    expect(ProtocolBuilder.tryFromRunDefinition("METHOD CALC;WIGGLE;END;").error).toMatch(
      /Unrecognized/,
    );
  });
});

describe("ProtocolBuilder — editing", () => {
  const cycling = () => ProtocolBuilder.fromRunDefinition(CYCLING);

  it("is immutable: an edit returns a new builder and leaves the old one alone", () => {
    const before = cycling();
    const after = before.withHeader({ volumeUl: 25 });
    expect(before.header.volumeUl).toBe(20);
    expect(after.header.volumeUl).toBe(25);
    expect(before.toRunDefinition()).toBe(CYCLING);
  });

  it("renumbers a GOTO's target when a step is inserted above it", () => {
    const b = cycling().withInsertedStep(0, { kind: "temp", tempC: 50, holdSeconds: 120 });
    expect(b.toRunDefinition()).toBe(
      "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 50.0,120;TEMP 95.0,60;TEMP 95.0,10;" +
        "TEMP 60.0,30;PLATEREAD #h3F;GOTO 3,44;END;",
    );
  });

  it("leaves a GOTO alone when the insertion is below its target", () => {
    // A plate read added at the end of the loop body: the target (step 2) doesn't move.
    const b = cycling().withInsertedStep(3, { kind: "plateread", scan: { channels: "ch1", flyover: true } });
    expect(b.toRunDefinition()).toContain("PLATEREAD #h81;PLATEREAD #h3F;GOTO 2,44;");
  });

  it("renumbers a GOTO's target when a step above it is deleted", () => {
    const b = cycling().withoutStep(0);
    expect(b.toRunDefinition()).toBe(
      "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,10;TEMP 60.0,30;PLATEREAD #h3F;GOTO 1,44;END;",
    );
  });

  it("follows the step list when a GOTO's own target is deleted", () => {
    // Deleting step 2 (`TEMP 95.0,10`) leaves the loop pointing at what took its place.
    const b = cycling().withoutStep(1);
    expect(b.toRunDefinition()).toBe(
      "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 60.0,30;PLATEREAD #h3F;GOTO 2,44;END;",
    );
  });

  it("drops a GOTO left with nowhere legal to jump", () => {
    // Delete every step above the GOTO: it would become step 1, which no target can precede.
    let b = cycling();
    b = b.withoutStep(0).withoutStep(0).withoutStep(0).withoutStep(0);
    expect(b.steps).toEqual([]);
    expect(b.toRunDefinition()).toBe("METHOD CALC;HOTLID 105,30;VOLUME 20;END;");
  });

  it("never lets END be moved or removed — it isn't a step at all", () => {
    const b = cycling();
    expect(b.steps.some((s) => (s as { kind: string }).kind === "end")).toBe(false);
    // Appending still writes END last.
    expect(
      b.withAppendedStep({ kind: "temp", tempC: 12, holdSeconds: 0 }).toRunDefinition(),
    ).toMatch(/TEMP 12\.0,0;END;$/);
    // As does deleting everything.
    let empty = ProtocolBuilder.empty();
    expect(empty.toRunDefinition()).toBe("METHOD CALC;HOTLID 105,30;VOLUME 20;END;");
    empty = empty.withoutStep(0).withoutStep(-1);
    expect(empty.toRunDefinition()).toBe("METHOD CALC;HOTLID 105,30;VOLUME 20;END;");
  });

  it("offers only earlier non-GOTO steps as GOTO targets", () => {
    const b = cycling();
    expect(b.legalGotoTargets(0)).toEqual([]);
    expect(b.legalGotoTargets(4)).toEqual([1, 2, 3, 4]);
    // Step 5 is the GOTO itself, so a second GOTO after it may not target it.
    expect(b.withAppendedStep({ kind: "temp", tempC: 12, holdSeconds: 0 }).legalGotoTargets(6)).toEqual([
      1, 2, 3, 4, 6,
    ]);
    expect(b.canInsert("goto", 0)).toBe(false);
    expect(b.canInsert("goto", 1)).toBe(true);
    expect(b.canInsert("temp", 0)).toBe(true);
  });

  it("clamps a GOTO target that an edit put out of reach", () => {
    // Retarget the loop at step 4, then delete steps 3 and 4: nothing legal remains at 4.
    let b = cycling().withStep(4, { kind: "goto", targetStep: 4, repeats: 9 });
    b = b.withoutStep(3).withoutStep(2);
    const goto = b.steps[b.stepCount - 1] as { kind: string; targetStep: number };
    expect(goto.kind).toBe("goto");
    expect(goto.targetStep).toBe(2);
    expect(b.toRunDefinition()).toBe(
      "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 95.0,10;GOTO 2,9;END;",
    );
  });

  it("writes the operand formats of protocol.md §3.3", () => {
    const b = ProtocolBuilder.empty()
      .withHeader({ method: "BLOCK", lidTemperatureC: 0, shutoffTemperatureC: 30, volumeUl: 0 })
      .withAppendedStep({ kind: "grad", lowTempC: 55, highTempC: 65, holdSeconds: 30, extendSeconds: -5 })
      .withAppendedStep({ kind: "temp", tempC: 95, holdSeconds: 10, incrementC: 0.5, rateCPerSecond: 0.5, beep: true })
      .withAppendedStep({
        kind: "melt",
        startTempC: 65,
        endTempC: 95,
        incrementC: 0.5,
        holdSeconds: 5,
        scan: { channels: "ch1", flyover: true },
      });
    expect(b.toRunDefinition()).toBe(
      "METHOD BLOCK;HOTLID 0,30;VOLUME 0;GRAD 55.0,65.0,30;EXT -5;TEMP 95.0,10;INC 0.5;" +
        "RATE 0.5;BEEP;MELT 65.0,95.0,0.5,5,#h81;END;",
    );
    // And reads its own output back unchanged.
    expect(ProtocolBuilder.fromRunDefinition(b.toRunDefinition()).toRunDefinition()).toBe(
      b.toRunDefinition(),
    );
  });

  it("keeps step numbers equal to positions, so the text renumbers itself", () => {
    const program = parseRunDefinition(
      cycling().withInsertedStep(2, { kind: "plateread", scan: { channels: "all6", flyover: false } }).toRunDefinition(),
    );
    expect(program.steps.map((s) => s.stepNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("ProtocolBuilder — validation", () => {
  it("passes every committed protocol", () => {
    expect(ProtocolBuilder.fromRunDefinition(CYCLING).validate()).toEqual([]);
    expect(ProtocolBuilder.fromRunDefinition(CYCLING_AND_MELT).validate()).toEqual([]);
  });

  it("reports operands outside protocol.md §3.5's limits", () => {
    const messages = (b: ProtocolBuilder) => b.validate().map((i) => i.message);
    expect(
      messages(ProtocolBuilder.empty().withAppendedStep({ kind: "temp", tempC: 120, holdSeconds: 10 })),
    ).toEqual([expect.stringContaining("Temperature must be between 0 and 100")]);
    expect(
      messages(
        ProtocolBuilder.empty().withAppendedStep({
          kind: "grad",
          lowTempC: 55,
          highTempC: 95,
          holdSeconds: 30,
        }),
      ),
    ).toEqual([expect.stringContaining("spread")]);
    expect(
      messages(ProtocolBuilder.empty().withHeader({ volumeUl: 500 })),
    ).toEqual([expect.stringContaining("Volume must be between 0 and 125")]);
    expect(
      messages(
        ProtocolBuilder.empty().withAppendedStep({
          kind: "melt",
          startTempC: 95,
          endTempC: 65,
          incrementC: 0.5,
          holdSeconds: 5,
          scan: { channels: "all6", flyover: false },
        }),
      ),
    ).toEqual([expect.stringContaining("end temperature must be above the start")]);
  });
});
