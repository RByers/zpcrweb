import type { SampleType } from "@zpcrweb/core";
import { SAMPLE_TYPE_META } from "../../lib/sampleType";

/** One sample type present on the plate, with every well carrying it. */
export interface WellTypeGroup {
  type: SampleType;
  /** Well keys (`wellKey(row, col)`) — what a toggle turns on or off. */
  keys: string[];
  /** The same wells' display labels — what a hover highlight speaks in (see
   * {@link import("./WellMatrix").WellMatrix}'s `onHoverWells`). */
  labels: string[];
}

interface Props {
  groups: WellTypeGroup[];
  /** Currently enabled well keys — a group reads as on only when every one of its wells is. */
  enabled: Set<string>;
  /** Clicking a group: all its wells off if they were all on, otherwise all on. */
  onToggle: (g: WellTypeGroup) => void;
  /** Double-clicking a group — isolates it: only its wells stay enabled. */
  onSolo?: (g: WellTypeGroup) => void;
  /** Hovering a group (`null` on leave) — peeks at its wells in the grid and dims every other
   * curve in the chart, the same as hovering a row/column header. */
  onHover?: (g: WellTypeGroup | null) => void;
}

/**
 * Per-sample-type quick selectors for the Curves rail's well grid: one small chip per sample
 * type the plate actually uses, turning every well of that type on or off at once. "All the NTC
 * wells" is a selection people reach for constantly and the grid alone can only express it well
 * by well, since sample type doesn't follow rows or columns.
 *
 * The chip is deliberately not a {@link import("./ChipBar").ChipBar} chip: those are a plotting
 * dimension of their own (a channel, a target, a sample) with their own enabled set, while these
 * are a *shortcut into* the well selection the grid below owns — nothing is "a type being
 * plotted". So a chip here shows the state of the wells it covers — on, off, or mixed — rather
 * than a state of its own, and it sits in the section's heading row beside the grid's reset
 * button rather than forming a bar of its own.
 *
 * Colors and short codes come from `SAMPLE_TYPE_META`, so a chip matches the cells it selects
 * (and the Plates view) without a legend.
 */
export function WellTypeBar({ groups, enabled, onToggle, onSolo, onHover }: Props) {
  if (groups.length === 0) return null;
  return (
    <div className="welltypes">
      {groups.map((g) => {
        const meta = SAMPLE_TYPE_META[g.type];
        const on = g.keys.filter((k) => enabled.has(k)).length;
        const all = on === g.keys.length;
        const some = on > 0 && !all;
        return (
          <button
            key={g.type}
            className={"welltype" + (all ? " is-on" : "") + (some ? " is-some" : "")}
            style={{ ["--wt" as string]: meta.color }}
            onClick={() => onToggle(g)}
            onDoubleClick={() => onSolo?.(g)}
            onMouseEnter={() => onHover?.(g)}
            onMouseLeave={() => onHover?.(null)}
            aria-pressed={all}
            title={`${meta.label} — ${g.keys.length} well${g.keys.length === 1 ? "" : "s"} (${on} on). Click to toggle, double-click to isolate.`}
          >
            {meta.short}
          </button>
        );
      })}
    </div>
  );
}
