import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  deriveExperimentName,
  nextFreeRunFileBase,
  parseBiomeme,
  parseZpcr,
  parseZpcrwebSettingsJson,
  resolveExperimentName,
  runFileBaseName,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
function readSample(name: string): Uint8Array {
  const buf = readFileSync(resolve(here, "../../../samples", name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

describe("deriveExperimentName", () => {
  it("drops the instrument's date/time/serial prefix and reads _ as a space", () => {
    expect(deriveExperimentName("20260726_S183-S185_RVP.zpcr")).toBe("S183-S185 RVP");
    expect(deriveExperimentName("20260720_211747_CT019138_Luna_noRT.pcrd", { serial: "CT019138" })).toBe(
      "Luna noRT",
    );
    expect(
      deriveExperimentName("20190516_122922_CT019138_SHORT_QUALIF.zpcr", { serial: "CT019138" }),
    ).toBe("SHORT QUALIF");
  });

  it("only drops a serial segment that is this run's serial", () => {
    // Without the run to compare against, a name that happens to look like a serial is a name.
    expect(deriveExperimentName("20260726_CT019138_RVP.zpcr")).toBe("CT019138 RVP");
    expect(deriveExperimentName("20260726_CT019138_RVP.zpcr", { serial: "ct019138" })).toBe("RVP");
  });

  it("strips the compound extensions this project uses", () => {
    expect(deriveExperimentName("S183-S185-RVP.plt.csv")).toBe("S183-S185-RVP");
    expect(deriveExperimentName("Luna noRT.prcl.txt")).toBe("Luna noRT");
    expect(deriveExperimentName("/some/dir/20260726_RVP.zpcr")).toBe("RVP");
  });

  it("keeps the whole base name rather than returning nothing", () => {
    expect(deriveExperimentName("20260726.zpcr")).toBe("20260726");
    expect(deriveExperimentName("20260726_211747.zpcr")).toBe("20260726_211747");
    expect(deriveExperimentName("")).toBe("");
  });

  it("reads back the dash-joined date this project writes", () => {
    expect(deriveExperimentName("20260802-S183-S185_RVP.zpcr")).toBe("S183-S185 RVP");
  });
});

describe("runFileBaseName", () => {
  const aug2 = new Date(2026, 7, 2, 9, 30);

  it("dates the name and writes spaces as underscores", () => {
    expect(runFileBaseName("S183-S185 RVP", aug2)).toBe("20260802-S183-S185_RVP");
    expect(runFileBaseName("  Luna   noRT  ", aug2)).toBe("20260802-Luna_noRT");
  });

  it("round-trips through deriveExperimentName", () => {
    expect(deriveExperimentName(`${runFileBaseName("Luna noRT", aug2)}.zpcr`)).toBe("Luna noRT");
  });

  it("replaces what a filename or a RemoteRun operand can't carry, and answers nothing with ''", () => {
    expect(runFileBaseName('RVP "fast"/v2', aug2)).toBe("20260802-RVP_fast_v2");
    expect(runFileBaseName("   ")).toBe("");
  });

  it("keeps only A-Za-z0-9_- , whatever the name was", () => {
    expect(runFileBaseName("RVP #2 & 50%", aug2)).toBe("20260802-RVP_2_50");
    expect(runFileBaseName("Réplica v2.1", aug2)).toBe("20260802-Replica_v2_1");
    expect(runFileBaseName("日本語", aug2)).toBe("");
  });
});

describe("nextFreeRunFileBase", () => {
  const held = (...names: string[]) => (candidate: string) => names.includes(candidate);

  it("leaves a free name alone", () => {
    expect(nextFreeRunFileBase("20260802-RVP", held("20260801-RVP"))).toBe("20260802-RVP");
  });

  it("suffixes a taken name, and counts past every one already taken", () => {
    expect(nextFreeRunFileBase("20260802-RVP", held("20260802-RVP"))).toBe("20260802-RVP-2");
    expect(nextFreeRunFileBase("20260802-RVP", held("20260802-RVP", "20260802-RVP-2"))).toBe(
      "20260802-RVP-3",
    );
  });

  it("increments an existing counter rather than nesting one", () => {
    expect(nextFreeRunFileBase("20260802-RVP-2", held("20260802-RVP-2"))).toBe("20260802-RVP-3");
    // The dashes a run name is full of are not counters: only a trailing `-<digits>` is.
    expect(nextFreeRunFileBase("20260802-S183-S185_RVP", held("20260802-S183-S185_RVP"))).toBe(
      "20260802-S183-S185_RVP-2",
    );
  });
});

describe("resolveExperimentName", () => {
  const metadata = { experimentName: "", baseSerialNumber: "CT019138" };

  it("prefers a stored name, then the format's own, then the filename", () => {
    expect(
      resolveExperimentName({ stored: "  Typed name ", metadata, fileName: "20260726_RVP.zpcr" }),
    ).toBe("Typed name");
    expect(
      resolveExperimentName({
        stored: "   ",
        metadata: { ...metadata, experimentName: "2024-01-17-22220147" },
        fileName: "20260726_RVP.zpcr",
      }),
    ).toBe("2024-01-17-22220147");
    expect(resolveExperimentName({ metadata, fileName: "20260726_CT019138_RVP.zpcr" })).toBe("RVP");
  });

  it("works with nothing but a filename", () => {
    expect(resolveExperimentName({ fileName: "20260726_S183-S185_RVP.zpcr" })).toBe("S183-S185 RVP");
  });
});

describe("experiment identity of the sample runs", () => {
  it("a .zpcr states no name of its own, and is named from its filename", () => {
    const zpcr = parseZpcr(readSample("20260726_S183-S185_RVP.zpcr"));
    expect(zpcr.metadata.experimentName).toBe("");
    expect(
      resolveExperimentName({
        stored: parseZpcrwebSettingsJson("{}")?.experimentName,
        metadata: zpcr.metadata,
        fileName: "20260726_S183-S185_RVP.zpcr",
      }),
    ).toBe("S183-S185 RVP");
    // The date the app shows comes from RunInfo.xml's RunStartTime.
    expect(zpcr.metadata.runStartDate?.toISOString()).toBe("2026-07-27T01:12:47.000Z");
  });

  it("a Biomeme export names its own run", () => {
    const run = parseBiomeme(readSample("biomeme-2024-01-17.bmrun"));
    expect(run.metadata.experimentName).toBe("2024-01-17-22220147");
    expect(
      resolveExperimentName({ metadata: run.metadata, fileName: "biomeme-2024-01-17.bmrun" }),
    ).toBe("2024-01-17-22220147");
  });
});
