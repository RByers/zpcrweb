import type { TemperatureCurve } from "@zpcrweb/core";
import { tempColor } from "../../lib/tempColors";

interface Props {
  /** Every temperature the run's platereads carry, in file order. */
  temps: TemperatureCurve[];
  /** Field keys currently plotted. */
  enabled: Set<string>;
  onToggle: (key: string) => void;
}

/** Latest non-null value of a series — what the chip previews. */
function lastValue(t: TemperatureCurve): number | null {
  for (let i = t.celsius.length - 1; i >= 0; i--) {
    const v = t.celsius[i];
    if (v != null) return v;
  }
  return null;
}

/**
 * Toggle chips for the temperature series, mirroring the channel chips. Chip color matches
 * the plotted line; the sub-label shows the field's latest value so the rail doubles as a
 * readout of the instrument's state at the last read.
 */
export function TempBar({ temps, enabled, onToggle }: Props) {
  return (
    <div className="chanbar">
      {temps.map((t, i) => {
        const on = enabled.has(t.key);
        const value = lastValue(t);
        return (
          <button
            key={t.key}
            className={"chanchip" + (on ? " is-on" : "")}
            onClick={() => onToggle(t.key)}
            aria-pressed={on}
            title={
              t.kind === "setpoint"
                ? `${t.key} — configured set point, not a measurement`
                : t.key
            }
            style={{ ["--chan" as string]: tempColor(i, t.kind) }}
          >
            <span className="chanchip__swatch" />
            <span className="chanchip__label">
              <span className="chanchip__ch">{t.label}</span>
              <span className="chanchip__dye mono">
                {value == null ? "—" : `${value.toFixed(1)}°`}
                {t.kind === "setpoint" && " set"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
