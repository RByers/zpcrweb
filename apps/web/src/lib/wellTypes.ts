import type { PlateDefinition, SampleType } from "@zpcrweb/core";
import { wellKey } from "../state/useZpcrStore";

/**
 * Per-well sample type (from the plate definition), for coloring a well-selection grid to match
 * the Plates view. A well not actually loaded shows as `"empty"` (grey) regardless of its
 * configured sample type — mirroring `PlateViewer`, which likewise gates its sample-type color
 * on `loaded` rather than `sampleType !== "empty"` (a well can be assigned a real sample type
 * like `"unknown"` in the plate design without ending up loaded with a fluor for this run).
 * Shared by `CurvesView`'s and `AnalysisView`'s well-selection `WellMatrix`, so both grids read
 * the same way. Returns `undefined` when there's no plate to color by.
 */
export function computeWellTypes(plate: PlateDefinition | undefined): Map<string, SampleType> | undefined {
  if (!plate) return undefined;
  const m = new Map<string, SampleType>();
  for (const w of plate.wells) m.set(wellKey(w.row, w.col), w.loaded ? w.sampleType : "empty");
  return m;
}
