import type { PlateDefinition } from "@zpcrweb/core";

/**
 * Drop a trailing `.pltd`/`.csv`/`.plt.csv` extension. Both a plate's `identityKey` and an
 * archive entry name are typically a source file name — a real `.pltd` stores its own file name
 * as its identity (`Qualification_Plate_96.pltd`), and a `.plt.csv`'s identity *is* its entry
 * name — so the extension has to come off before either is shown or used as a basename.
 */
export function stripPlateExt(s: string): string {
  return s.replace(/\.(pltd|plt\.csv|csv)$/i, "");
}

/**
 * The plate's user-facing name. This is `identityKey` — **never `plateName`**, which despite its
 * name is the vessel/plastic type (`BR Clear`, `BR White`; see pltd.md "Vessel type"), the same
 * for every plate run on the same consumable. Using it as a title makes two unrelated plates
 * both read as "BR Clear" while their real names go unshown, which is exactly what the Raw
 * files decoded view used to do.
 */
export function plateDisplayName(plate: PlateDefinition): string {
  return stripPlateExt(plate.identityKey ?? "") || "Plate";
}

/**
 * The `.plt.csv` file name a plate's own identity gives it — what "Clone experiment"
 * (`App.tsx`'s `cloneExperiment`) names the plate half of the archive it builds. Same sanitizing
 * `PlateDownloadButton`'s Clone button applies to its own filename, kept separate rather than
 * shared since that one also has `pltd`/`plateName` fallbacks this caller never has (a plate
 * pulled from an already-decoded `Zpcr` always carries an `identityKey`).
 */
export function plateCsvFileName(plate: PlateDefinition): string {
  const base = plateDisplayName(plate).replace(/[\\/:*?"<>|]+/g, "_").trim() || "plate";
  return `${base}.plt.csv`;
}
