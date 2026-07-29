/**
 * The one test in this repo that checks a computed number against the **instrument's own answer**.
 *
 * `samples/20260726_S183-S185_RVP-export.zip` holds the CSVs CFX Manager exported for
 * `samples/20260726_S183-S185_RVP.pcrd`: its baseline-corrected RFU per cycle per well, its Cq per
 * well, and its end-point RFU per well. Feeding CFX's *own* corrected curves into `computeCq()`
 * therefore isolates the threshold/Cq stage (`threshold.md` §5–§6) from colour separation and
 * baselining entirely — this stays green regardless of any upstream work, and it is what pins the
 * crossing rule to the instrument rather than to an argument.
 *
 * No password needed: the export is plain CSV in a plain ZIP.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync } from "fflate";
import { computeCq } from "../src/threshold.js";
import { endPointRfu } from "../src/baseline.js";

const EXPORT_PATH = resolve(__dirname, "../../../samples/20260726_S183-S185_RVP-export.zip");

/**
 * The thresholds CFX used for this run, to the precision its own output pins them at.
 *
 * FAM's is read straight out of the `.pcrd` (`thresholdOverrideValue="92.0212554931641"` on
 * `fluorId="5"`). Tex 615's is on `autoCalculateThreshold="True"`, so nothing is persisted — this
 * value was *recovered* from the reported Cq values by solving the interpolation back for the
 * threshold, which lands on the same number to 8e-13 across all three wells that have a Cq
 * (`threshold.md` §0.3). Cy5 has no well with a Cq, so its threshold is unrecoverable and it is
 * not exercised here.
 */
const CFX_THRESHOLD: Record<string, number> = {
  FAM: 92.0212554931641,
  "Tex 615": 8.06451415811512,
};

function csvRows(data: Uint8Array): string[][] {
  return new TextDecoder()
    .decode(data)
    .replace(/\r/g, "")
    .trim()
    .split("\n")
    .map((line) => line.split(","));
}

/** `A04` as CFX writes it, `A4` as the rest of this project does. */
const wellLabel = (w: string) => w.replace(/^([A-H])0?(\d+)$/, "$1$2");

interface CfxExport {
  /** `fluor` → `well` → CFX's baseline-corrected RFU, indexed by cycle 1..N. */
  curves: Map<string, Map<string, number[]>>;
  /** `fluor/well` → CFX's Cq, `null` where it reported none. */
  cq: Map<string, number | null>;
  /** `fluor/well` → CFX's end-point RFU. */
  endRfu: Map<string, number>;
  cycles: number[];
}

function readExport(): CfxExport {
  const buf = readFileSync(EXPORT_PATH);
  const zip = unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const curves = new Map<string, Map<string, number[]>>();
  const cq = new Map<string, number | null>();
  const endRfu = new Map<string, number>();
  let cycles: number[] = [];

  for (const [name, data] of Object.entries(zip)) {
    const amplification = /Amplification Results_(.+)\.csv$/.exec(name);
    if (amplification) {
      const rows = csvRows(data);
      const head = rows[0]!;
      const perWell = new Map<string, number[]>();
      for (let c = 2; c < head.length; c++) perWell.set(wellLabel(head[c]!), []);
      const seen: number[] = [];
      for (const row of rows.slice(1)) {
        seen.push(Number(row[1]));
        for (let c = 2; c < head.length; c++) perWell.get(wellLabel(head[c]!))!.push(Number(row[c]));
      }
      cycles = seen;
      curves.set(amplification[1]!, perWell);
      continue;
    }
    if (name.includes("Quantification Cq Results")) {
      const rows = csvRows(data);
      const head = rows[0]!;
      for (const row of rows.slice(1)) {
        const rec = Object.fromEntries(row.map((v, i) => [head[i], v])) as Record<string, string>;
        cq.set(`${rec.Fluor}/${wellLabel(rec.Well!)}`, rec.Cq === "NaN" ? null : Number(rec.Cq));
      }
      continue;
    }
    const endPoint = /End Point Results_(.+)\.csv$/.exec(name);
    if (endPoint) {
      const rows = csvRows(data);
      const head = rows[0]!;
      for (const row of rows.slice(1)) {
        const rec = Object.fromEntries(row.map((v, i) => [head[i], v])) as Record<string, string>;
        endRfu.set(`${endPoint[1]}/${wellLabel(rec.Well!)}`, Number(rec["End RFU"]));
      }
    }
  }
  return { curves, cq, endRfu, cycles };
}

describe("CFX's own exported results", () => {
  const cfx = readExport();

  it("exports 45 cycles for three fluorophores", () => {
    expect(cfx.cycles).toHaveLength(45);
    expect([...cfx.curves.keys()].sort()).toEqual(["Cy5", "FAM", "Tex 615"]);
  });

  it("reproduces every reported Cq to 1e-9 cycles", () => {
    let withCq = 0;
    let withoutCq = 0;
    for (const [fluor, threshold] of Object.entries(CFX_THRESHOLD)) {
      for (const [well, values] of cfx.curves.get(fluor)!) {
        const expected = cfx.cq.get(`${fluor}/${well}`);
        expect(expected, `${fluor} ${well} missing from the Cq export`).not.toBeUndefined();
        const actual = computeCq(cfx.cycles, values, threshold);
        if (expected == null) {
          expect(actual, `${fluor} ${well} should have no Cq`).toBeNull();
          withoutCq++;
        } else {
          expect(actual, `${fluor} ${well}`).not.toBeNull();
          expect(Math.abs(actual! - expected), `${fluor} ${well}`).toBeLessThan(1e-9);
          withCq++;
        }
      }
    }
    // The whole population, so a rule that silently stopped reporting Cq values would fail here
    // rather than pass vacuously.
    expect(withCq).toBe(9);
    expect(withoutCq).toBe(5);
  });

  it("reproduces every reported end-point RFU", () => {
    let checked = 0;
    for (const fluor of Object.keys(CFX_THRESHOLD)) {
      for (const [well, values] of cfx.curves.get(fluor)!) {
        const expected = cfx.endRfu.get(`${fluor}/${well}`);
        if (expected === undefined) continue;
        // Relative, because these span −4 to 4772 RFU; 1e-12 is the CSV's own precision.
        expect(Math.abs(endPointRfu(values) - expected), `${fluor} ${well}`).toBeLessThan(
          1e-9 * Math.max(1, Math.abs(expected)),
        );
        checked++;
      }
    }
    expect(checked).toBe(14);
  });

  it("reports a Cq for a noise well that touches the threshold once, and none for a well that never crosses", () => {
    // Two wells worth naming, because they are what settles "should a quality gate suppress a Cq?"
    // — the reference has no such gate, in either direction (`threshold.md` §0.5).
    const tex = cfx.curves.get("Tex 615")!;
    const T = CFX_THRESHOLD["Tex 615"]!;

    // B4 is pure noise: exactly one cycle poke above the threshold, then 30 cycles of decline.
    const b4 = computeCq(cfx.cycles, tex.get("B4")!, T);
    expect(b4).toBeCloseTo(14.8211331477313, 9);
    expect(tex.get("B4")!.at(-1)).toBeLessThan(T);

    // E4 rises monotonically from 19.7 to 107 RFU and gets no Cq — its whole corrected curve sits
    // *above* the threshold, so there is nothing to cross from.
    expect(computeCq(cfx.cycles, tex.get("E4")!, T)).toBeNull();
    expect(Math.min(...tex.get("E4")!)).toBeGreaterThan(T);
  });
});
