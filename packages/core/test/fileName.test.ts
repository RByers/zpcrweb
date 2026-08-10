import { describe, it, expect } from "vitest";
import { safeFileBase } from "../src/fileName.js";

describe("safeFileBase", () => {
  it("keeps letters, digits, underscore and dash unchanged", () => {
    expect(safeFileBase("S183-S185_RVP_v2")).toBe("S183-S185_RVP_v2");
  });

  it("replaces everything else, including what a deny-list would have let through", () => {
    expect(safeFileBase("RVP #2 & 50% (fast)")).toBe("RVP_2_50_fast");
    expect(safeFileBase("plate;drop table,runs")).toBe("plate_drop_table_runs");
    expect(safeFileBase("a`b$c^d~e{f}g")).toBe("a_b_c_d_e_f_g");
    expect(safeFileBase("C:\\runs\\*?.txt")).toBe("C_runs_txt");
  });

  it("turns a dot into an underscore, so no name grows a false extension", () => {
    expect(safeFileBase("S183-S185 RVP v2.1")).toBe("S183-S185_RVP_v2_1");
  });

  it("folds accents to their base letter rather than dropping them", () => {
    expect(safeFileBase("Réplica año 2")).toBe("Replica_ano_2");
  });

  it("collapses runs of replacements and trims them from the ends", () => {
    expect(safeFileBase('  RVP "fast"  ')).toBe("RVP_fast");
    expect(safeFileBase("__x__")).toBe("x");
  });

  it("answers nothing with '' — the caller supplies its own fallback", () => {
    expect(safeFileBase("")).toBe("");
    expect(safeFileBase("   ")).toBe("");
    expect(safeFileBase("!!!")).toBe("");
    expect(safeFileBase("日本語")).toBe("");
  });

  it("is idempotent — sanitizing an already-safe name changes nothing", () => {
    for (const s of ["RVP #2 & 50% (fast)", "S183-S185 RVP v2.1", "Réplica año 2"]) {
      expect(safeFileBase(safeFileBase(s))).toBe(safeFileBase(s));
    }
  });
});
