import { describe, it, expect } from "vitest";
import {
  applyWellPatches,
  formatPlateBlock,
  parsePlateBlock,
  parsePlateCsv,
  type PlateDefinition,
  type WellPatch,
} from "../src/index.js";

/** A 2×3 plate, two dyes, the first two wells of row A loaded. */
function plate(): PlateDefinition {
  return parsePlateCsv(
    [
      "# vessel: BR Clear 2x3",
      "Well,SampleType,Sample,FAM,HEX",
      "A1,unknown,S1,GeneA,+",
      "A2,ntc,S2,GeneB,",
      "",
    ].join("\r\n"),
    { sourceName: "t.plt.csv" },
  );
}

/** Paste a block onto wells starting at `at`, the way the editor anchors one. */
function pasteAt(p: PlateDefinition, text: string, at: number): PlateDefinition {
  const block = parsePlateBlock(text, p)!;
  const patches = new Map<number, WellPatch>();
  const row0 = Math.floor(at / p.columns);
  const col0 = at % p.columns;
  block.rows.forEach((cells, r) =>
    cells.forEach((patch, c) => {
      const row = row0 + r;
      const col = col0 + c;
      if (row < p.rows && col < p.columns) patches.set(row * p.columns + col, patch);
    }),
  );
  return applyWellPatches(p, patches);
}

describe("formatPlateBlock", () => {
  it("writes a header row and one line per plate row", () => {
    const text = formatPlateBlock(plate(), [0, 1]);
    expect(text.split("\n")[0]).toBe("Sample\tSampleType\tFAM\tHEX");
    expect(text.split("\n")[1]).toBe("S1\tunknown\tGeneA\t+\tS2\tntc\tGeneB\t");
  });

  it("omits the optional columns no copied well fills in", () => {
    expect(formatPlateBlock(plate(), [0]).split("\n")[0]).not.toMatch(/Vessel|Replicate|Quantity/);
  });

  it("blanks the cells of a well inside the rectangle that isn't selected", () => {
    // A1 and A3 selected: A2 is inside the bounding rectangle but not chosen, so its four cells
    // are blank — where A3, chosen but empty, still states what it is.
    const rows = formatPlateBlock(plate(), [0, 2]).split("\n");
    expect(rows[1]).toBe("S1\tunknown\tGeneA\t+\t\t\t\t\t\tempty\t\t");
  });

  it("is empty for an empty selection", () => {
    expect(formatPlateBlock(plate(), [])).toBe("");
  });
});

describe("parsePlateBlock", () => {
  it("round-trips a copied block exactly", () => {
    const p = plate();
    const copied = formatPlateBlock(p, [0, 1]);
    const next = pasteAt(p, copied, 3); // onto B1/B2
    for (const [from, to] of [[0, 3], [1, 4]]) {
      const { index, row, col, label, ...src } = next.wells[from!]!;
      const { index: i, row: r, col: c, label: l, ...dst } = next.wells[to!]!;
      expect(dst).toEqual(src);
    }
  });

  it("reads a bare column of names out of a spreadsheet as samples", () => {
    const next = pasteAt(plate(), "S9\nS10\n", 0);
    expect(next.wells[0]!.sample).toBe("S9");
    expect(next.wells[3]!.sample).toBe("S10");
    // Nothing else about the well is touched — the block named no other column.
    expect(next.wells[0]!.fluors).toHaveLength(2);
    expect(next.wells[0]!.sampleType).toBe("unknown");
  });

  it("reads a headerless two-column block as sample then type", () => {
    const next = pasteAt(plate(), "S9\tntc\n", 2);
    expect(next.wells[2]!.sample).toBe("S9");
    expect(next.wells[2]!.sampleType).toBe("ntc");
  });

  it("takes a header row's word for which column is which", () => {
    const next = pasteAt(plate(), "HEX\tSample\nRP\tS9\n", 2);
    expect(next.wells[2]!.sample).toBe("S9");
    expect(next.wells[2]!.fluors).toEqual([{ fluor: "HEX", target: "RP" }]);
  });

  it("brings a dye the plate doesn't have yet", () => {
    // The header names one column the plate knows and one it doesn't — which is what makes it
    // readable as a header at all, and what carries the new dye in.
    const next = pasteAt(plate(), "Sample\tCy5\nS9\tRP\n", 2);
    expect(next.fluors.map((f) => f.fluor)).toContain("Cy5");
    expect(next.wells[2]!.sample).toBe("S9");
    expect(next.wells[2]!.fluors).toEqual([{ fluor: "Cy5", target: "RP" }]);
  });

  it("does not mistake data for a header", () => {
    // A single cell that happens to name a column is still data when read as one row of one
    // column… but a full header row is not, which is the pair that keeps the rule honest.
    const next = pasteAt(plate(), "Sample\tSampleType\nS9\tntc\n", 2);
    expect(next.wells[2]!.sample).toBe("S9");
  });

  it("clears a field a blank cell covers", () => {
    const p = plate();
    const blank = formatPlateBlock(p, [2]); // an empty well
    const next = pasteAt(p, blank, 0);
    expect(next.wells[0]!.sample).toBeUndefined();
    expect(next.wells[0]!.loaded).toBe(false);
  });

  it("returns null for text with nothing in it", () => {
    expect(parsePlateBlock("", plate())).toBeNull();
    expect(parsePlateBlock("\n", plate())).toBeNull();
  });
});
