import { channelColor } from "../../lib/channelColors";
import type { FluorCalibration } from "../../lib/fluorCurves";

interface Props {
  fluors: FluorCalibration[];
  /** Fluor names *not* shown; anything else calibrated is on. */
  disabled: Set<string>;
  onToggle: (fluor: string) => void;
}

/**
 * One chip per fluorophore present on the plate (not per channel) — colored by that fluor's
 * primary channel, so a channel's hue stays consistent between channel-space and dye-space
 * views. Multiple fluors sharing a channel simply share a color, distinguished by their label.
 * A fluor with no matching `.Dcal` calibration is still listed, dimmed and non-interactive, so
 * its absence from the plot is visible rather than silent.
 */
export function FluorBar({ fluors, disabled, onToggle }: Props) {
  return (
    <div className="chanbar">
      {fluors.map((f) => {
        const uncalibrated = !f.curve;
        const on = !uncalibrated && !disabled.has(f.fluor);
        return (
          <button
            key={f.fluor}
            className={"chanchip" + (on ? " is-on" : "") + (uncalibrated ? " is-disabled" : "")}
            onClick={() => !uncalibrated && onToggle(f.fluor)}
            disabled={uncalibrated}
            aria-pressed={on}
            title={uncalibrated ? `${f.fluor}: no calibration data for this tube type` : f.fluor}
            style={{ ["--chan" as string]: channelColor(f.channel) }}
          >
            <span className="chanchip__swatch" />
            <span className="chanchip__label">
              <span className="chanchip__ch mono">{f.fluor}</span>
              <span className="chanchip__dye">C{f.channel + 1}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
