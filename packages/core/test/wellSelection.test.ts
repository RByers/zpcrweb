import { describe, it, expect } from "vitest";
import { parseWellLabel, parseWellSelection, wellKey, wellLabel } from "../src/index.js";

const labels = (spec: string) =>
  parseWellSelection(spec).map((k) => {
    const [row, col] = k.split(",").map(Number) as [number, number];
    return wellLabel(row, col);
  });

describe("parseWellLabel", () => {
  it("inverts wellLabel over the whole plate, reference row included", () => {
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 12; col++) {
        expect(parseWellLabel(wellLabel(row, col))).toEqual({ row, col });
      }
    }
  });

  it("accepts lower case and surrounding whitespace", () => {
    expect(parseWellLabel(" c7 ")).toEqual({ row: 2, col: 6 });
    expect(parseWellLabel("r12")).toEqual({ row: 8, col: 11 });
  });

  it("rejects anything off the plate", () => {
    for (const bad of ["", "A", "13", "A0", "A13", "I1", "S1", "A1x", "A 1", "-A1"]) {
      expect(parseWellLabel(bad)).toBeNull();
    }
  });
});

describe("parseWellSelection", () => {
  it("reads a list of single wells, in first-appearance order", () => {
    expect(labels("A1,B2,H12")).toEqual(["A1", "B2", "H12"]);
  });

  it("expands a range into the rectangle its corners bound, not reading order", () => {
    expect(labels("C4-E6")).toEqual(["C4", "C5", "C6", "D4", "D5", "D6", "E4", "E5", "E6"]);
  });

  it("takes a range's corners in either order", () => {
    expect(labels("E6-C4")).toEqual(labels("C4-E6"));
  });

  it("treats a one-well range as that well", () => {
    expect(labels("B3-B3")).toEqual(["B3"]);
  });

  it("collapses duplicates across tokens", () => {
    expect(labels("A1,A1-A2,A2")).toEqual(["A1", "A2"]);
  });

  it("accepts whitespace as a separator, and mixed case", () => {
    expect(labels("a1 b2\tc3")).toEqual(["A1", "B2", "C3"]);
  });

  it("selects the reference row like any other", () => {
    expect(labels("R1-R3")).toEqual(["R1", "R2", "R3"]);
    // A–R spans every row, sample rows and reference alike.
    expect(parseWellSelection("A1-R1")).toHaveLength(9);
  });

  it("drops unparseable tokens and keeps the rest", () => {
    expect(labels("A1,,ZZ9,B2-,-C3,D4")).toEqual(["A1", "D4"]);
  });

  it("returns nothing when nothing parses", () => {
    expect(parseWellSelection("")).toEqual([]);
    expect(parseWellSelection("all")).toEqual([]);
  });

  it("returns wellKey-shaped keys", () => {
    expect(parseWellSelection("A1")).toEqual([wellKey(0, 0)]);
  });

  it("covers the whole sample area for A1-H12", () => {
    expect(parseWellSelection("A1-H12")).toHaveLength(96);
  });
});
