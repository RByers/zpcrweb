/**
 * What a file's *name* says it is — the only question a directory listing can ask about a file
 * nobody has opened, and what the Files view's type chips count (`FolderSection.tsx`).
 *
 * The rules worth pinning are the ones a naive `endsWith` chain gets wrong: `.plt.csv` is a
 * plate table and must not be claimed by anything else, `.prcl.txt` is this project's text form
 * and not Bio-Rad's binary `.prcl` (the two protocol encodings, one category), and a name that
 * isn't offerable at all answers null rather than guessing.
 */
import { describe, it, expect } from "vitest";
import {
  fileCategory,
  fileKindFromName,
  matchesSupportedExtension,
  SUPPORTED_EXTENSIONS,
} from "../src/fileKind.js";

describe("fileKindFromName", () => {
  it("names the kind each supported extension is decoded as", () => {
    expect(fileKindFromName("20260720_FirstQualification.zpcr")).toBe("zpcr");
    expect(fileKindFromName("20260720_Luna_noRT.pcrd")).toBe("pcrd");
    expect(fileKindFromName("biomeme-2024-01-17.bmrun")).toBe("biomeme");
    expect(fileKindFromName("QuickPlate_96 wells_All Channels.pltd")).toBe("pltd");
    expect(fileKindFromName("S183-S185-RVP.plt.csv")).toBe("platecsv");
    expect(fileKindFromName("Qualification_Plate_96.prcl")).toBe("prcl");
    expect(fileKindFromName("Gradient.prcl.txt")).toBe("prcltxt");
    expect(fileKindFromName("20260807_231326_CT019138_AGBLK1.alf")).toBe("alf");
  });

  it("is case-insensitive, as a file system's own names are", () => {
    expect(fileKindFromName("RUN.ZPCR")).toBe("zpcr");
    expect(fileKindFromName("Plate.PltD")).toBe("pltd");
    expect(fileKindFromName("Cycling.PRCL")).toBe("prcl");
  });

  // The pair a suffix chain is most likely to confuse, since one name ends in the other's stem.
  // They are different encodings of the same thing — Bio-Rad's encrypted container and this
  // project's plain text — so getting it wrong picks the wrong decoder, not merely the wrong label.
  it("keeps the two protocol encodings apart, however the list is ordered", () => {
    expect(fileKindFromName("Cycling.prcl")).toBe("prcl");
    expect(fileKindFromName("Cycling.prcl.txt")).toBe("prcltxt");
    expect(fileKindFromName("Cycling.txt")).toBe("prcltxt");
  });

  it("answers null for a name the app has no decoder for", () => {
    expect(fileKindFromName("notes.md")).toBeNull();
    expect(fileKindFromName("RunInfo.xml")).toBeNull();
    expect(fileKindFromName("archive.zip")).toBeNull();
    expect(fileKindFromName("noextension")).toBeNull();
  });

  it("agrees with the name filter: every offerable name has a kind, and vice versa", () => {
    for (const ext of SUPPORTED_EXTENSIONS) {
      const name = `sample${ext}`;
      expect(matchesSupportedExtension(name)).toBe(true);
      expect(fileKindFromName(name)).not.toBeNull();
    }
    expect(matchesSupportedExtension("notes.md")).toBe(false);
  });

  // The categories the Files view keys "where does opening this land" on (`App.tsx`'s
  // `defaultViewFor`) — a report is deliberately not a run, since it holds no fluorescence.
  it("puts each kind in the category its default view is chosen from", () => {
    expect(fileCategory(fileKindFromName("a.zpcr")!)).toBe("run");
    expect(fileCategory(fileKindFromName("a.pcrd")!)).toBe("run");
    expect(fileCategory(fileKindFromName("a.bmrun")!)).toBe("run");
    expect(fileCategory(fileKindFromName("a.pltd")!)).toBe("plate");
    expect(fileCategory(fileKindFromName("a.plt.csv")!)).toBe("plate");
    expect(fileCategory(fileKindFromName("a.prcl")!)).toBe("protocol");
    expect(fileCategory(fileKindFromName("a.prcl.txt")!)).toBe("protocol");
    expect(fileCategory(fileKindFromName("a.alf")!)).toBe("report");
  });
});
