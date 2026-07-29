import type { DyeResponseCurve, PlateDefinition } from "@zpcrweb/core";
import type { FluorCalibration } from "./fluorCurves";

/** Group label for a loaded well/fluor pair the plate assigns no target/gene to — a real group
 * in the Curves and Analysis views' target mode rather than a silent fall back to the fluor
 * name, so those curves stay visible, labelled and toggleable. Parenthesized so it can't
 * collide with a real `geneName`. */
export const NO_TARGET = "(none)";

/** Distinct target names on a plate, each carrying the channel of the fluor it's first seen
 * assigned to (for coloring) — same "first occurrence wins" approach as the Curves view's own
 * target legend. */
export function plateTargets(plate: PlateDefinition): { name: string; channel: number | null }[] {
  const channelByTarget = new Map<string, number>();
  for (const w of plate.wells) {
    for (const wf of w.fluors) {
      // Only a known channel colors a target; an unknown one leaves it neutral rather than
      // borrowing a hue (see `PlateFluor.channel`).
      if (wf.target && wf.channel !== undefined && !channelByTarget.has(wf.target)) {
        channelByTarget.set(wf.target, wf.channel);
      }
    }
  }
  return plate.targets.map((name) => ({ name, channel: channelByTarget.get(name) ?? null }));
}

/** One group of curves in the Curves/Analysis views' target mode: a target/gene, or the
 * {@link NO_TARGET} catch-all. */
export interface TargetGroup {
  target: string;
  /** Every fluorophore this target is loaded as, in plate order — the chip's sublabel. */
  fluors: string[];
  /** Optical channel for coloring, or nullish when the group spans several fluorophores and no
   * single channel hue would represent it, or when the channel isn't known (see `channelColor`). */
  channel?: number | null;
  /** Calibration curve of the first of `fluors` that has one — unset when none do, which shows
   * the group as present-but-uncalibrated. */
  curve?: DyeResponseCurve;
}

/**
 * Group a plate's (well, fluor) pairs by their target/gene, in first-seen plate order, with the
 * loaded pairs carrying no target of their own collected into one trailing {@link NO_TARGET}
 * group so they stay labelled and toggleable.
 *
 * That catch-all is only added alongside real targets: a plate with no `geneName` at all is
 * already de facto fluorophore mode, and lumping its dyes into one group would merge their
 * per-group Cq thresholds (`threshold.md` §5.2). Callers fall back to grouping by fluorophore in
 * that case — see `AnalysisView`'s `usingTargets`.
 */
export function targetGroups(
  plate: PlateDefinition,
  fluorCals: FluorCalibration[],
): TargetGroup[] {
  const byFluor = new Map(fluorCals.map((f) => [f.fluor, f]));
  const fluorsByTarget = new Map<string, string[]>();
  const untargeted: string[] = [];
  for (const w of plate.wells) {
    for (const wf of w.fluors) {
      if (!wf.target) {
        if (w.loaded && !untargeted.includes(wf.fluor)) untargeted.push(wf.fluor);
        continue;
      }
      const fluors = fluorsByTarget.get(wf.target) ?? [];
      if (!fluors.includes(wf.fluor)) fluors.push(wf.fluor);
      fluorsByTarget.set(wf.target, fluors);
    }
  }
  const group = (target: string, fluors: string[]): TargetGroup => {
    const cals = fluors.map((f) => byFluor.get(f));
    return {
      target,
      fluors,
      // A plate fluor with no `.Dcal` match still has a channel of its own (from the plate), so
      // a single-fluor group is colored even while uncalibrated — unless that channel is itself
      // unknown, which lands on the same neutral as a multi-fluor group.
      channel: fluors.length === 1 ? (cals[0]?.channel ?? null) : null,
      curve: cals.find((c) => c?.curve)?.curve,
    };
  };
  const groups = [...fluorsByTarget].map(([target, fluors]) => group(target, fluors));
  if (groups.length > 0 && untargeted.length > 0) groups.push(group(NO_TARGET, untargeted));
  return groups;
}
