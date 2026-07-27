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
