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

/**
 * How to name the plastic a run sat in, in a sentence. One vessel reads as itself
 * (`"BR Clear"`); a plate that mixes them — which only a `.plt.csv` can describe, per well —
 * lists them (`"BR White / BR Clear"`), because "for BR Clear" would be a half-truth about which
 * calibration a warning is really talking about.
 */
export function vesselLabel(tubes: readonly string[]): string {
  return tubes.length > 1 ? tubes.join(" / ") : (tubes[0] ?? "");
}

/**
 * The vessel a plate states, for display: its own `plateName`, or — when it states one per well
 * instead — the distinct values its wells carry. Empty when the plate says nothing at all.
 */
export function plateVesselLabel(plate: PlateDefinition): string {
  if (plate.plateName) return plate.plateName;
  const seen: string[] = [];
  for (const w of plate.wells) if (w.vessel && !seen.includes(w.vessel)) seen.push(w.vessel);
  return vesselLabel(seen);
}
