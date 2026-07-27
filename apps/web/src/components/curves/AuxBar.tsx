import type { AuxCurve } from "../../lib/uplot/chart";

interface Props {
  /** Every series available on the right axis, in file order (see `rightAxis.ts`). */
  curves: AuxCurve[];
  /** Unit suffix for the value preview, e.g. `°C` / `DAC`. */
  unit: string;
  /** Decimal places for the value preview. */
  decimals: number;
  /** Keys currently plotted. */
  enabled: Set<string>;
  onToggle: (key: string) => void;
}

/** Latest non-null value of a series — what the chip previews. */
function lastValue(c: AuxCurve): number | null {
  for (let i = c.values.length - 1; i >= 0; i--) {
    const v = c.values[i];
    if (v != null) return v;
  }
  return null;
}

/**
 * Toggle chips for the right axis' series — temperatures or LED currents — mirroring the channel
 * chips. Chip color matches the plotted line; the sub-label shows the field's latest value, so
 * the rail doubles as a readout of the instrument's state at the last read even with nothing
 * plotted.
 */
export function AuxBar({ curves, unit, decimals, enabled, onToggle }: Props) {
  return (
    <div className="chanbar">
      {curves.map((c) => {
        const on = enabled.has(c.key);
        const value = lastValue(c);
        return (
          <button
            key={c.key}
            className={"chanchip" + (on ? " is-on" : "")}
            onClick={() => onToggle(c.key)}
            aria-pressed={on}
            title={c.setpoint ? `${c.key} — configured set point, not a measurement` : c.key}
            style={{ ["--chan" as string]: c.color }}
          >
            <span className="chanchip__swatch" />
            <span className="chanchip__label">
              <span className="chanchip__ch">{c.label}</span>
              <span className="chanchip__dye mono">
                {value == null ? "—" : `${value.toFixed(decimals)} ${unit}`}
                {c.setpoint && " set"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
