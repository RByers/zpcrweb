import type { PlateDefinition } from "@zpcrweb/core";

/** Distinct target names on a plate, each carrying the channel of the fluor it's first seen
 * assigned to (for coloring) — same "first occurrence wins" approach as the Curves view's own
 * target legend. */
export function plateTargets(plate: PlateDefinition): { name: string; channel: number | null }[] {
  const channelByTarget = new Map<string, number>();
  for (const w of plate.wells) {
    for (const wf of w.fluors) {
      if (wf.target && !channelByTarget.has(wf.target)) channelByTarget.set(wf.target, wf.channel);
    }
  }
  return plate.targets.map((name) => ({ name, channel: channelByTarget.get(name) ?? null }));
}
